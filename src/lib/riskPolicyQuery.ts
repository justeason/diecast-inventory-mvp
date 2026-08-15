// 15F: DB boundary for risk policy config + the approval queue. Read-only — mutations
// live in actions/riskPolicies.ts and actions/riskApprovals.ts. Bounded/keyset-paginated
// queries only (section 39): no full-table loads, DB-side filters/counts.
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import type { RiskPolicySnapshot, RiskAction } from '@/lib/riskPolicy'

const PAGE_SIZE = 25

export type RiskPolicyConfigRow = {
  id: string
  version: number
  effectiveFrom: Date
  highValueReviewThresholdCents: number
  veryHighValueThresholdCents: number
  payoutApprovalThresholdCents: number
  priceDeviationToleranceBps: number
  destructiveActionsRequireApproval: boolean
  commercialOverridesRequireApproval: boolean
  notes: string | null
  createdBy: string
  createdAt: Date
}

const POLICY_SELECT = {
  id: true, version: true, effectiveFrom: true,
  highValueReviewThresholdCents: true, veryHighValueThresholdCents: true,
  payoutApprovalThresholdCents: true, priceDeviationToleranceBps: true,
  destructiveActionsRequireApproval: true, commercialOverridesRequireApproval: true,
  notes: true, createdBy: true, createdAt: true,
} as const

// The effective version at `asOf` is the most recent row with effectiveFrom <= asOf —
// versions are never mutated, only superseded, so this is always unambiguous.
export async function getEffectiveRiskPolicy(asOf: Date = new Date()): Promise<RiskPolicySnapshot | null> {
  const row = await prisma.riskPolicyConfig.findFirst({
    where: { effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: 'desc' },
    select: POLICY_SELECT,
  })
  if (!row) return null
  return {
    version: row.version,
    highValueReviewThresholdCents: row.highValueReviewThresholdCents,
    veryHighValueThresholdCents: row.veryHighValueThresholdCents,
    payoutApprovalThresholdCents: row.payoutApprovalThresholdCents,
    priceDeviationToleranceBps: row.priceDeviationToleranceBps,
    destructiveActionsRequireApproval: row.destructiveActionsRequireApproval,
    commercialOverridesRequireApproval: row.commercialOverridesRequireApproval,
  }
}

// Bounded — policy versions are an admin-curated handful, never an unbounded log.
export async function listRiskPolicyVersions(limit: number = 50): Promise<RiskPolicyConfigRow[]> {
  return prisma.riskPolicyConfig.findMany({ orderBy: { version: 'desc' }, take: limit, select: POLICY_SELECT })
}

// ── Approval queue ───────────────────────────────────────────────────────────────

export type ApprovalQueueFilter = {
  action?: RiskAction | null
  riskLevel?: 'medium' | 'high' | null
  status?: string | null
  targetType?: string | null
}

export type ApprovalQueueRow = {
  id: string
  action: string
  status: string
  riskLevel: string
  targetType: string
  targetId: string
  reasons: string[]
  requestedAt: Date
  requestedBy: string
}

function buildApprovalWhere(filter: ApprovalQueueFilter): Prisma.RiskApprovalRequestWhereInput {
  const where: Prisma.RiskApprovalRequestWhereInput = {}
  if (filter.action) where.action = filter.action
  if (filter.riskLevel) where.riskLevel = filter.riskLevel
  if (filter.status) where.status = filter.status
  if (filter.targetType) where.targetType = filter.targetType
  return where
}

const QUEUE_ROW_SELECT = {
  id: true, action: true, status: true, riskLevel: true, targetType: true, targetId: true,
  reasons: true, requestedAt: true, requestedBy: true,
} as const

export async function searchApprovalQueue(
  filter: ApprovalQueueFilter,
  cursor: string | null,
  pageSize: number = PAGE_SIZE,
): Promise<{ items: ApprovalQueueRow[]; nextCursor: string | null }> {
  const where = buildApprovalWhere(filter)
  const rows = await prisma.riskApprovalRequest.findMany({
    where,
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    take: pageSize + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: QUEUE_ROW_SELECT,
  })
  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows
  return {
    items: page.map((r) => ({ ...r, reasons: (r.reasons as string[]) ?? [] })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  }
}

export type ApprovalQueueSummary = { pending: number; byRiskLevel: Record<'medium' | 'high', number> }

// DB-side grouped counts only — never a full-table load, cheap enough for a nav badge.
export async function getApprovalQueueSummary(): Promise<ApprovalQueueSummary> {
  const grouped = await prisma.riskApprovalRequest.groupBy({
    by: ['riskLevel'],
    where: { status: 'pending' },
    _count: { _all: true },
  })
  const byRiskLevel: Record<'medium' | 'high', number> = { medium: 0, high: 0 }
  let pending = 0
  for (const g of grouped) {
    if (g.riskLevel === 'medium' || g.riskLevel === 'high') byRiskLevel[g.riskLevel] = g._count._all
    pending += g._count._all
  }
  return { pending, byRiskLevel }
}

export type ApprovalDetail = {
  id: string
  action: string
  status: string
  riskLevel: string
  policyCode: string
  policyVersion: number
  targetType: string
  targetId: string
  contextFingerprint: string
  decisionContext: Record<string, unknown>
  reasons: string[]
  requestedBy: string
  requestedAt: Date
  approvedBy: string | null
  approvedAt: Date | null
  rejectedBy: string | null
  rejectedAt: Date | null
  decisionNote: string | null
  expiresAt: Date | null
  consumedAt: Date | null
}

// 15F section 28: best-effort LIVE staleness check for display only — the actual
// enforcement that a stale approval can never be consumed lives in
// consumeApprovedRiskGate's fingerprint re-check (actions/riskApprovals.ts), which
// covers every action uniformly. This is a nicety so the admin can see it coming
// before attempting to resume the original workflow, for the two cases where a
// single cheap extra read makes the "current vs requested" comparison meaningful.
export type ApprovalStaleness = { checked: boolean; stale: boolean; currentValueLabel?: string }

export async function getApprovalStaleness(detail: ApprovalDetail): Promise<ApprovalStaleness> {
  if (detail.action === 'listing_price_change') {
    const listing = await prisma.listing.findUnique({ where: { id: detail.targetId }, select: { price: true } })
    if (!listing) return { checked: true, stale: true, currentValueLabel: 'Listing no longer exists.' }
    const currentCents = Math.round(listing.price * 100)
    const requestedOld = detail.decisionContext.oldPriceCents as number | undefined
    return { checked: true, stale: requestedOld !== undefined && currentCents !== requestedOld, currentValueLabel: `$${(currentCents / 100).toFixed(2)}` }
  }
  if (detail.action === 'seller_payout_mark_paid') {
    const payout = await prisma.sellerPayout.findUnique({ where: { id: detail.targetId }, select: { totalAmount: true, status: true } })
    if (!payout) return { checked: true, stale: true, currentValueLabel: 'Payout no longer exists.' }
    const currentCents = Math.round(parseFloat(payout.totalAmount.toString()) * 100)
    const requested = detail.decisionContext.totalAmountCents as number | undefined
    return { checked: true, stale: (requested !== undefined && currentCents !== requested) || payout.status !== 'approved', currentValueLabel: `$${(currentCents / 100).toFixed(2)} (status: ${payout.status})` }
  }
  return { checked: false, stale: false }
}

export async function getApprovalDetail(id: string): Promise<ApprovalDetail | null> {
  const row = await prisma.riskApprovalRequest.findUnique({ where: { id } })
  if (!row) return null
  return {
    ...row,
    decisionContext: (row.decisionContext as Record<string, unknown>) ?? {},
    reasons: (row.reasons as string[]) ?? [],
  }
}
