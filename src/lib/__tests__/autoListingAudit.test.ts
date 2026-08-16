// 15K Part M/N — audit query tests: bounded, batch-hydrated, no buyer PII.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    autoListingRun: { findMany: vi.fn() },
    autoListingAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
    itemInstance: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/readyToListQuery', () => ({ searchReadyToListPage: vi.fn(), getItemReadyToListStatus: vi.fn() }))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({ getPricingIntelligence: vi.fn() }))
vi.mock('@/lib/riskPolicyQuery', () => ({ getEffectiveRiskPolicy: vi.fn() }))
vi.mock('@/lib/autoListingPolicyQuery', () => ({ getEffectiveAutoListingPolicy: vi.fn() }))
vi.mock('@/lib/listingActivation', () => ({ buildListingActivationContext: vi.fn(), createListingAtomic: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { listRecentAutoListingRuns } from '@/lib/autoListingExecution'

beforeEach(() => vi.resetAllMocks())

describe('listRecentAutoListingRuns — bounded, batch-hydrated outcome counts', () => {
  it('returns [] without querying attempts when there are no runs', async () => {
    ;(prisma.autoListingRun.findMany as Mock).mockResolvedValue([])
    const result = await listRecentAutoListingRuns()
    expect(result).toEqual([])
    expect(prisma.autoListingAttempt.groupBy).not.toHaveBeenCalled()
  })

  it('fetches outcome counts for ALL runs in exactly one groupBy call — never per-run (no N+1)', async () => {
    ;(prisma.autoListingRun.findMany as Mock).mockResolvedValue([
      { id: 'run1', policyVersion: 1, requestedBy: 'admin', startedAt: new Date(), completedAt: new Date(), sourceExhausted: true, nextCursor: null },
      { id: 'run2', policyVersion: 1, requestedBy: 'admin', startedAt: new Date(), completedAt: null, sourceExhausted: false, nextCursor: 'c1' },
    ])
    ;(prisma.autoListingAttempt.groupBy as Mock).mockResolvedValue([
      { runId: 'run1', outcome: 'listed', _count: { _all: 3 } },
      { runId: 'run1', outcome: 'review_required', _count: { _all: 1 } },
      { runId: 'run2', outcome: 'listed', _count: { _all: 0 } },
    ])
    const result = await listRecentAutoListingRuns()
    expect(prisma.autoListingAttempt.groupBy).toHaveBeenCalledTimes(1)
    expect(result[0].counts).toEqual({ listed: 3, review_required: 1 })
    expect(result[1].counts).toEqual({ listed: 0 })
  })

  it('is bounded by the limit parameter', async () => {
    ;(prisma.autoListingRun.findMany as Mock).mockResolvedValue([])
    await listRecentAutoListingRuns(5)
    expect((prisma.autoListingRun.findMany as Mock).mock.calls[0][0].take).toBe(5)
  })
})

// "Needs Manual Review" (the actionable latest-per-item predicate) moved to
// autoListingReview.ts and its own test file, autoListingReview.test.ts —
// see the execution-snapshot pass.
