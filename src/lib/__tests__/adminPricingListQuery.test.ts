// 32B: DB-boundary tests for adminPricingListQuery.ts — the canonical
// replacement for legacy 14C scanOpportunities(). getValuationsBatch is
// mocked at the function boundary (its own correctness is covered by
// marketValuation.test.ts); isHighDispersion/eligibleListingWhere/
// internalPriceToCents are real (pure) implementations, never mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findMany: vi.fn() },
    listing: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/marketValuation', () => ({ getValuationsBatch: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getValuationsBatch } from '@/lib/marketValuation'
import { scanAdminPricingOpportunities, ADMIN_PRICING_PAGE_SIZE } from '@/lib/adminPricingListQuery'

function model(id: string) {
  return { id, brand: 'Hot Wheels', name: 'GT3', series: null, year: 2024 }
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.listing.findMany as Mock).mockResolvedValue([])
})

describe('scanAdminPricingOpportunities — batching (no N+1)', () => {
  it('fetches valuation via ONE getValuationsBatch call per source page, never N x getValuation', async () => {
    const ids = ['a', 'b', 'c']
    ;(prisma.catalogModel.findMany as Mock)
      .mockResolvedValueOnce(ids.map(model)) // candidate page
      .mockResolvedValueOnce(ids.map(model)) // fetchTargets
    ;(getValuationsBatch as Mock).mockResolvedValueOnce(
      new Map(ids.map((id) => [id, { status: 'insufficient_data' }])),
    )

    const result = await scanAdminPricingOpportunities(null, undefined)
    expect(getValuationsBatch).toHaveBeenCalledTimes(1)
    expect(getValuationsBatch).toHaveBeenCalledWith({ catalogModelIds: ids, asOf: expect.any(Date) })
    expect(result.items).toHaveLength(3)
  })

  it('fetches supply via ONE page-scoped listing.findMany call, never N x per-model queries', async () => {
    const ids = ['a', 'b']
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce(ids.map(model)).mockResolvedValueOnce(ids.map(model))
    ;(getValuationsBatch as Mock).mockResolvedValueOnce(new Map(ids.map((id) => [id, { status: 'insufficient_data' }])))

    await scanAdminPricingOpportunities(null, undefined)
    expect(prisma.listing.findMany).toHaveBeenCalledTimes(1)
  })

  it('reduces page-scoped listing rows into per-model lowest-ask-cents and available-copies', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([model('a')]).mockResolvedValueOnce([model('a')])
    ;(getValuationsBatch as Mock).mockResolvedValueOnce(new Map([['a', { status: 'insufficient_data' }]]))
    ;(prisma.listing.findMany as Mock).mockResolvedValueOnce([
      { price: 25.5, item: { catalogId: 'a' } },
      { price: 19.99, item: { catalogId: 'a' } },
    ])

    const result = await scanAdminPricingOpportunities(null, undefined)
    expect(result.items[0]).toMatchObject({ availableCopies: 2, lowestAskCents: 1999 })
  })
})

describe('scanAdminPricingOpportunities — filters', () => {
  function mockValuations(valuationsById: Record<string, unknown>) {
    const ids = Object.keys(valuationsById)
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce(ids.map(model)).mockResolvedValueOnce(ids.map(model))
    ;(getValuationsBatch as Mock).mockResolvedValueOnce(new Map(Object.entries(valuationsById)))
  }

  it('low_confidence matches only valued rows with confidence=low', async () => {
    mockValuations({
      a: { status: 'valued', confidence: 'low' },
      b: { status: 'valued', confidence: 'high' },
      c: { status: 'insufficient_data' },
    })
    const result = await scanAdminPricingOpportunities('low_confidence', undefined)
    expect(result.items.map((r) => r.catalogModelId)).toEqual(['a'])
  })

  it('high_confidence matches only valued rows with confidence=high', async () => {
    mockValuations({ a: { status: 'valued', confidence: 'low' }, b: { status: 'valued', confidence: 'high' } })
    const result = await scanAdminPricingOpportunities('high_confidence', undefined)
    expect(result.items.map((r) => r.catalogModelId)).toEqual(['b'])
  })

  it('no_sold_evidence matches only non-valued (insufficient_data) rows', async () => {
    mockValuations({ a: { status: 'valued', confidence: 'high' }, b: { status: 'insufficient_data' } })
    const result = await scanAdminPricingOpportunities('no_sold_evidence', undefined)
    expect(result.items.map((r) => r.catalogModelId)).toEqual(['b'])
  })

  it('high_dispersion reuses canonical isHighDispersion — no second dispersion formula', async () => {
    mockValuations({
      // (2200-1800)/2000 = 0.2, below the 0.5 threshold -> not high dispersion
      a: { status: 'valued', confidence: 'medium', marketRangeLowCents: 1800, marketRangeHighCents: 2200, estimatedValueCents: 2000 },
      // (3000-1000)/2000 = 1.0, above threshold -> high dispersion
      b: { status: 'valued', confidence: 'medium', marketRangeLowCents: 1000, marketRangeHighCents: 3000, estimatedValueCents: 2000 },
    })
    const result = await scanAdminPricingOpportunities('high_dispersion', undefined)
    expect(result.items.map((r) => r.catalogModelId)).toEqual(['b'])
  })

  it('no filter (null) returns every row from the page', async () => {
    mockValuations({ a: { status: 'valued', confidence: 'high' }, b: { status: 'insufficient_data' } })
    const result = await scanAdminPricingOpportunities(null, undefined)
    expect(result.items.map((r) => r.catalogModelId).sort()).toEqual(['a', 'b'])
  })
})

describe('scanAdminPricingOpportunities — pagination', () => {
  it('returns nextCursor null when the candidate source is exhausted within one page', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([model('a')]).mockResolvedValueOnce([model('a')])
    ;(getValuationsBatch as Mock).mockResolvedValueOnce(new Map([['a', { status: 'insufficient_data' }]]))
    const result = await scanAdminPricingOpportunities(null, undefined)
    expect(result.nextCursor).toBeNull()
  })

  it('returns a resumable nextCursor when a full page of candidates was fetched (more may exist)', async () => {
    const ids = Array.from({ length: ADMIN_PRICING_PAGE_SIZE + 1 }, (_, i) => `id${i}`)
    const pageIds = ids.slice(0, ADMIN_PRICING_PAGE_SIZE)
    ;(prisma.catalogModel.findMany as Mock)
      .mockResolvedValueOnce(ids.map(model)) // candidate page fetch returns PAGE_SIZE+1 -> hasMore
      .mockResolvedValueOnce(pageIds.map(model)) // fetchTargets for the trimmed page
    ;(getValuationsBatch as Mock).mockResolvedValueOnce(new Map(pageIds.map((id) => [id, { status: 'insufficient_data' }])))

    const result = await scanAdminPricingOpportunities(null, undefined)
    expect(result.nextCursor).toBe(pageIds[pageIds.length - 1])
    expect(result.items).toHaveLength(ADMIN_PRICING_PAGE_SIZE)
  })
})
