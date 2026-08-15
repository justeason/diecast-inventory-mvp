import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    riskPolicyConfig: { findFirst: vi.fn(), findMany: vi.fn() },
    riskApprovalRequest: { findMany: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn() },
    listing: { findUnique: vi.fn() },
    sellerPayout: { findUnique: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import {
  getEffectiveRiskPolicy,
  listRiskPolicyVersions,
  searchApprovalQueue,
  getApprovalQueueSummary,
  getApprovalDetail,
  getApprovalStaleness,
} from '@/lib/riskPolicyQuery'

describe('getEffectiveRiskPolicy (section 13) — most recent version with effectiveFrom <= asOf', () => {
  beforeEach(() => vi.resetAllMocks())

  it('null when no policy row exists', async () => {
    ;(prisma.riskPolicyConfig.findFirst as Mock).mockResolvedValueOnce(null)
    expect(await getEffectiveRiskPolicy(new Date())).toBeNull()
  })

  it('queries ordered by effectiveFrom desc, filtered to <= asOf — never a future version', async () => {
    const asOf = new Date('2026-06-01')
    ;(prisma.riskPolicyConfig.findFirst as Mock).mockResolvedValueOnce({
      version: 2, highValueReviewThresholdCents: 1, veryHighValueThresholdCents: 2, payoutApprovalThresholdCents: 3,
      priceDeviationToleranceBps: 4, destructiveActionsRequireApproval: true, commercialOverridesRequireApproval: true,
    })
    await getEffectiveRiskPolicy(asOf)
    const call = (prisma.riskPolicyConfig.findFirst as Mock).mock.calls[0][0]
    expect(call.where.effectiveFrom).toEqual({ lte: asOf })
    expect(call.orderBy).toEqual({ effectiveFrom: 'desc' })
  })

  it('returns a snapshot with only the fields the engine needs', async () => {
    ;(prisma.riskPolicyConfig.findFirst as Mock).mockResolvedValueOnce({
      version: 5, highValueReviewThresholdCents: 100, veryHighValueThresholdCents: 200, payoutApprovalThresholdCents: 300,
      priceDeviationToleranceBps: 400, destructiveActionsRequireApproval: false, commercialOverridesRequireApproval: true,
    })
    const snap = await getEffectiveRiskPolicy(new Date())
    expect(snap).toEqual({
      version: 5, highValueReviewThresholdCents: 100, veryHighValueThresholdCents: 200, payoutApprovalThresholdCents: 300,
      priceDeviationToleranceBps: 400, destructiveActionsRequireApproval: false, commercialOverridesRequireApproval: true,
    })
  })
})

describe('listRiskPolicyVersions — bounded (section 39)', () => {
  it('is bounded by a take limit, never an unbounded log', async () => {
    ;(prisma.riskPolicyConfig.findMany as Mock).mockResolvedValueOnce([])
    await listRiskPolicyVersions()
    const call = (prisma.riskPolicyConfig.findMany as Mock).mock.calls[0][0]
    expect(call.take).toBeGreaterThan(0)
    expect(call.orderBy).toEqual({ version: 'desc' })
  })
})

describe('searchApprovalQueue — keyset pagination, DB-side filters (section 20/39)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('applies action/riskLevel/status/targetType filters', async () => {
    ;(prisma.riskApprovalRequest.findMany as Mock).mockResolvedValueOnce([])
    await searchApprovalQueue({ action: 'listing_price_change', riskLevel: 'high', status: 'pending', targetType: 'listing' }, null)
    const call = (prisma.riskApprovalRequest.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ action: 'listing_price_change', riskLevel: 'high', status: 'pending', targetType: 'listing' })
  })

  it('keyset pagination: requests pageSize+1, slices, and reports nextCursor only when more remain', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, action: 'a', status: 'pending', riskLevel: 'medium', targetType: 't', targetId: 'x', reasons: [], requestedAt: new Date(), requestedBy: 'admin' }))
    ;(prisma.riskApprovalRequest.findMany as Mock).mockResolvedValueOnce(rows)
    const page = await searchApprovalQueue({}, null, 5)
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBe('r4')
  })

  it('no next page when results are within pageSize', async () => {
    ;(prisma.riskApprovalRequest.findMany as Mock).mockResolvedValueOnce([{ id: 'r0', action: 'a', status: 'pending', riskLevel: 'medium', targetType: 't', targetId: 'x', reasons: [], requestedAt: new Date(), requestedBy: 'admin' }])
    const page = await searchApprovalQueue({}, null, 5)
    expect(page.nextCursor).toBeNull()
  })
})

describe('getApprovalQueueSummary — grouped counts, never a full-table load (section 34/39)', () => {
  it('uses groupBy scoped to pending status', async () => {
    ;(prisma.riskApprovalRequest.groupBy as Mock).mockResolvedValueOnce([
      { riskLevel: 'high', _count: { _all: 3 } },
      { riskLevel: 'medium', _count: { _all: 2 } },
    ])
    const summary = await getApprovalQueueSummary()
    expect(summary).toEqual({ pending: 5, byRiskLevel: { high: 3, medium: 2 } })
    const call = (prisma.riskApprovalRequest.groupBy as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ status: 'pending' })
  })
})

describe('getApprovalDetail', () => {
  it('null for a missing request', async () => {
    ;(prisma.riskApprovalRequest.findUnique as Mock).mockResolvedValueOnce(null)
    expect(await getApprovalDetail('missing')).toBeNull()
  })

  it('parses decisionContext/reasons JSON columns', async () => {
    ;(prisma.riskApprovalRequest.findUnique as Mock).mockResolvedValueOnce({
      id: 'a1', action: 'listing_price_change', status: 'pending', riskLevel: 'medium', policyCode: 'x', policyVersion: 1,
      targetType: 'listing', targetId: 'l1', contextFingerprint: 'fp', decisionContext: { oldPriceCents: 100 }, reasons: ['r1'],
      requestedBy: 'admin', requestedAt: new Date(), approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null,
      decisionNote: null, expiresAt: null, consumedAt: null,
    })
    const detail = await getApprovalDetail('a1')
    expect(detail!.decisionContext).toEqual({ oldPriceCents: 100 })
    expect(detail!.reasons).toEqual(['r1'])
  })
})

describe('getApprovalStaleness (section 28) — best-effort live comparison', () => {
  beforeEach(() => vi.resetAllMocks())

  function baseDetail(overrides: Record<string, unknown> = {}) {
    return {
      id: 'a1', action: 'listing_price_change', status: 'approved', riskLevel: 'medium', policyCode: 'x', policyVersion: 1,
      targetType: 'listing', targetId: 'l1', contextFingerprint: 'fp', decisionContext: { oldPriceCents: 2000 }, reasons: [],
      requestedBy: 'admin', requestedAt: new Date(), approvedBy: 'admin', approvedAt: new Date(), rejectedBy: null, rejectedAt: null,
      decisionNote: null, expiresAt: null, consumedAt: null,
      ...overrides,
    }
  }

  it('listing_price_change: not stale when the current price still matches the requested "old" price', async () => {
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 20 })
    const staleness = await getApprovalStaleness(baseDetail() as never)
    expect(staleness).toEqual({ checked: true, stale: false, currentValueLabel: '$20.00' })
  })

  it('listing_price_change: stale when the current price has since moved (worked example from spec)', async () => {
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 18 })
    const staleness = await getApprovalStaleness(baseDetail() as never)
    expect(staleness.stale).toBe(true)
    expect(staleness.currentValueLabel).toBe('$18.00')
  })

  it('seller_payout_mark_paid: stale when the payout is no longer in approved status', async () => {
    ;(prisma.sellerPayout.findUnique as Mock).mockResolvedValueOnce({ totalAmount: { toString: () => '1000.00' }, status: 'paid' })
    const staleness = await getApprovalStaleness(baseDetail({ action: 'seller_payout_mark_paid', decisionContext: { totalAmountCents: 100_000 } }) as never)
    expect(staleness.stale).toBe(true)
  })

  it('actions without a cheap live check are reported as not checked, never fabricated as stale/fresh', async () => {
    const staleness = await getApprovalStaleness(baseDetail({ action: 'seller_commission_override' }) as never)
    expect(staleness).toEqual({ checked: false, stale: false })
  })
})
