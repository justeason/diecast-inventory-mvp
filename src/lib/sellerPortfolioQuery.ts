// 15B: DB boundary for SellerPortfolio. Read-only summaries (never mutates
// ItemInstance/Listing/Order/SellerPayout/SellerAgreement — section 24). Batched
// aggregate queries, no N+1, no unbounded findMany on ItemInstance/OrderItem/
// SellerPayoutLine (section 25). No buyer/seller PII beyond admin-appropriate seller
// identity (name/email), consistent with the rest of the seller admin surface.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { decimalFromFloatDollars, sumDecimal, subtractDecimal, DECIMAL_ZERO } from '@/lib/businessAnalyticsMath'
import {
  derivePortfolioStage,
  evaluatePortfolioAttentionSignals,
  type PortfolioStage,
  type PortfolioStageInput,
  type PortfolioAttentionSignal,
} from '@/lib/sellerPortfolio'
import { openIntakeExceptionWhere } from '@/lib/intakeExceptions'

export const LIST_PAGE_SIZE = 25
// Each underlying DB page fetched while scanning for filter matches stays this size,
// no matter how many pages a sparse filter needs to traverse. See listSellerPortfolios.
export const LIST_SOURCE_PAGE_SIZE = 100
// Wall-clock backstop only — never a row-count/page-count cap. See listSellerPortfolios.
const LIST_SCAN_TIME_BUDGET_MS = 8000

export type PortfolioListFilter =
  | 'all'
  | 'needs_attention'
  | 'awaiting_agreement'
  | 'awaiting_shipment'
  | 'inbound'
  | 'intake'
  | 'active'
  | 'completed'
  | 'cancelled'

export type PortfolioListRow = {
  id: string
  name: string | null
  status: string
  stage: PortfolioStage
  sellerProfileId: string
  sellerLabel: string
  submitted: number
  accepted: number | null
  received: number
  listed: number
  sold: number
  agreementStatus: string | null
  agreementCommissionBps: number | null
  outstandingPayout: Prisma.Decimal
  updatedAt: Date
  needsAttention: boolean
}

type PortfolioCoreRow = {
  id: string
  name: string | null
  status: string
  acceptedItemCount: number | null
  updatedAt: Date
  sellerProfile: { id: string; profile: { name: string | null; email: string } }
}

async function fetchCoreBatch(cursor: string | null, take: number): Promise<PortfolioCoreRow[]> {
  return prisma.sellerPortfolio.findMany({
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true,
      name: true,
      status: true,
      acceptedItemCount: true,
      updatedAt: true,
      sellerProfile: { select: { id: true, profile: { select: { name: true, email: true } } } },
    },
  })
}

// Batched, DB-side aggregation for a set of portfolio ids — no per-portfolio queries.
async function hydratePortfolioRows(rows: PortfolioCoreRow[]): Promise<Map<string, PortfolioListRow>> {
  const ids = rows.map(r => r.id)
  if (ids.length === 0) return new Map()

  const [
    submittedGroups,
    receivedShipments,
    listedGroups,
    soldGroups,
    currentAgreements,
    intakeCompleteGroups,
    inTransitShipments,
    outstandingLines,
    rejectedIntakeGroups,
    openCaseGroups,
  ] = await Promise.all([
    prisma.sellerSubmission.groupBy({ by: ['sellerPortfolioId'], where: { sellerPortfolioId: { in: ids } }, _sum: { quantity: true } }),
    prisma.sellerInboundShipment.findMany({
      where: { sellerPortfolioId: { in: ids }, status: { not: 'cancelled' } },
      select: { sellerPortfolioId: true, receivedQuantity: true, status: true },
    }),
    prisma.itemInstance.groupBy({
      by: ['sellerPortfolioId'],
      where: { sellerPortfolioId: { in: ids }, listing: { status: 'active' } },
      _count: { _all: true },
    }),
    prisma.itemInstance.groupBy({
      by: ['sellerPortfolioId'],
      where: { sellerPortfolioId: { in: ids }, status: 'sold' },
      _count: { _all: true },
    }),
    prisma.sellerAgreement.findMany({
      where: { sellerPortfolioId: { in: ids }, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' },
      select: { sellerPortfolioId: true, status: true, commissionSource: true, commissionPercent: true, acceptedItemCount: true },
    }),
    prisma.intakeDraft.groupBy({
      by: ['sellerSubmissionId'],
      where: { status: 'converted', sellerSubmission: { sellerPortfolioId: { in: ids } } },
      _count: { _all: true },
    }),
    prisma.sellerInboundShipment.findMany({
      where: { sellerPortfolioId: { in: ids }, status: 'shipped' },
      select: { sellerPortfolioId: true },
    }),
    prisma.sellerPayoutLine.findMany({
      where: {
        agreement: { sellerPortfolioId: { in: ids } },
        status: { in: ['eligible', 'held'] },
        OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }],
      },
      select: { agreement: { select: { sellerPortfolioId: true } }, netAmount: true },
    }),
    // Completion-blocking facts (section 4/16) — batched, not per-portfolio, so the
    // list's "Completed" stage/filter can't disagree with the detail page's.
    prisma.intakeDraft.groupBy({
      by: ['sellerSubmissionId'],
      where: { status: 'rejected', sellerSubmission: { sellerPortfolioId: { in: ids } } },
      _count: { _all: true },
    }),
    prisma.sellerLifecycleCase.groupBy({
      by: ['sellerSubmissionId'],
      where: { status: { in: ['open', 'action_required'] }, sellerSubmission: { sellerPortfolioId: { in: ids } } },
      _count: { _all: true },
    }),
  ])

  const submittedByPortfolio = new Map(submittedGroups.map(g => [g.sellerPortfolioId as string, g._sum.quantity ?? 0]))
  const listedByPortfolio = new Map(listedGroups.map(g => [g.sellerPortfolioId as string, g._count._all]))
  const soldByPortfolio = new Map(soldGroups.map(g => [g.sellerPortfolioId as string, g._count._all]))
  const inTransitSet = new Set(inTransitShipments.map(s => s.sellerPortfolioId as string))

  const receivedByPortfolio = new Map<string, number>()
  const shipmentCountByPortfolio = new Map<string, number>()
  const shipmentIssuePortfolios = new Set<string>()
  for (const s of receivedShipments) {
    const pid = s.sellerPortfolioId as string
    shipmentCountByPortfolio.set(pid, (shipmentCountByPortfolio.get(pid) ?? 0) + 1)
    if (s.receivedQuantity !== null) receivedByPortfolio.set(pid, (receivedByPortfolio.get(pid) ?? 0) + s.receivedQuantity)
    if (s.status === 'issue') shipmentIssuePortfolios.add(pid)
  }

  // sellerSubmission -> portfolio mapping needed to fold intake-complete counts
  // (grouped by submission) up to portfolio level.
  const submissionRows = ids.length > 0
    ? await prisma.sellerSubmission.findMany({ where: { sellerPortfolioId: { in: ids } }, select: { id: true, sellerPortfolioId: true } })
    : []
  const portfolioBySubmission = new Map(submissionRows.map(s => [s.id, s.sellerPortfolioId as string]))
  const intakeCompleteByPortfolio = new Map<string, number>()
  for (const g of intakeCompleteGroups) {
    if (!g.sellerSubmissionId) continue
    const pid = portfolioBySubmission.get(g.sellerSubmissionId)
    if (!pid) continue
    intakeCompleteByPortfolio.set(pid, (intakeCompleteByPortfolio.get(pid) ?? 0) + g._count._all)
  }

  const intakeExceptionPortfolios = new Set<string>()
  for (const g of rejectedIntakeGroups) {
    if (!g.sellerSubmissionId || g._count._all === 0) continue
    const pid = portfolioBySubmission.get(g.sellerSubmissionId)
    if (pid) intakeExceptionPortfolios.add(pid)
  }
  for (const g of openCaseGroups) {
    if (!g.sellerSubmissionId || g._count._all === 0) continue
    const pid = portfolioBySubmission.get(g.sellerSubmissionId)
    if (pid) intakeExceptionPortfolios.add(pid)
  }

  const outstandingByPortfolio = new Map<string, Prisma.Decimal>()
  for (const line of outstandingLines) {
    const pid = line.agreement?.sellerPortfolioId
    if (!pid) continue
    outstandingByPortfolio.set(pid, (outstandingByPortfolio.get(pid) ?? DECIMAL_ZERO).plus(line.netAmount))
  }

  const currentAgreementByPortfolio = new Map<string, (typeof currentAgreements)[number]>()
  for (const a of currentAgreements) {
    const pid = a.sellerPortfolioId as string
    // orderBy createdAt desc — first one encountered per portfolio is the most recent
    if (!currentAgreementByPortfolio.has(pid)) currentAgreementByPortfolio.set(pid, a)
  }

  const result = new Map<string, PortfolioListRow>()
  for (const r of rows) {
    const agreement = currentAgreementByPortfolio.get(r.id) ?? null
    const hasAcceptedAgreement = agreement?.status === 'accepted'
    const received = receivedByPortfolio.get(r.id) ?? 0
    const intakeComplete = intakeCompleteByPortfolio.get(r.id) ?? 0
    const hasOutstandingPayoutLiability = !(outstandingByPortfolio.get(r.id) ?? DECIMAL_ZERO).isZero()
    const hasOpenIntakeException = intakeExceptionPortfolios.has(r.id)
    const hasUnresolvedInboundDiscrepancy = shipmentIssuePortfolios.has(r.id)
    const stageInput: PortfolioStageInput = {
      status: r.status,
      hasAcceptedAgreement,
      hasNonCancelledShipment: (shipmentCountByPortfolio.get(r.id) ?? 0) > 0,
      anyShipmentInTransit: inTransitSet.has(r.id),
      receivedItemCount: received,
      intakeCompleteCount: intakeComplete,
      allInventoryResolved: intakeComplete > 0 && (soldByPortfolio.get(r.id) ?? 0) >= intakeComplete && !hasOutstandingPayoutLiability,
      hasOutstandingPayoutLiability,
      hasOpenIntakeException,
      hasUnresolvedInboundDiscrepancy,
    }
    const { stage } = derivePortfolioStage(stageInput)

    const accepted = hasAcceptedAgreement ? agreement!.acceptedItemCount : r.acceptedItemCount
    const commissionBps = agreement?.commissionPercent ? Math.round(parseFloat(agreement.commissionPercent.toString()) * 10_000) : null

    const needsAttention = evaluatePortfolioAttentionSignals({
      status: r.status,
      hasAnyAgreement: agreement !== null,
      hasAcceptedAgreement,
      acceptedCount: accepted,
      expectedShipmentQuantity: null, // list view: full expected-qty aggregate omitted for perf; detail page shows it
      receivedShipmentQuantity: null,
      hasAnyShipment: (shipmentCountByPortfolio.get(r.id) ?? 0) > 0,
      receivedItemCount: received,
      intakeCompleteCount: intakeComplete,
      hasOpenIntakeException,
      soldWithoutPayoutObligation: false,
      outstandingEligiblePayoutCount: 0,
    }).length > 0

    result.set(r.id, {
      id: r.id,
      name: r.name,
      status: r.status,
      stage,
      sellerProfileId: r.sellerProfile.id,
      sellerLabel: r.sellerProfile.profile.name ?? r.sellerProfile.profile.email,
      submitted: submittedByPortfolio.get(r.id) ?? 0,
      accepted,
      received,
      listed: listedByPortfolio.get(r.id) ?? 0,
      sold: soldByPortfolio.get(r.id) ?? 0,
      agreementStatus: agreement?.status ?? null,
      agreementCommissionBps: commissionBps,
      outstandingPayout: outstandingByPortfolio.get(r.id) ?? DECIMAL_ZERO,
      updatedAt: r.updatedAt,
      needsAttention,
    })
  }
  return result
}

function matchesFilter(row: PortfolioListRow, filter: PortfolioListFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'needs_attention') return row.needsAttention
  return row.stage === filter
}

// A derived filter (stage, needs-attention) can only be evaluated AFTER hydrating a
// source page, so a single bounded source page may yield zero matches even though
// later source pages have plenty. There is deliberately NO fixed total-portfolio cap
// here — a sparse filter scanning past portfolio 300, 3000, or however far the real
// population goes is expected and correct; capping it would silently hide genuine
// matches (see 14C's scanOpportunities in pricingIntelligenceQuery.ts, the same
// pattern used here). The only backstop is a wall-clock time budget, so a
// pathologically rare filter cannot hang a single request indefinitely. When the
// budget is hit, the scan returns an EXPLICIT incomplete result — whatever matches it
// already found (possibly none) plus `nextCursor` pointing at the last fully
// processed source portfolio — so the caller resumes exactly where it left off. Every
// source page between calls is still individually DB-bounded (LIST_SOURCE_PAGE_SIZE+1
// rows, keyset cursor, no OFFSET, no full-table read).
async function fetchCoreBatchPage(cursor: string | null): Promise<{ rows: PortfolioCoreRow[]; nextCursor: string | null }> {
  const rows = await fetchCoreBatch(cursor, LIST_SOURCE_PAGE_SIZE + 1)
  const hasMore = rows.length > LIST_SOURCE_PAGE_SIZE
  const page = hasMore ? rows.slice(0, LIST_SOURCE_PAGE_SIZE) : rows
  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null }
}

// Bounded, keyset-paginated scan that keeps fetching+hydrating source pages — never a
// full-table read, always LIST_SOURCE_PAGE_SIZE-row pages — until either:
//   - enough matching rows have been collected to fill an output page, or
//   - the candidate source population is exhausted (nextCursor becomes null), or
//   - the time budget is exhausted (nextCursor stays non-null: resumable, not lost).
// A source page, once fetched and hydrated, is never partially discarded: every match
// it produces is kept (so a page that happens to match heavily can return more than
// pageSize rows) — trimming to an exact page size would silently drop already-computed
// matches and force them to be re-scanned incorrectly next call. `nextCursor` is
// always the last SOURCE portfolio fully examined, never merely the last matching
// result, so pagination cannot skip or repeat a candidate portfolio.
//
// `nowMs` is an injectable clock (defaults to the real wall clock) purely for this
// function's own runtime-budget bookkeeping.
export async function listSellerPortfolios(params: {
  filter: PortfolioListFilter
  cursor: string | null
  pageSize?: number
  nowMs?: () => number
}): Promise<{ items: PortfolioListRow[]; nextCursor: string | null }> {
  const pageSize = params.pageSize ?? LIST_PAGE_SIZE
  const nowMs = params.nowMs ?? Date.now
  const matched: PortfolioListRow[] = []
  let cursor = params.cursor
  let lastProcessedId: string | null = null
  let sourceExhausted = false
  const deadline = nowMs() + LIST_SCAN_TIME_BUDGET_MS

  while (matched.length < pageSize && nowMs() < deadline) {
    const { rows: core, nextCursor: pageCursor } = await fetchCoreBatchPage(cursor)
    if (core.length === 0) { sourceExhausted = true; break }

    const hydrated = await hydratePortfolioRows(core)
    for (const c of core) {
      const row = hydrated.get(c.id)
      if (row && matchesFilter(row, params.filter)) matched.push(row)
      lastProcessedId = c.id // every portfolio in this page is "fully processed" regardless of match
    }

    if (pageCursor === null) { sourceExhausted = true; break }
    cursor = pageCursor
  }

  return { items: matched, nextCursor: sourceExhausted ? null : lastProcessedId }
}

// ── Detail page ──────────────────────────────────────────────────────────────────

export type PortfolioDetail = {
  id: string
  name: string | null
  status: string
  stage: PortfolioStage
  statusMismatch: boolean
  notes: string | null
  createdAt: Date
  updatedAt: Date
  closedAt: Date | null
  sellerProfileId: string
  sellerLabel: string
  sellerEmail: string
  expectedItemCount: number | null
  portfolioAcceptedItemCount: number | null
  submissions: Array<{ id: string; brand: string | null; name: string | null; quantity: number; status: string; createdAt: Date }>
  currentAgreement: {
    id: string
    status: string
    commissionPercent: string | null
    commissionMinimumFee: string | null
    commissionSource: string | null
    commissionExplanation: string | null
    acceptedItemCount: number | null
    submissionId: string
  } | null
  shipments: Array<{
    id: string
    status: string
    carrier: string | null
    trackingNumber: string | null
    expectedQuantity: number
    receivedQuantity: number | null
    shippedAt: Date | null
    receivedAt: Date | null
    // 15E: open intake-exception count scoped to this specific shipment.
    openExceptionCount: number
  }>
  counts: {
    submitted: number
    accepted: number | null
    expectedInbound: number
    received: number
    intakeComplete: number
    available: number
    listed: number
    reserved: number
    sold: number
    exceptions: number
  }
  financial: {
    completedSalesGmv: Prisma.Decimal
    completedSalesCount: number
    sellerProceeds: Prisma.Decimal
    grossSpread: Prisma.Decimal
    outstandingPayout: Prisma.Decimal
    paidPayout: Prisma.Decimal
  }
  attentionSignals: PortfolioAttentionSignal[]
  // 15E: count of OPEN 15D/15E intake exception drafts (workbenchExceptionCode set,
  // unconverted, not rejected) for this portfolio — distinct from `counts.exceptions`
  // above (15B's older rejected-draft/lifecycle-case + not_for_sale inventory signal,
  // left unchanged). Links to /admin/intake/exceptions?portfolioId=...
  openIntakeExceptionCount: number
}

export async function getPortfolioDetail(id: string): Promise<PortfolioDetail | null> {
  const portfolio = await prisma.sellerPortfolio.findUnique({
    where: { id },
    select: {
      id: true, name: true, status: true, notes: true,
      createdAt: true, updatedAt: true, closedAt: true,
      expectedItemCount: true, acceptedItemCount: true,
      sellerProfile: { select: { id: true, profile: { select: { name: true, email: true } } } },
    },
  })
  if (!portfolio) return null

  const [submissions, agreements, shipments, items] = await Promise.all([
    prisma.sellerSubmission.findMany({
      where: { sellerPortfolioId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, brand: true, name: true, quantity: true, status: true, createdAt: true },
    }),
    // 15B-review section 2: at most one non-cancelled agreement can exist per
    // portfolio — enforced transactionally in createSellerAgreement (portfolio-row
    // lock + a portfolio-scoped, not submission-scoped, existing-agreement check) —
    // so `take: 1, orderBy createdAt desc` is unambiguous, not merely "most likely".
    prisma.sellerAgreement.findMany({
      where: { sellerPortfolioId: id, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, status: true, commissionPercent: true, commissionMinimumFee: true,
        commissionSource: true, commissionExplanation: true, acceptedItemCount: true, submissionId: true,
      },
      take: 1,
    }),
    prisma.sellerInboundShipment.findMany({
      where: { sellerPortfolioId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, carrier: true, trackingNumber: true, expectedQuantity: true, receivedQuantity: true, shippedAt: true, receivedAt: true },
    }),
    // Bounded: portfolio item counts are aggregated, not loaded in full (section 25).
    prisma.itemInstance.groupBy({
      by: ['status'],
      where: { sellerPortfolioId: id },
      _count: { _all: true },
    }),
  ])

  const currentAgreement = agreements[0] ?? null
  const hasAcceptedAgreement = currentAgreement?.status === 'accepted'
  const submitted = submissions.reduce((sum, s) => sum + s.quantity, 0)
  const accepted = hasAcceptedAgreement ? currentAgreement!.acceptedItemCount : portfolio.acceptedItemCount

  const nonCancelledShipments = shipments.filter(s => s.status !== 'cancelled')
  const expectedInbound = nonCancelledShipments.reduce((sum, s) => sum + s.expectedQuantity, 0)
  const received = nonCancelledShipments.reduce((sum, s) => sum + (s.receivedQuantity ?? 0), 0)
  const anyShipmentInTransit = nonCancelledShipments.some(s => s.status === 'shipped')

  const [listedCount, intakeCompleteCount, openExceptionCount, openIntakeExceptionCount, shipmentExceptionGroups] = await Promise.all([
    prisma.itemInstance.count({ where: { sellerPortfolioId: id, listing: { status: 'active' } } }),
    prisma.intakeDraft.count({ where: { status: 'converted', sellerSubmission: { sellerPortfolioId: id } } }),
    prisma.intakeDraft.count({ where: { sellerSubmission: { sellerPortfolioId: id }, status: 'rejected' } }).then(async rejected => {
      const openCases = await prisma.sellerLifecycleCase.count({
        where: { sellerSubmission: { sellerPortfolioId: id }, status: { in: ['open', 'action_required'] } },
      })
      return rejected + openCases
    }),
    // 15E: distinct from openExceptionCount above (legacy rejected-draft/case signal)
    // — this is the 15D/15E workbenchExceptionCode queue count, portfolio-scoped via
    // either the shipment or the submission link (workbench drafts always have a
    // shipment; legacy/manual ones would only have the submission).
    prisma.intakeDraft.count({
      where: {
        ...openIntakeExceptionWhere(),
        OR: [{ sellerInboundShipment: { sellerPortfolioId: id } }, { sellerSubmission: { sellerPortfolioId: id } }],
      },
    }),
    // Bounded, single grouped query (not per-shipment) for each shipment's own open
    // exception count.
    shipments.length > 0
      ? prisma.intakeDraft.groupBy({
          by: ['sellerInboundShipmentId'],
          where: { ...openIntakeExceptionWhere(), sellerInboundShipmentId: { in: shipments.map((s) => s.id) } },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ sellerInboundShipmentId: string | null; _count: { _all: number } }>),
  ])

  const statusByCount = new Map(items.map(g => [g.status, g._count._all]))
  const availableCount = statusByCount.get('available') ?? 0
  const reservedCount = statusByCount.get('reserved') ?? 0
  const soldCount = statusByCount.get('sold') ?? 0
  const exceptionsFromInventory = statusByCount.get('not_for_sale') ?? 0

  const allInventoryResolved = intakeCompleteCount > 0

  // getPortfolioSalesFinancials already computes outstanding/paid payout internally
  // (financial.outstandingPayout/paidPayout) — reuse those instead of issuing the
  // same aggregate queries a second time.
  const [financial, soldWithoutPayoutCount] = await Promise.all([
    getPortfolioSalesFinancials(id),
    countSoldItemsWithoutPayoutLine(id),
  ])

  const hasOutstandingPayoutLiability = !financial.outstandingPayout.isZero()
  const hasOpenIntakeException = openExceptionCount > 0
  // Authoritative "needs resolution" signal (section 4) — a shipment the admin
  // explicitly flagged 'issue' at receipt, not an inferred raw quantity mismatch.
  const hasUnresolvedInboundDiscrepancy = nonCancelledShipments.some(s => s.status === 'issue')

  const stageInput: PortfolioStageInput = {
    status: portfolio.status,
    hasAcceptedAgreement,
    hasNonCancelledShipment: nonCancelledShipments.length > 0,
    anyShipmentInTransit,
    receivedItemCount: received,
    intakeCompleteCount,
    allInventoryResolved: allInventoryResolved && soldCount >= intakeCompleteCount && !hasOutstandingPayoutLiability,
    hasOutstandingPayoutLiability,
    hasOpenIntakeException,
    hasUnresolvedInboundDiscrepancy,
  }
  const { stage, statusMismatch } = derivePortfolioStage(stageInput)

  const attentionSignals = evaluatePortfolioAttentionSignals({
    status: portfolio.status,
    hasAnyAgreement: currentAgreement !== null,
    hasAcceptedAgreement,
    acceptedCount: accepted,
    expectedShipmentQuantity: nonCancelledShipments.length > 0 ? expectedInbound : null,
    receivedShipmentQuantity: nonCancelledShipments.some(s => s.receivedQuantity !== null) ? received : null,
    hasAnyShipment: nonCancelledShipments.length > 0,
    receivedItemCount: received,
    intakeCompleteCount,
    hasOpenIntakeException: openExceptionCount > 0,
    soldWithoutPayoutObligation: soldWithoutPayoutCount > 0,
    outstandingEligiblePayoutCount: await countOutstandingPayoutLines(id),
  })

  return {
    id: portfolio.id,
    name: portfolio.name,
    status: portfolio.status,
    stage,
    statusMismatch,
    notes: portfolio.notes,
    createdAt: portfolio.createdAt,
    updatedAt: portfolio.updatedAt,
    closedAt: portfolio.closedAt,
    sellerProfileId: portfolio.sellerProfile.id,
    sellerLabel: portfolio.sellerProfile.profile.name ?? portfolio.sellerProfile.profile.email,
    sellerEmail: portfolio.sellerProfile.profile.email,
    expectedItemCount: portfolio.expectedItemCount,
    portfolioAcceptedItemCount: portfolio.acceptedItemCount,
    submissions,
    currentAgreement: currentAgreement
      ? {
          id: currentAgreement.id,
          status: currentAgreement.status,
          commissionPercent: currentAgreement.commissionPercent?.toString() ?? null,
          commissionMinimumFee: currentAgreement.commissionMinimumFee?.toString() ?? null,
          commissionSource: currentAgreement.commissionSource,
          commissionExplanation: currentAgreement.commissionExplanation,
          acceptedItemCount: currentAgreement.acceptedItemCount,
          submissionId: currentAgreement.submissionId,
        }
      : null,
    shipments: shipments.map((s) => ({
      ...s,
      openExceptionCount: shipmentExceptionGroups.find((g) => g.sellerInboundShipmentId === s.id)?._count._all ?? 0,
    })),
    counts: {
      submitted,
      accepted,
      expectedInbound,
      received,
      intakeComplete: intakeCompleteCount,
      available: availableCount,
      listed: listedCount,
      reserved: reservedCount,
      sold: soldCount,
      exceptions: exceptionsFromInventory + openExceptionCount,
    },
    financial,
    attentionSignals,
    openIntakeExceptionCount,
  }
}

// ── Financial summary helpers (section 12) — reuse 14B's authoritative definitions ──
// GMV = sum(OrderItem.price) for completed orders (see businessAnalyticsQuery.ts
// header comment: one OrderItem per sold ItemInstance, no separate quantity field).
// sellerProceeds/grossSpread come from SellerPayoutLine (consignment lines only) —
// grossSpread is commission taken, never labeled "profit". Outstanding/paid payout use
// the exact same status semantics as getOutstandingLiability/getPayoutFlow (14B).

async function getPortfolioSalesFinancials(portfolioId: string): Promise<PortfolioDetail['financial']> {
  const soldOrderItems = await prisma.orderItem.findMany({
    where: { order: { status: 'complete' }, item: { sellerPortfolioId: portfolioId } },
    select: { id: true, price: true },
  })
  const completedSalesGmv = sumDecimal(soldOrderItems.map(i => decimalFromFloatDollars(i.price)))

  const consignmentLines = soldOrderItems.length > 0
    ? await prisma.sellerPayoutLine.findMany({
        where: { lineType: 'consignment', orderItemId: { in: soldOrderItems.map(i => i.id) } },
        select: { orderItemId: true, grossSalePrice: true, netAmount: true },
      })
    : []

  let sellerProceeds = DECIMAL_ZERO
  let grossSpread = DECIMAL_ZERO
  const priceByOrderItem = new Map(soldOrderItems.map(i => [i.id, decimalFromFloatDollars(i.price)]))
  for (const line of consignmentLines) {
    const gross = line.grossSalePrice ?? priceByOrderItem.get(line.orderItemId as string) ?? DECIMAL_ZERO
    sellerProceeds = sellerProceeds.plus(line.netAmount)
    grossSpread = grossSpread.plus(subtractDecimal(gross, line.netAmount))
  }

  const outstandingPayout = await sumPortfolioPayoutLines(portfolioId, {
    status: { in: ['eligible', 'held'] },
    OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }],
  })
  const paidPayout = await sumPortfolioPayoutLines(portfolioId, { payout: { status: 'paid' } })

  return {
    completedSalesGmv,
    completedSalesCount: soldOrderItems.length,
    sellerProceeds,
    grossSpread,
    outstandingPayout,
    paidPayout,
  }
}

async function sumPortfolioPayoutLines(
  portfolioId: string,
  extraWhere: Prisma.SellerPayoutLineWhereInput,
): Promise<Prisma.Decimal> {
  const agg = await prisma.sellerPayoutLine.aggregate({
    where: { agreement: { sellerPortfolioId: portfolioId }, ...extraWhere },
    _sum: { netAmount: true },
  })
  return agg._sum.netAmount ?? DECIMAL_ZERO
}

async function countOutstandingPayoutLines(portfolioId: string): Promise<number> {
  return prisma.sellerPayoutLine.count({
    where: {
      agreement: { sellerPortfolioId: portfolioId },
      status: { in: ['eligible', 'held'] },
      OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }],
    },
  })
}

// A sold ItemInstance under this portfolio with no SellerPayoutLine at all — this can
// only be proven for consignment items (buyout items are paid at intake, not per-sale,
// so absence of a line there is expected and not an exception).
async function countSoldItemsWithoutPayoutLine(portfolioId: string): Promise<number> {
  const soldConsignmentItems = await prisma.itemInstance.findMany({
    where: { sellerPortfolioId: portfolioId, status: 'sold', sourceType: 'consignment' },
    select: { orderItems: { select: { sellerPayoutLine: { select: { id: true } } } } },
  })
  return soldConsignmentItems.filter(i => i.orderItems.every(oi => oi.sellerPayoutLine === null)).length
}

// ── Activity timeline (section 18) ────────────────────────────────────────────────
// Reuses existing SellerLifecycleEvent rows (already written by submission/agreement/
// shipment/lifecycle actions) plus authoritative timestamps already on this portfolio's
// own records — writes NO new event rows, so nothing is duplicated. Bounded (take 30).

export type PortfolioActivityEntry = { occurredAt: Date; title: string; description: string | null }

export async function getPortfolioActivity(portfolioId: string): Promise<PortfolioActivityEntry[]> {
  const portfolio = await prisma.sellerPortfolio.findUnique({ where: { id: portfolioId }, select: { createdAt: true } })
  if (!portfolio) return []

  const events = await prisma.sellerLifecycleEvent.findMany({
    where: { sellerSubmission: { sellerPortfolioId: portfolioId } },
    orderBy: { occurredAt: 'desc' },
    take: 30,
    select: { occurredAt: true, sellerTitle: true, eventType: true, adminDescription: true, sellerDescription: true },
  })

  const entries: PortfolioActivityEntry[] = events.map(e => ({
    occurredAt: e.occurredAt,
    title: e.sellerTitle ?? e.eventType,
    description: e.adminDescription ?? e.sellerDescription,
  }))
  entries.push({ occurredAt: portfolio.createdAt, title: 'Portfolio created', description: null })
  return entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
}

// ── Bounded item list for the detail page (section 25) ────────────────────────────

export type PortfolioItemRow = {
  id: string
  sku: string
  status: string
  brand: string
  name: string
  listingStatus: string | null
  createdAt: Date
}

const ITEM_PAGE_SIZE = 50

export async function getPortfolioItemsPage(
  portfolioId: string,
  cursor: string | null,
): Promise<{ items: PortfolioItemRow[]; nextCursor: string | null }> {
  const rows = await prisma.itemInstance.findMany({
    where: { sellerPortfolioId: portfolioId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: ITEM_PAGE_SIZE + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true, sku: true, status: true, createdAt: true,
      catalog: { select: { brand: true, name: true } },
      listing: { select: { status: true } },
    },
  })
  const hasMore = rows.length > ITEM_PAGE_SIZE
  const page = hasMore ? rows.slice(0, ITEM_PAGE_SIZE) : rows
  return {
    items: page.map(r => ({
      id: r.id, sku: r.sku, status: r.status,
      brand: r.catalog.brand, name: r.catalog.name,
      listingStatus: r.listing?.status ?? null,
      createdAt: r.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  }
}

// ── Seller-facing view (section 19) ────────────────────────────────────────────────
// Ownership is enforced in the WHERE clause (sellerProfile.profile.id = profileId) —
// never fetched then checked after the fact, so a wrong/guessed id simply returns
// null rather than leaking existence. Deliberately excludes admin notes, internal
// cost/purchasePrice, buyer PII, and any other seller's rates — only the fields
// listed in section 19 are selected.

export type SellerPortfolioListEntry = {
  id: string
  name: string | null
  stage: PortfolioStage
  submitted: number
  accepted: number | null
  updatedAt: Date
}

export async function listMySellerPortfolios(profileId: string): Promise<SellerPortfolioListEntry[]> {
  const rows = await prisma.sellerPortfolio.findMany({
    where: { sellerProfile: { profile: { id: profileId } } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true, name: true, status: true, acceptedItemCount: true, updatedAt: true,
      submissions: { select: { quantity: true } },
      agreements: { where: { status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, acceptedItemCount: true } },
      inboundShipments: { where: { status: { not: 'cancelled' } }, select: { status: true, receivedQuantity: true } },
      items: { select: { status: true } },
    },
  })

  return rows.map((r) => {
    const agreement = r.agreements[0] ?? null
    const hasAcceptedAgreement = agreement?.status === 'accepted'
    const submitted = r.submissions.reduce((s, x) => s + x.quantity, 0)
    const received = r.inboundShipments.reduce((s, x) => s + (x.receivedQuantity ?? 0), 0)
    const soldCount = r.items.filter(i => i.status === 'sold').length
    const { stage } = derivePortfolioStage({
      status: r.status,
      hasAcceptedAgreement,
      hasNonCancelledShipment: r.inboundShipments.length > 0,
      anyShipmentInTransit: r.inboundShipments.some(s => s.status === 'shipped'),
      receivedItemCount: received,
      intakeCompleteCount: r.items.length,
      allInventoryResolved: r.items.length > 0 && soldCount >= r.items.length,
      hasOutstandingPayoutLiability: false, // seller-facing list view: omitted for perf, shown accurately on detail
      hasOpenIntakeException: false, // seller-facing list view: omitted for perf, shown accurately on detail
      hasUnresolvedInboundDiscrepancy: r.inboundShipments.some(s => s.status === 'issue'), // already fetched, free
    })
    return {
      id: r.id,
      name: r.name,
      stage,
      submitted,
      accepted: hasAcceptedAgreement ? agreement!.acceptedItemCount : r.acceptedItemCount,
      updatedAt: r.updatedAt,
    }
  })
}

export type SellerPortfolioView = {
  id: string
  name: string | null
  stage: PortfolioStage
  agreementStatus: string | null
  commissionPercent: string | null
  acceptedItemCount: number | null
  shipments: Array<{ status: string; expectedQuantity: number; receivedQuantity: number | null; shippedAt: Date | null; receivedAt: Date | null }>
  receivedCount: number
  listedCount: number
  soldCount: number
  sellerProceeds: Prisma.Decimal
  outstandingPayout: Prisma.Decimal
  paidPayout: Prisma.Decimal
}

export async function getSellerPortfolioView(portfolioId: string, profileId: string): Promise<SellerPortfolioView | null> {
  const portfolio = await prisma.sellerPortfolio.findFirst({
    where: { id: portfolioId, sellerProfile: { profile: { id: profileId } } },
    select: {
      id: true, name: true, status: true, acceptedItemCount: true,
      agreements: {
        where: { status: { not: 'cancelled' } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { status: true, commissionPercent: true, acceptedItemCount: true },
      },
      inboundShipments: {
        where: { status: { not: 'cancelled' } },
        select: { status: true, expectedQuantity: true, receivedQuantity: true, shippedAt: true, receivedAt: true },
      },
    },
  })
  if (!portfolio) return null

  const agreement = portfolio.agreements[0] ?? null
  const hasAcceptedAgreement = agreement?.status === 'accepted'
  const received = portfolio.inboundShipments.reduce((s, x) => s + (x.receivedQuantity ?? 0), 0)

  const [listedCount, soldCount, sellerProceeds, outstandingPayout, paidPayout] = await Promise.all([
    prisma.itemInstance.count({ where: { sellerPortfolioId: portfolioId, listing: { status: 'active' } } }),
    prisma.itemInstance.count({ where: { sellerPortfolioId: portfolioId, status: 'sold' } }),
    sumPortfolioPayoutLines(portfolioId, { lineType: { in: ['consignment', 'buyout'] } }),
    sumPortfolioPayoutLines(portfolioId, {
      status: { in: ['eligible', 'held'] },
      OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }],
    }),
    sumPortfolioPayoutLines(portfolioId, { payout: { status: 'paid' } }),
  ])

  const { stage } = derivePortfolioStage({
    status: portfolio.status,
    hasAcceptedAgreement,
    hasNonCancelledShipment: portfolio.inboundShipments.length > 0,
    anyShipmentInTransit: portfolio.inboundShipments.some(s => s.status === 'shipped'),
    receivedItemCount: received,
    intakeCompleteCount: soldCount, // seller-facing: intake-in-progress detail omitted, folds into received/active distinction
    allInventoryResolved: false,
    hasOutstandingPayoutLiability: !outstandingPayout.isZero(),
    hasOpenIntakeException: false, // seller-facing: internal exception detail not shown to seller
    hasUnresolvedInboundDiscrepancy: portfolio.inboundShipments.some(s => s.status === 'issue'), // already fetched, free
  })

  return {
    id: portfolio.id,
    name: portfolio.name,
    stage,
    agreementStatus: agreement?.status ?? null,
    commissionPercent: agreement?.commissionPercent?.toString() ?? null,
    acceptedItemCount: hasAcceptedAgreement ? agreement!.acceptedItemCount : portfolio.acceptedItemCount,
    shipments: portfolio.inboundShipments,
    receivedCount: received,
    listedCount,
    soldCount,
    sellerProceeds,
    outstandingPayout,
    paidPayout,
  }
}
