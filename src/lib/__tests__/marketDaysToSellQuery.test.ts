// 30B: canonical Days-to-Sell — internal-only, reuses the exact 22B
// buildInternalWhere predicate (never a second, weaker "completed sale"
// definition), joins Listing.createdAt, 180-day window, N>=3 minimum sample,
// deterministic median. Mocked-prisma behavioral tests, matching this
// codebase's established convention (see marketSaleQuery.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { orderItem: { findMany: vi.fn() } },
}))

import { prisma } from '@/lib/prisma'
import { getMedianDaysToSell, DAYS_TO_SELL_WINDOW_DAYS, DAYS_TO_SELL_MIN_SAMPLE } from '@/lib/marketDaysToSellQuery'

const START = new Date('2026-01-01T00:00:00Z')
const END = new Date('2026-06-30T00:00:00Z')

function row(listingCreatedAt: string, completedAt: string | null) {
  return {
    order: { completedAt: completedAt ? new Date(completedAt) : null },
    listing: { createdAt: new Date(listingCreatedAt) },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('30B: getMedianDaysToSell — eligibility and predicate reuse (§26/§27/§63)', () => {
  it('queries prisma.orderItem with the canonical buildInternalWhere shape (status complete, paymentStatus paid via the reused predicate)', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    const call = (prisma.orderItem.findMany as Mock).mock.calls[0][0]
    expect(call.where.order.status).toBe('complete')
    expect(call.where.order.paymentStatus).toBe('paid')
    expect(call.where.price).toEqual({ gt: 0 })
  })

  it('selects order.completedAt and listing.createdAt — the strongest real Listing linkage (OrderItem.listingId), not a derived/indirect join', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    const call = (prisma.orderItem.findMany as Mock).mock.calls[0][0]
    expect(call.select.order.select.completedAt).toBe(true)
    expect(call.select.listing.select.createdAt).toBe(true)
  })

  it('threads marketVariantId through when provided, matching the same variant-scoping the rest of the Market Model Page uses', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    await getMedianDaysToSell({ catalogModelId: 'cat1', marketVariantId: 'var1', startDate: START, endDate: END })
    const call = (prisma.orderItem.findMany as Mock).mock.calls[0][0]
    expect(call.where.marketVariantId).toBe('var1')
  })
})

describe('30B: duration computation and exclusions (§27/§28/§73)', () => {
  it('negative duration (listing created after the sale completed) is excluded', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([
      row('2026-02-10', '2026-02-01'), // negative
      row('2026-01-01', '2026-01-05'),
      row('2026-01-01', '2026-01-10'),
      row('2026-01-01', '2026-01-15'),
    ])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    expect(result.status).toBe('available')
    if (result.status === 'available') expect(result.sampleCount).toBe(3)
  })

  it('a row with no completedAt (defensive — should never pass the WHERE, but the mapper still guards it) is excluded', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([
      row('2026-01-01', null),
      row('2026-01-01', '2026-01-05'),
      row('2026-01-01', '2026-01-10'),
      row('2026-01-01', '2026-01-15'),
    ])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    expect(result.status).toBe('available')
    if (result.status === 'available') expect(result.sampleCount).toBe(3)
  })

  it('duration = completedAt - listing.createdAt, rounded to whole days', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([
      row('2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'), // 3 days
      row('2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'),
      row('2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'),
    ])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    expect(result).toEqual({ status: 'available', medianDays: 3, sampleCount: 3 })
  })
})

describe('30B: minimum sample threshold — N>=3 (§30/§74)', () => {
  it('N=0 -> insufficient_data', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    expect(result).toEqual({ status: 'insufficient_data', sampleCount: 0 })
  })

  it('N=1 -> insufficient_data, no median from a single sale', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([row('2026-01-01', '2026-01-05')])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    expect(result).toEqual({ status: 'insufficient_data', sampleCount: 1 })
  })

  it('N=2 -> insufficient_data', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([
      row('2026-01-01', '2026-01-05'),
      row('2026-01-01', '2026-01-06'),
    ])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    expect(result).toEqual({ status: 'insufficient_data', sampleCount: 2 })
  })

  it('N=3 (the exact constant) -> available, deterministic odd-sample median', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([
      row('2026-01-01', '2026-01-02'), // 1
      row('2026-01-01', '2026-01-06'), // 5
      row('2026-01-01', '2026-01-11'), // 10
    ])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    expect(result).toEqual({ status: 'available', medianDays: 5, sampleCount: 3 })
  })

  it('N=4 (even sample) -> deterministic, rounded average of the two middle values', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([
      row('2026-01-01', '2026-01-02'), // 1
      row('2026-01-01', '2026-01-06'), // 5
      row('2026-01-01', '2026-01-11'), // 10
      row('2026-01-01', '2026-01-15'), // 14
    ])
    const result = await getMedianDaysToSell({ catalogModelId: 'cat1', startDate: START, endDate: END })
    // sorted [1,5,10,14] -> Math.round((5+10)/2) = 8
    expect(result).toEqual({ status: 'available', medianDays: 8, sampleCount: 4 })
  })

  it('DAYS_TO_SELL_MIN_SAMPLE constant is exactly 3', () => {
    expect(DAYS_TO_SELL_MIN_SAMPLE).toBe(3)
  })
})

describe('30B: 180-day window constant (§29)', () => {
  it('DAYS_TO_SELL_WINDOW_DAYS is exactly 180, not unlimited/all-time', () => {
    expect(DAYS_TO_SELL_WINDOW_DAYS).toBe(180)
  })
})
