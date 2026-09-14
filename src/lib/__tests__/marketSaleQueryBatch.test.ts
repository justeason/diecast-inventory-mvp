// 25B: getMarketSaleHistoryForModels — batch canonical evidence fetch for
// Portfolio V1. Critical invariants under test: (1) a high-volume model can
// never crowd another model's evidence out of a shared row budget (§9/§75 of
// the 25B spec — the bug this function exists specifically to avoid), (2)
// chunking bounds the IN-clause size rather than issuing one query per model,
// (3) per-model truncation/hasMore matches what a single-model
// getMarketSaleHistory call would report for that same model's own rows.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    orderItem: { findMany: vi.fn() },
    externalMarketObservation: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getMarketSaleHistoryForModels, type InternalSaleCandidateRow } from '@/lib/marketSaleQuery'

function internalRow(catalogModelId: string, id: string, soldAt: Date): InternalSaleCandidateRow {
  return {
    id,
    price: 19.99,
    catalogModelId,
    marketVariantId: null,
    snapshotPackagingType: null,
    snapshotCondition: null,
    snapshotProvenance: 'sale_time',
    order: { status: 'complete', paymentStatus: 'paid', completedAt: soldAt },
  }
}

beforeEach(() => vi.resetAllMocks())

describe('getMarketSaleHistoryForModels — no global cap: a high-volume model cannot crowd out another model (§9/§75)', () => {
  it('a 600-row model and a 3-row model in the same chunk each keep their own independent bound/hasMore', async () => {
    const hotRows = Array.from({ length: 600 }, (_, i) =>
      internalRow('hot-model', `h${i}`, new Date(2026, 0, 1 + i)),
    )
    const coldRows = [
      internalRow('cold-model', 'c1', new Date('2026-01-01')),
      internalRow('cold-model', 'c2', new Date('2026-01-02')),
      internalRow('cold-model', 'c3', new Date('2026-01-03')),
    ]
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([...hotRows, ...coldRows])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])

    const result = await getMarketSaleHistoryForModels({
      catalogModelIds: ['hot-model', 'cold-model'],
      endDate: new Date('2026-06-01'),
      limit: 500,
    })

    const hot = result.get('hot-model')!
    const cold = result.get('cold-model')!

    expect(hot.observations).toHaveLength(500)
    expect(hot.hasMore).toBe(true)
    // The cold model's full 3 rows must survive untouched — not reduced by
    // the hot model's volume sharing a query/page.
    expect(cold.observations).toHaveLength(3)
    expect(cold.hasMore).toBe(false)
  })

  it('a single shared query serves both models — not one query per model', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      internalRow('hot-model', 'h1', new Date('2026-01-01')),
      internalRow('cold-model', 'c1', new Date('2026-01-01')),
    ])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])

    await getMarketSaleHistoryForModels({ catalogModelIds: ['hot-model', 'cold-model'], endDate: new Date('2026-06-01') })

    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1)
    const call = (prisma.orderItem.findMany as Mock).mock.calls[0][0]
    expect(call.where.catalogModelId).toEqual({ in: ['hot-model', 'cold-model'] })
  })
})

describe('getMarketSaleHistoryForModels — chunking bounds the IN-clause, never one query per model (§11/§76)', () => {
  it('51 model ids issue at least 2 internal-source queries (chunked at 50), not 51', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])

    const ids = Array.from({ length: 51 }, (_, i) => `model-${i}`)
    await getMarketSaleHistoryForModels({ catalogModelIds: ids, endDate: new Date('2026-06-01') })

    const callCount = (prisma.orderItem.findMany as Mock).mock.calls.length
    expect(callCount).toBe(2) // ceil(51/50)
    expect(callCount).toBeLessThan(51)
  })

  it('10 model ids issue exactly 1 internal-source query (single chunk)', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])

    const ids = Array.from({ length: 10 }, (_, i) => `model-${i}`)
    await getMarketSaleHistoryForModels({ catalogModelIds: ids, endDate: new Date('2026-06-01') })

    expect((prisma.orderItem.findMany as Mock).mock.calls.length).toBe(1)
  })
})

describe('getMarketSaleHistoryForModels — pagination loops until exhausted, never truncates a page silently', () => {
  it('a full page (2000 rows) triggers a second keyset-cursored query', async () => {
    const fullPage = Array.from({ length: 2000 }, (_, i) => internalRow('m1', `p1-${i}`, new Date(2026, 0, 1)))
    const secondPage = [internalRow('m1', 'p2-0', new Date('2026-02-01'))]
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce(fullPage).mockResolvedValueOnce(secondPage)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])

    const result = await getMarketSaleHistoryForModels({ catalogModelIds: ['m1'], endDate: new Date('2026-06-01'), limit: 500 })

    expect((prisma.orderItem.findMany as Mock).mock.calls.length).toBe(2)
    const secondCall = (prisma.orderItem.findMany as Mock).mock.calls[1][0]
    expect(secondCall.cursor).toEqual({ id: 'p1-1999' })
    expect(result.get('m1')!.observations.length).toBe(500)
    expect(result.get('m1')!.hasMore).toBe(true)
  })
})

describe('getMarketSaleHistoryForModels — internal+external mix, per model, same eligibility as single-model 22B', () => {
  it('combines internal and external observations for the same model, canonically sorted', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([internalRow('m1', 'oi1', new Date('2026-01-01'))])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValueOnce([
      {
        id: 'obs1', provider: 'ebay', matchStatus: 'matched', matchMethod: 'manual',
        catalogModelId: 'm1', marketVariantId: null, marketVariant: null,
        observationType: 'sold', soldAt: new Date('2026-02-01'), currency: 'USD', price: new Prisma.Decimal('25.00'),
      },
    ])

    const result = await getMarketSaleHistoryForModels({ catalogModelIds: ['m1'], endDate: new Date('2026-06-01') })
    const bucket = result.get('m1')!
    expect(bucket.observations).toHaveLength(2)
    // Canonical sort is soldAt DESC — the Feb external sale is newer than the Jan internal sale.
    expect(bucket.observations[0].sourceType).toBe('external')
    expect(bucket.observations[1].sourceType).toBe('internal')
  })

  it('a requested model with zero eligible rows returns an empty, non-truncated bucket', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])

    const result = await getMarketSaleHistoryForModels({ catalogModelIds: ['empty-model'], endDate: new Date('2026-06-01') })
    expect(result.get('empty-model')).toEqual({ observations: [], hasMore: false })
  })
})
