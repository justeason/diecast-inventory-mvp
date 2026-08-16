// 15K: DB boundary + orchestration for controlled auto-listing. No scheduler — every
// run is triggered by an explicit admin action (actions/autoListing.ts). Candidate
// discovery reuses 15J's searchReadyToListPage verbatim (Part I) — there is no second
// candidate definition. Risk is evaluated via the PURE evaluateRiskPolicy +
// getEffectiveRiskPolicy directly, NEVER checkRiskGate/consumeApprovedRiskGate/
// markApprovalConsumed — those exist specifically to create/consume
// RiskApprovalRequest rows, which automation must never do (Part T). A new Listing
// is only ever created via listingActivation.ts's createListingAtomic — the one
// authoritative boundary shared with the interactive path (Part G).
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { searchReadyToListPage, getItemReadyToListStatus } from '@/lib/readyToListQuery'
import type { ItemSearchFilter } from '@/lib/itemLifecycleQuery'
import type { ReadyToListOutcome } from '@/lib/readyToList'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import { getEffectiveRiskPolicy } from '@/lib/riskPolicyQuery'
import { evaluateRiskPolicy, type RiskDecision } from '@/lib/riskPolicy'
import { getEffectiveAutoListingPolicy, type AutoListingPolicyRow } from '@/lib/autoListingPolicyQuery'
import { evaluateAutoListCandidate, type AutoListPricingInput, type AutoListIneligibleReasonCode } from '@/lib/autoListing'
import { buildListingActivationContext, createListingAtomic } from '@/lib/listingActivation'

export const AUTO_LIST_BATCH_SIZE = 25
// Run-level wall-clock budget (Part J section 24) — distinct from 15J's own internal
// candidate-scan budget. Each candidate here costs several sequential queries plus a
// transaction, so 25 items can take meaningfully longer than the 15J preview scan
// alone. On expiry, the run stops and returns an explicit resumable cursor — never a
// false "complete".
export const AUTO_LIST_RUN_TIME_BUDGET_MS = 20_000

const EMPTY_ITEM_FILTER: ItemSearchFilter = { q: '', status: '', condition: '', cardedOrLoose: '', sort: 'sku' }

export type AutoListAttemptOutcome = 'listed' | 'review_required' | 'denied' | 'already_listed' | 'stale' | 'failed'
export type AutoListReasonCode =
  | AutoListIneligibleReasonCode
  | 'auto_listed'
  | 'readiness_changed'
  | 'risk_approval_required'
  | 'risk_denied'
  | 'already_listed'
  | 'concurrent_state_change'
  | 'serialization_conflict'
  | 'execution_failed'

function snapshotReadiness(outcome: ReadyToListOutcome | null): Prisma.InputJsonValue {
  if (!outcome) return { status: 'unknown' }
  return {
    status: outcome.status,
    listingPath: outcome.listingPath,
    blockers: outcome.blockers.map((b) => b.code),
    reviewReasons: outcome.reviewReasons.map((r) => r.code),
  }
}

function snapshotPricing(p: AutoListPricingInput): Prisma.InputJsonValue {
  if (!p) return { available: false }
  return { isAskOnly: p.isAskOnly, confidenceLevel: p.confidenceLevel, recommendedLowCents: p.recommendedLowCents, recommendedHighCents: p.recommendedHighCents }
}

function snapshotRisk(decision: RiskDecision): Prisma.InputJsonValue {
  if (decision.outcome === 'allow') return { outcome: 'allow', reasons: decision.reasons }
  if (decision.outcome === 'require_approval') return { outcome: 'require_approval', riskLevel: decision.riskLevel, policyCode: decision.policyCode, reasons: decision.reasons }
  return { outcome: 'deny', policyCode: decision.policyCode, reasons: decision.reasons }
}

// Shared shape-builder for tx.autoListingAttempt.create's `data` — used by every
// branch inside the transaction in processAutoListCandidate below, so the JSON-null
// normalization (Prisma.JsonNull for a genuinely absent snapshot) can never drift
// between branches.
function buildAttemptData(
  runId: string, itemId: string, outcome: AutoListAttemptOutcome, reasonCode: AutoListReasonCode,
  readinessSnapshot: Prisma.InputJsonValue, pricingSnapshot: Prisma.InputJsonValue | null,
  proposedPriceCents: number | null, riskSnapshot: Prisma.InputJsonValue | null, listingId: string | null,
) {
  return {
    runId, itemId, outcome, reasonCode, readinessSnapshot,
    pricingSnapshot: pricingSnapshot ?? Prisma.JsonNull,
    proposedPriceCents,
    riskSnapshot: riskSnapshot ?? Prisma.JsonNull,
    listingId,
  }
}

// Idempotent insert (Part S section 42) — a duplicate (runId, itemId) from a retried
// call is treated as "already recorded", never a new failure.
async function recordAttempt(params: {
  runId: string; itemId: string; outcome: AutoListAttemptOutcome; reasonCode: AutoListReasonCode
  readinessSnapshot: Prisma.InputJsonValue; pricingSnapshot: Prisma.InputJsonValue | null
  proposedPriceCents: number | null; riskSnapshot: Prisma.InputJsonValue | null; listingId: string | null
}): Promise<void> {
  try {
    await prisma.autoListingAttempt.create({
      data: buildAttemptData(
        params.runId, params.itemId, params.outcome, params.reasonCode,
        params.readinessSnapshot, params.pricingSnapshot, params.proposedPriceCents, params.riskSnapshot, params.listingId,
      ),
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return
    throw e
  }
}

const EXECUTION_ITEM_SELECT = {
  id: true, status: true, catalogId: true,
  listing: { select: { id: true } },
  sellerAgreement: { select: { type: true, agreedBuyoutAmount: true, acceptedItemCount: true } },
  catalog: { select: { brand: true, name: true, year: true } },
} as const

// Part K — per-item revalidation. Preview state is NEVER trusted.
//
// 15K (execution-snapshot pass): the ORIGINAL implementation fetched 14C pricing via
// the plain global `prisma` client, then — after further sequential work (policy
// eligibility, 15F evaluation) — opened a SEPARATE later transaction just to create
// the Listing. That left a real gap: completed sales, external sold observations, or
// active asks could change in between, so the Listing could be created from pricing
// evidence that was no longer current, even though nothing in the code detected it.
// An ItemInstance row lock does NOT lock the OrderItem/ExternalMarketObservation/
// Listing rows 14C reads.
//
// Fixed by moving readiness-critical re-verification, 14C pricing, 15K eligibility,
// 15F evaluation, Listing creation, and the AutoListingAttempt write ALL inside ONE
// SERIALIZABLE transaction, using that transaction's client (`tx`) for the 14C reads
// (via getPricingIntelligence's now-transaction-aware `client` param — see
// pricingIntelligenceQuery.ts). Under SERIALIZABLE, Postgres itself detects if a
// concurrent transaction wrote to any row this transaction read (pricing evidence
// included) in a way that would break serializability, and aborts this transaction
// with a serialization-failure error (Prisma P2034) rather than letting it commit —
// so a Listing can never be created from evidence that was concurrently invalidated.
// We do NOT blindly retry on that error (Part 1) — it is reported as `stale` and the
// item is simply picked up again by the next run's fresh 15J/14C read.
async function processAutoListCandidate(
  runId: string, itemId: string, policy: AutoListingPolicyRow, asOf: Date,
): Promise<AutoListAttemptOutcome> {
  // Cheap PRE-check outside the transaction — 15J's full readiness policy
  // (contradictions, agreement/storage/return-case state) is not itself "pricing
  // evidence" (Part 1's concern is specifically 14C data), and re-deriving it inside
  // a SERIALIZABLE transaction would mean re-reading several more tables per item
  // under the stricter isolation level for no corresponding benefit. This filters
  // out obviously-stale candidates before paying for a transaction; it is NEVER
  // authoritative by itself — the transaction below independently re-verifies the
  // two facts that actually gate Listing creation (available status, no listing).
  const preReadiness = await getItemReadyToListStatus(itemId)
  const readinessSnapshot = snapshotReadiness(preReadiness)
  if (!preReadiness || preReadiness.status !== 'ready') {
    await recordAttempt({ runId, itemId, outcome: 'stale', reasonCode: 'readiness_changed', readinessSnapshot, pricingSnapshot: null, proposedPriceCents: null, riskSnapshot: null, listingId: null })
    return 'stale'
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // 1. Row lock + authoritative re-verification of the facts most relevant to
      // this exact mutation (Part L concurrency).
      await tx.$queryRaw`SELECT id FROM "ItemInstance" WHERE id = ${itemId} FOR UPDATE`
      const item = await tx.itemInstance.findUnique({ where: { id: itemId }, select: EXECUTION_ITEM_SELECT })

      if (!item) {
        await tx.autoListingAttempt.create({ data: buildAttemptData(runId, itemId, 'failed', 'concurrent_state_change', readinessSnapshot, null, null, null, null) })
        return 'failed' as const
      }
      if (item.listing) {
        await tx.autoListingAttempt.create({ data: buildAttemptData(runId, itemId, 'already_listed', 'already_listed', readinessSnapshot, null, null, null, item.listing.id) })
        return 'already_listed' as const
      }
      if (item.status !== 'available') {
        await tx.autoListingAttempt.create({ data: buildAttemptData(runId, itemId, 'stale', 'concurrent_state_change', readinessSnapshot, null, null, null, null) })
        return 'stale' as const
      }

      // 2. Transaction-aware 14C pricing (Part 1 fix) — the SAME transaction, so
      // there is no gap between reading evidence and creating the Listing below.
      const intel = await getPricingIntelligence(item.catalogId, asOf, tx)
      const pricingInput: AutoListPricingInput = intel
        ? { isAskOnly: intel.isAskOnly, confidenceLevel: intel.confidence.level, recommendedLowCents: intel.recommendedListing.lowCents, recommendedHighCents: intel.recommendedListing.highCents }
        : null
      const pricingSnapshot = snapshotPricing(pricingInput)

      // 3. Auto-list-specific eligibility (Part C).
      const candidate = evaluateAutoListCandidate({ policy, listingPath: preReadiness.listingPath, pricing: pricingInput, catalog: item.catalog })
      if (!candidate.eligible) {
        await tx.autoListingAttempt.create({ data: buildAttemptData(runId, itemId, 'review_required', candidate.reasonCode, readinessSnapshot, pricingSnapshot, null, null, null) })
        return 'review_required' as const
      }

      // 4. Server-rebuilt 15F risk context, using the SAME intel as the price above
      // (never a client-supplied decision/confidence/range — Part T section 61).
      // PURE evaluation only — checkRiskGate is deliberately never called here,
      // since it would create/consume a RiskApprovalRequest row.
      const riskContext = buildListingActivationContext(itemId, item.catalogId, candidate.proposedPriceCents, intel?.estimatedValueCents ?? null, item.sellerAgreement)
      const riskPolicy = await getEffectiveRiskPolicy(asOf)
      if (!riskPolicy) throw new Error('No effective risk policy is configured — the 15F migration seed should always provide one.')
      const decision = evaluateRiskPolicy({ action: 'listing_activation', context: riskContext, policy: riskPolicy, asOf })
      const riskSnapshot = snapshotRisk(decision)

      if (decision.outcome === 'deny') {
        await tx.autoListingAttempt.create({ data: buildAttemptData(runId, itemId, 'denied', 'risk_denied', readinessSnapshot, pricingSnapshot, candidate.proposedPriceCents, riskSnapshot, null) })
        return 'denied' as const
      }
      if (decision.outcome === 'require_approval') {
        // Part G section 16 / Part T: automation stops here. No RiskApprovalRequest
        // is created — the admin can still list manually, which may create the
        // appropriate approval through the existing interactive path.
        await tx.autoListingAttempt.create({ data: buildAttemptData(runId, itemId, 'review_required', 'risk_approval_required', readinessSnapshot, pricingSnapshot, candidate.proposedPriceCents, riskSnapshot, null) })
        return 'review_required' as const
      }

      // 5. Execute — same transaction, same snapshot. The row lock plus
      // Listing.itemId's unique constraint are the PRIMARY concurrency guarantee;
      // createListingAtomic's own P2002 catch is only a defensive backstop.
      const created = await createListingAtomic(tx, { itemId, catalogId: item.catalogId, title: candidate.title, price: candidate.proposedPriceCents / 100, description: null })
      const outcome = created.ok ? 'listed' as const : 'already_listed' as const
      const reasonCode = created.ok ? 'auto_listed' as const : 'already_listed' as const
      await tx.autoListingAttempt.create({
        data: buildAttemptData(runId, itemId, outcome, reasonCode, readinessSnapshot, pricingSnapshot, candidate.proposedPriceCents, riskSnapshot, created.ok ? created.id : null),
      })
      return outcome
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
      // Postgres detected a serialization conflict — some row this transaction read
      // (pricing evidence, most likely) was concurrently written by another
      // transaction. Per Part 1: never blindly retry into a listing. Report `stale`
      // and let the next run pick the item up with a fresh read.
      await recordAttempt({ runId, itemId, outcome: 'stale', reasonCode: 'serialization_conflict', readinessSnapshot, pricingSnapshot: null, proposedPriceCents: null, riskSnapshot: null, listingId: null }).catch(() => {})
      return 'stale'
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'already_listed'
    await recordAttempt({ runId, itemId, outcome: 'failed', reasonCode: 'execution_failed', readinessSnapshot, pricingSnapshot: null, proposedPriceCents: null, riskSnapshot: null, listingId: null }).catch(() => {})
    return 'failed'
  }
}

export type AutoListingRunResult = {
  runId: string
  processed: number
  listed: number
  reviewRequired: number
  denied: number
  alreadyListed: number
  stale: number
  failed: number
  nextCursor: string | null
  sourceExhausted: boolean
}

// Part H/19 — the ONLY way a Listing can be created automatically: an authenticated
// admin explicitly invokes this (via actions/autoListing.ts). No scheduler, no cron,
// no call from candidate discovery/preview/page load/policy publish/readiness change.
export async function runAutoListingBatch(requestedBy: string, cursor: string | null = null): Promise<AutoListingRunResult> {
  const asOf = new Date()
  const policy = await getEffectiveAutoListingPolicy(asOf)
  if (!policy || !policy.enabled) {
    throw new Error('Auto-listing is not enabled. Publish an enabled policy version first.')
  }

  // Part I/20 — the exact same bounded 15J candidate query the Items list
  // readiness=ready tab uses. No second candidate definition.
  const page = await searchReadyToListPage('ready', EMPTY_ITEM_FILTER, cursor, AUTO_LIST_BATCH_SIZE)

  const run = await prisma.autoListingRun.create({
    data: { policyId: policy.id, policyVersion: policy.version, requestedBy, startCursor: cursor },
  })

  // Part P/38 — every attempt in THIS run uses the policy snapshot resolved above,
  // regardless of any later publish.
  const counts = { listed: 0, reviewRequired: 0, denied: 0, alreadyListed: 0, stale: 0, failed: 0 }
  const deadline = Date.now() + AUTO_LIST_RUN_TIME_BUDGET_MS
  let lastProcessedId: string | null = cursor
  let processed = 0
  let fullyProcessedPage = true

  for (const candidate of page.items) {
    if (Date.now() >= deadline) { fullyProcessedPage = false; break }
    const outcome = await processAutoListCandidate(run.id, candidate.id, policy, asOf)
    if (outcome === 'listed') counts.listed++
    else if (outcome === 'review_required') counts.reviewRequired++
    else if (outcome === 'denied') counts.denied++
    else if (outcome === 'already_listed') counts.alreadyListed++
    else if (outcome === 'stale') counts.stale++
    else counts.failed++
    lastProcessedId = candidate.id
    processed++
  }

  // Part J/23-24: if the run's own time budget cut the page short, resume from the
  // last FULLY PROCESSED candidate's id (not 15J's page-level nextCursor, which
  // reflects progress through the WHOLE returned page). Only when every returned
  // candidate was processed is 15J's own nextCursor — which correctly accounts for
  // its internal scan continuing past the returned matches — used verbatim.
  const nextCursor = fullyProcessedPage ? page.nextCursor : lastProcessedId
  const sourceExhausted = fullyProcessedPage && page.nextCursor === null

  await prisma.autoListingRun.update({ where: { id: run.id }, data: { completedAt: new Date(), nextCursor, sourceExhausted } })

  return { runId: run.id, processed, ...counts, nextCursor, sourceExhausted }
}

// ── Preview (Part H/18) — read-only, no run created, no mutation of any kind. ────
export type AutoListPreviewRow = { id: string; sku: string; brand: string; name: string }

export async function previewAutoListingCandidates(cursor: string | null = null, pageSize: number = AUTO_LIST_BATCH_SIZE): Promise<{ items: AutoListPreviewRow[]; nextCursor: string | null }> {
  const page = await searchReadyToListPage('ready', EMPTY_ITEM_FILTER, cursor, pageSize)
  return { items: page.items.map((r) => ({ id: r.id, sku: r.sku, brand: r.brand, name: r.name })), nextCursor: page.nextCursor }
}

// ── Recent runs (Part O/38, bounded) ──────────────────────────────────────────────
export type RecentRunRow = {
  id: string; policyVersion: number; requestedBy: string
  startedAt: Date; completedAt: Date | null; sourceExhausted: boolean; nextCursor: string | null
  counts: Partial<Record<AutoListAttemptOutcome, number>>
}

export async function listRecentAutoListingRuns(limit = 20): Promise<RecentRunRow[]> {
  const runs = await prisma.autoListingRun.findMany({
    orderBy: { startedAt: 'desc' }, take: limit,
    select: { id: true, policyVersion: true, requestedBy: true, startedAt: true, completedAt: true, sourceExhausted: true, nextCursor: true },
  })
  if (runs.length === 0) return []
  const grouped = await prisma.autoListingAttempt.groupBy({
    by: ['runId', 'outcome'], where: { runId: { in: runs.map((r) => r.id) } }, _count: { _all: true },
  })
  const countsByRun = new Map<string, Partial<Record<AutoListAttemptOutcome, number>>>()
  for (const g of grouped) {
    const m = countsByRun.get(g.runId) ?? {}
    m[g.outcome as AutoListAttemptOutcome] = g._count._all
    countsByRun.set(g.runId, m)
  }
  return runs.map((r) => ({ ...r, counts: countsByRun.get(r.id) ?? {} }))
}

// "Needs Manual Review" (Part N/34) moved to autoListingReview.ts (execution-snapshot
// pass, Part 6/11) — the actionable review predicate (latest review_required/denied
// attempt per item, excluding items with a current active/sold Listing) is shared
// verbatim by /admin/auto-listing and /admin/inventory, so it is defined exactly
// once there rather than duplicated in this execution-focused module.
