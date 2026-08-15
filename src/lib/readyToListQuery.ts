// 15J: DB boundary for the Ready-to-List readiness engine (readyToList.ts). Read-
// only — never mutates ItemInstance/Listing/SellerAgreement/SellerPayout/
// RiskApprovalRequest/IntakeDraft (see readyToListSafety tests for the structural
// guarantee). Two query shapes:
//   1. getReadyToListContext/getItemReadyToListStatus — one bounded set of lookups
//      for a single item (Item Workspace).
//   2. searchReadyToListPage — ordinary Items-list filters (shared with
//      itemLifecycleQuery.ts) ANDed with a safe readiness candidate predicate ->
//      bounded chunked scan -> evaluate -> keep matches (Part I section 23).
//      Readiness composes as an ADDITIONAL filter dimension, never a separate,
//      mutually-exclusive search mode (15J composable-filters focused review).
//
// 15J focused-review (count-semantics pass): there is deliberately NO exact global
// "Ready to List" count here. evaluateReadyToList's 'ready' vs 'review_required'
// split depends on 14C pricing confidence, which cannot be evaluated for an
// unbounded candidate set without exactly the "expensive hydration" this module
// exists to avoid — so no function in this file may EVER be labeled/exposed as an
// exact Ready-to-List total. The command center and inventory hub instead keep the
// older, narrower, still-exact "Available, Not Listed" DB count under its own
// honest name (adminOperationsQuery.ts) and link to the real per-item readiness
// filter (searchReadyToListPage) for anything requiring the actual policy.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { detectItemContradictions } from '@/lib/itemLifecycle'
import { RETURN_PENDING_CASE_TYPES } from '@/lib/itemMutations'
import { buildSearchWhere, type ItemSearchFilter } from '@/lib/itemLifecycleQuery'
import { getPricingIntelligence, getPricingIntelligenceBatch } from '@/lib/pricingIntelligenceQuery'
import { evaluateReadyToList, type ReadyToListContext, type ReadyToListOutcome } from '@/lib/readyToList'
import type { Confidence } from '@/lib/resaleEstimator'

// ── Single item (Item Workspace) ────────────────────────────────────────────────

const ITEM_SELECT = {
  id: true, status: true, locationId: true, sourceType: true,
  sellerAgreementId: true, sellerPortfolioId: true, catalogId: true,
  listing: { select: { status: true } },
} as const

type ReadyToListItemRow = Prisma.ItemInstanceGetPayload<{ select: typeof ITEM_SELECT }>

async function buildContextForItem(
  item: ReadyToListItemRow,
  includePricing: boolean,
): Promise<ReadyToListContext> {
  const [agreement, completedOrderCount, completedOrderItem, openReturnCase] = await Promise.all([
    item.sellerAgreementId
      ? prisma.sellerAgreement.findUnique({ where: { id: item.sellerAgreementId }, select: { status: true, sellerPortfolioId: true } })
      : Promise.resolve(null),
    prisma.orderItem.count({ where: { itemId: item.id, order: { status: 'complete' } } }),
    prisma.orderItem.findFirst({ where: { itemId: item.id, order: { status: 'complete' } }, select: { id: true } }),
    prisma.sellerLifecycleCase.findFirst({
      where: { itemInstanceId: item.id, caseType: { in: [...RETURN_PENDING_CASE_TYPES] }, status: { in: ['open', 'action_required'] } },
      select: { id: true },
    }),
  ])

  const hasAnyPayoutLine = completedOrderItem
    ? (await prisma.sellerPayoutLine.count({ where: { orderItemId: completedOrderItem.id } })) > 0
    : false

  const contradictions = detectItemContradictions({
    itemStatus: item.status,
    hasActiveListing: item.listing?.status === 'active',
    hasCompletedOrderItem: completedOrderCount > 0,
    sourceType: item.sourceType,
    hasAnyPayoutLine,
    locationId: item.locationId,
    sellerPortfolioId: item.sellerPortfolioId,
    agreementPortfolioId: agreement ? agreement.sellerPortfolioId : undefined,
    completedOrderCount,
  })

  let pricing: ReadyToListContext['pricing'] = null
  if (includePricing) {
    const intel = await getPricingIntelligence(item.catalogId)
    pricing = intel
      ? { estimatedValueCents: intel.estimatedValueCents, confidenceLevel: intel.confidence.level, isAskOnly: intel.isAskOnly }
      : { estimatedValueCents: null, confidenceLevel: 'insufficient', isAskOnly: false }
  }

  return {
    itemStatus: item.status,
    locationId: item.locationId,
    sourceType: item.sourceType,
    sellerAgreementId: item.sellerAgreementId,
    agreementStatus: agreement?.status ?? null,
    listingStatus: item.listing?.status ?? null,
    completedOrderCount,
    hasOpenReturnCase: !!openReturnCase,
    contradictions,
    pricing,
  }
}

export async function getReadyToListContext(itemId: string): Promise<ReadyToListContext | null> {
  const item = await prisma.itemInstance.findUnique({ where: { id: itemId }, select: ITEM_SELECT })
  if (!item) return null
  return buildContextForItem(item, true)
}

export async function getItemReadyToListStatus(itemId: string): Promise<ReadyToListOutcome | null> {
  const ctx = await getReadyToListContext(itemId)
  return ctx ? evaluateReadyToList(ctx) : null
}

// ── List page (Items list filter, Part I) ───────────────────────────────────────

export type ReadinessFilterValue = 'ready' | 'review_required' | 'blocked'

export type ReadyToListListRow = {
  id: string
  sku: string
  brand: string
  name: string
  status: string
  outcome: ReadyToListOutcome
}

const SCAN_CHUNK_SIZE = 50
const SCAN_TIME_BUDGET_MS = 2000

const LIST_CANDIDATE_SELECT = {
  id: true, sku: true, status: true, locationId: true, sourceType: true,
  sellerAgreementId: true, sellerPortfolioId: true, catalogId: true,
  catalog: { select: { brand: true, name: true } },
  listing: { select: { status: true } },
} as const

type ListCandidate = Prisma.ItemInstanceGetPayload<{ select: typeof LIST_CANDIDATE_SELECT }>

// Batch-hydrates readiness context for a whole page of candidates in a fixed,
// bounded number of queries (never one per row, never a per-row 14C call — Part Q).
async function hydrateReadyToListContexts(items: ListCandidate[]): Promise<Map<string, ReadyToListContext>> {
  const ids = items.map((i) => i.id)
  const agreementIds = [...new Set(items.map((i) => i.sellerAgreementId).filter((x): x is string => !!x))]
  const catalogIds = [...new Set(items.map((i) => i.catalogId))]

  const [agreements, completedCounts, completedOrderItems, returnCases, pricingMap] = await Promise.all([
    agreementIds.length > 0
      ? prisma.sellerAgreement.findMany({ where: { id: { in: agreementIds } }, select: { id: true, status: true, sellerPortfolioId: true } })
      : Promise.resolve([]),
    prisma.orderItem.groupBy({ by: ['itemId'], where: { itemId: { in: ids }, order: { status: 'complete' } }, _count: { _all: true } }),
    prisma.orderItem.findMany({ where: { itemId: { in: ids }, order: { status: 'complete' } }, select: { id: true, itemId: true } }),
    prisma.sellerLifecycleCase.findMany({
      where: { itemInstanceId: { in: ids }, caseType: { in: [...RETURN_PENDING_CASE_TYPES] }, status: { in: ['open', 'action_required'] } },
      select: { itemInstanceId: true },
    }),
    getPricingIntelligenceBatch(catalogIds),
  ])

  const agreementById = new Map(agreements.map((a) => [a.id, a]))
  const completedCountByItem = new Map(completedCounts.map((c) => [c.itemId, c._count._all]))
  const completedOrderItemIdByItem = new Map(completedOrderItems.map((oi) => [oi.itemId, oi.id]))
  const returnCaseItemIds = new Set(returnCases.map((c) => c.itemInstanceId!))

  const completedOrderItemIds = completedOrderItems.map((oi) => oi.id)
  const payoutLines = completedOrderItemIds.length > 0
    ? await prisma.sellerPayoutLine.findMany({ where: { orderItemId: { in: completedOrderItemIds } }, select: { orderItemId: true } })
    : []
  const orderItemIdsWithPayout = new Set(payoutLines.map((p) => p.orderItemId))

  const map = new Map<string, ReadyToListContext>()
  for (const item of items) {
    const agreement = item.sellerAgreementId ? agreementById.get(item.sellerAgreementId) ?? null : null
    const completedOrderCount = completedCountByItem.get(item.id) ?? 0
    const completedOrderItemId = completedOrderItemIdByItem.get(item.id) ?? null
    const hasAnyPayoutLine = completedOrderItemId ? orderItemIdsWithPayout.has(completedOrderItemId) : false

    const contradictions = detectItemContradictions({
      itemStatus: item.status,
      hasActiveListing: item.listing?.status === 'active',
      hasCompletedOrderItem: completedOrderCount > 0,
      sourceType: item.sourceType,
      hasAnyPayoutLine,
      locationId: item.locationId,
      sellerPortfolioId: item.sellerPortfolioId,
      agreementPortfolioId: agreement ? agreement.sellerPortfolioId : undefined,
      completedOrderCount,
    })

    const intel = pricingMap.get(item.catalogId) ?? null
    const pricing: ReadyToListContext['pricing'] = intel
      ? { estimatedValueCents: intel.estimatedValueCents, confidenceLevel: intel.confidence.level, isAskOnly: intel.isAskOnly }
      : { estimatedValueCents: null, confidenceLevel: 'insufficient' as Confidence, isAskOnly: false }

    map.set(item.id, {
      itemStatus: item.status,
      locationId: item.locationId,
      sourceType: item.sourceType,
      sellerAgreementId: item.sellerAgreementId,
      agreementStatus: agreement?.status ?? null,
      listingStatus: item.listing?.status ?? null,
      completedOrderCount,
      hasOpenReturnCase: returnCaseItemIds.has(item.id),
      contradictions,
      pricing,
    })
  }
  return map
}

// Chunked scan (same shape as sellerPortfolioQuery.ts#listSellerPortfolios): a DB
// candidate filter narrows the pool, then each chunk is batch-hydrated and evaluated
// for real — only rows whose FULL evaluation matches `readiness` are kept. Time-
// budgeted (never an unbounded scan), but the time budget always yields a
// resumable cursor rather than pretending the result set ended (section 6) — see
// the exhaustion-tracking comment below for the one subtlety in this loop.
//
// Candidate filter safety (section 11): for readiness 'ready'/'review_required',
// the DB pre-filter is status: 'available'. This can never exclude a valid match:
// evaluateReadyToList's VERY FIRST check is `itemStatus !== 'available'` ->
// blocked('item_not_available') unconditionally, so any item with itemStatus !==
// 'available' can never reach blockers.length === 0 and therefore can never be
// 'ready' or 'review_required' — the predicate is strictly a superset, proven by
// the engine's own logic, not just by convention. (Verified by a dedicated test in
// readyToList.test.ts.) 'blocked' is intentionally left unfiltered — it is not a
// superset-safe predicate since a blocked item can have any status.
//
// 15J (composable-filters pass): `filter` is the SAME ItemSearchFilter shape the
// ordinary Items-list search uses, run through the exact same buildSearchWhere
// (itemLifecycleQuery.ts) — there is no second, drifted interpretation of q/status/
// condition/type here. The ordinary predicate and the readiness candidate predicate
// are combined with an explicit `AND: [...]`, never a shallow object spread — a
// spread would let one `status` constraint silently clobber the other. With `AND`,
// an admin who explicitly picks an impossible combination (e.g. readiness=ready +
// status=sold) gets a truthful zero-row result (status='available' AND
// status='sold' can never both hold) instead of either filter being silently
// dropped (focused-review section 3).
export async function searchReadyToListPage(
  readiness: ReadinessFilterValue,
  filter: ItemSearchFilter,
  cursor: string | null,
  pageSize = 25,
): Promise<{ items: ReadyToListListRow[]; nextCursor: string | null }> {
  const ordinaryWhere = buildSearchWhere(filter)
  const where: Prisma.ItemInstanceWhereInput =
    readiness === 'blocked' ? ordinaryWhere : { AND: [ordinaryWhere, { status: 'available' }] }

  const matched: ReadyToListListRow[] = []
  let dbCursor = cursor
  let lastProcessedId: string | null = null
  let sourceExhausted = false
  const deadline = Date.now() + SCAN_TIME_BUDGET_MS

  while (matched.length < pageSize && Date.now() < deadline) {
    const chunk = await prisma.itemInstance.findMany({
      where,
      orderBy: { id: 'asc' }, // deterministic keyset — id is the PK, never OFFSET
      take: SCAN_CHUNK_SIZE,
      ...(dbCursor ? { skip: 1, cursor: { id: dbCursor } } : {}),
      select: LIST_CANDIDATE_SELECT,
    })
    if (chunk.length === 0) { sourceExhausted = true; break }

    const contexts = await hydrateReadyToListContexts(chunk)
    let pageFilledMidChunk = false
    for (const row of chunk) {
      lastProcessedId = row.id
      const outcome = evaluateReadyToList(contexts.get(row.id)!)
      if (outcome.status === readiness) {
        matched.push({ id: row.id, sku: row.sku, brand: row.catalog.brand, name: row.catalog.name, status: row.status, outcome })
        if (matched.length >= pageSize) { pageFilledMidChunk = true; break }
      }
    }

    // Only trust "this was the last chunk" when we actually consumed the WHOLE
    // chunk in the loop above. If we broke early because the page filled up
    // mid-chunk, `chunk.length < SCAN_CHUNK_SIZE` can ALSO be true (the short
    // final chunk happened to contain enough matches) — treating that as
    // exhaustion would silently drop every row after the last match we returned
    // (focused-review section 8: e.g. chunk [A,B,C,D,E,F] with C/E matching and
    // pageSize=2 — filling the page at E must not claim the scan is done; F was
    // never evaluated). `pageFilledMidChunk` is the ONLY signal for "stopped
    // early"; a full, unbroken pass through a short chunk is the only legitimate
    // source-exhaustion signal.
    if (pageFilledMidChunk) break
    if (chunk.length < SCAN_CHUNK_SIZE) { sourceExhausted = true; break }
    dbCursor = lastProcessedId
  }

  return { items: matched, nextCursor: sourceExhausted ? null : lastProcessedId }
}
