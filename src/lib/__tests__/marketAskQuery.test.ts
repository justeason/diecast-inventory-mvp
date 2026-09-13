// 22B: canonical ask (current-opportunity) primitives — internal vs external
// kept strictly separate; external asks never affect Lowest Ask.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    listing: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    externalMarketObservation: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import {
  toInternalAsk,
  toExternalAsk,
  getInternalAsks,
  getLowestAsk,
  getExternalAsks,
  getInternalAskSummary,
  type InternalAskInput,
  type ExternalAskInput,
} from '@/lib/marketAskQuery'

function internalAskRow(overrides: Partial<InternalAskInput> = {}): InternalAskInput {
  return {
    id: 'listing1',
    price: 12.5,
    item: { catalogId: 'cat1', marketVariantId: 'v1', marketVariant: { packagingType: 'carded' } },
    ...overrides,
  }
}

function externalAskRow(overrides: Partial<ExternalAskInput> = {}): ExternalAskInput {
  return {
    id: 'obs1',
    provider: 'ebay',
    matchStatus: 'matched',
    matchMethod: 'manual',
    catalogModelId: 'cat1',
    marketVariantId: null,
    marketVariant: null,
    observationType: 'active_ask',
    currency: 'USD',
    price: new Prisma.Decimal('15.00'),
    listedAt: new Date('2026-01-01T00:00:00Z'),
    observedAt: new Date('2026-01-05T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => vi.resetAllMocks())

// ── §69: internal asks ──

describe('toInternalAsk / getInternalAsks — internal ask predicate (§37/§69)', () => {
  it('maps a listing to an internal ask with current MarketVariant identity', () => {
    const ask = toInternalAsk(internalAskRow())
    expect(ask).toEqual({
      sourceType: 'internal_ask',
      sourceRecordId: 'listing1',
      catalogModelId: 'cat1',
      marketVariantId: 'v1',
      packagingType: 'carded',
      priceCents: 1250,
      currency: 'USD',
      listedAt: null,
      observedAt: null,
      purchasableHere: true,
    })
  })

  it('never synthesizes observedAt=now for internal asks (§42 hard rule)', () => {
    expect(toInternalAsk(internalAskRow()).observedAt).toBeNull()
  })

  it('WHERE requires active listing + available item — the established Series-20 predicate', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    await getInternalAsks({ catalogModelId: 'cat1' })
    const where = (prisma.listing.findMany as Mock).mock.calls[0][0].where
    expect(where.status).toBe('active')
    expect(where.item.status).toBe('available')
  })

  it('inactive listing excluded (via WHERE, not the mapper)', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    await getInternalAsks({ catalogModelId: 'cat1' })
    expect((prisma.listing.findMany as Mock).mock.calls[0][0].where.status).toBe('active')
  })

  it('reserved/sold/not_for_sale item excluded (via WHERE item.status=available)', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    await getInternalAsks({ catalogModelId: 'cat1' })
    expect((prisma.listing.findMany as Mock).mock.calls[0][0].where.item.status).toBe('available')
  })

  it('price converted to cents', () => {
    expect(toInternalAsk(internalAskRow({ price: 19.99 })).priceCents).toBe(1999)
  })

  it('variant filter applies exact marketVariantId', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    await getInternalAsks({ catalogModelId: 'cat1', marketVariantId: 'v1' })
    expect((prisma.listing.findMany as Mock).mock.calls[0][0].where.item.marketVariantId).toBe('v1')
  })

  it('an unclassified current packaging value is treated as null, never fabricated', () => {
    expect(toInternalAsk(internalAskRow({ item: { catalogId: 'cat1', marketVariantId: 'v1', marketVariant: null } })).packagingType).toBeNull()
  })
})

// ── §70: Lowest Ask ──

describe('getLowestAsk — internal only (§40/§70)', () => {
  it('lowest eligible internal listing wins (price asc ordering)', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([internalAskRow({ id: 'cheapest', price: 5 })])
    const ask = await getLowestAsk({ catalogModelId: 'cat1' })
    expect(ask?.sourceRecordId).toBe('cheapest')
    expect((prisma.listing.findMany as Mock).mock.calls[0][0].orderBy).toEqual([{ price: 'asc' }, { id: 'asc' }])
  })

  it('never queries ExternalMarketObservation — an external ask cheaper than internal cannot affect it', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([internalAskRow()])
    await getLowestAsk({ catalogModelId: 'cat1' })
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
  })

  it('variant filter is strict/exact', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    await getLowestAsk({ catalogModelId: 'cat1', marketVariantId: 'v1' })
    expect((prisma.listing.findMany as Mock).mock.calls[0][0].where.item.marketVariantId).toBe('v1')
  })

  it('returns null when no eligible internal listing exists', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    expect(await getLowestAsk({ catalogModelId: 'cat1' })).toBeNull()
  })
})

// ── §71: external asks ──

describe('toExternalAsk / getExternalAsks — external ask predicate (§41/§71)', () => {
  it('matched active_ask USD price>0 included, purchasableHere=false', () => {
    const ask = toExternalAsk(externalAskRow())!
    expect(ask.purchasableHere).toBe(false)
    expect(ask.sourceType).toBe('external_ask')
  })

  // 22B follow-up §5: toExternalAsk must pass every row through
  // normalizeExternalComparableIdentity — not merely duplicate matchStatus/
  // catalogModelId checks — so a structurally malformed cross-model variant
  // fails closed here exactly as it does for sales.
  it('malformed cross-model variant (marketVariant belongs to a different CatalogModel) is excluded, proving 21D identity is the boundary, not a re-implemented check', () => {
    const malformed = externalAskRow({
      catalogModelId: 'catA',
      marketVariantId: 'v1',
      marketVariant: { id: 'v1', catalogModelId: 'catB', packagingType: 'carded' },
    })
    expect(toExternalAsk(malformed)).toBeNull()
  })

  it('sold observationType excluded from asks', () => {
    expect(toExternalAsk(externalAskRow({ observationType: 'sold' }))).toBeNull()
  })

  it('unmatched excluded', () => {
    expect(toExternalAsk(externalAskRow({ matchStatus: 'unmatched', catalogModelId: null }))).toBeNull()
  })

  it('rejected excluded', () => {
    expect(toExternalAsk(externalAskRow({ matchStatus: 'rejected' }))).toBeNull()
  })

  it('non-USD excluded', () => {
    expect(toExternalAsk(externalAskRow({ currency: 'EUR' }))).toBeNull()
  })

  it('price<=0 excluded', () => {
    expect(toExternalAsk(externalAskRow({ price: new Prisma.Decimal('0') }))).toBeNull()
  })

  it('observedAt is preserved', () => {
    const observedAt = new Date('2026-03-01T00:00:00Z')
    expect(toExternalAsk(externalAskRow({ observedAt }))?.observedAt).toEqual(observedAt)
  })

  it('listedAt is optional and preserved when present, null when absent', () => {
    expect(toExternalAsk(externalAskRow({ listedAt: null }))?.listedAt).toBeNull()
    const listedAt = new Date('2026-01-01T00:00:00Z')
    expect(toExternalAsk(externalAskRow({ listedAt }))?.listedAt).toEqual(listedAt)
  })

  it('getExternalAsks never affects/queries Listing', async () => {
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getExternalAsks({ catalogModelId: 'cat1' })
    expect(prisma.listing.findMany).not.toHaveBeenCalled()
  })
})

describe('ask event shape (§42) — kept separate from sale shape', () => {
  it('MarketAskObservation has no condition/snapshotProvenance field (sale-only concepts)', () => {
    const ask = toInternalAsk(internalAskRow())
    expect(ask).not.toHaveProperty('condition')
    expect(ask).not.toHaveProperty('snapshotProvenance')
  })
})

// ── 24B: getInternalAskSummary — exact Lowest/Median Ask + Available Copies ──

describe('getInternalAskSummary — internal-only, exact regardless of population size (24B §71/§72)', () => {
  it('zero eligible listings -> nulls, availableCopies 0, no lowest/median query issued', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    const result = await getInternalAskSummary({ catalogModelId: 'cat1' })
    expect(result).toEqual({ lowestAskCents: null, medianAskCents: null, availableCopies: 0 })
    expect(prisma.listing.findFirst).not.toHaveBeenCalled()
    expect(prisma.listing.findMany).not.toHaveBeenCalled()
  })

  it('exactly one eligible listing -> lowest === median, single findFirst call (no separate median query)', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(1)
    ;(prisma.listing.findFirst as Mock).mockResolvedValue({ price: 10 })
    const result = await getInternalAskSummary({ catalogModelId: 'cat1' })
    expect(result).toEqual({ lowestAskCents: 1000, medianAskCents: 1000, availableCopies: 1 })
    expect(prisma.listing.findFirst).toHaveBeenCalledTimes(1)
  })

  it('odd count (5) -> median is the exact middle-ordered row (skip 2), not an average', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(5)
    ;(prisma.listing.findFirst as Mock)
      .mockResolvedValueOnce({ price: 5 }) // lowest
      .mockResolvedValueOnce({ price: 20 }) // median (skip 2 of 5)
    const result = await getInternalAskSummary({ catalogModelId: 'cat1' })
    expect(result.lowestAskCents).toBe(500)
    expect(result.medianAskCents).toBe(2000)
    expect(result.availableCopies).toBe(5)
    const medianCall = (prisma.listing.findFirst as Mock).mock.calls[1][0]
    expect(medianCall.skip).toBe(2)
    expect(medianCall.orderBy).toEqual([{ price: 'asc' }, { id: 'asc' }])
  })

  it('even count (6) -> median is the deterministic midpoint of the two middle-ordered rows (skip 2, take 2)', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(6)
    ;(prisma.listing.findFirst as Mock).mockResolvedValueOnce({ price: 5 }) // lowest
    ;(prisma.listing.findMany as Mock).mockResolvedValue([{ price: 10 }, { price: 20 }])
    const result = await getInternalAskSummary({ catalogModelId: 'cat1' })
    expect(result.medianAskCents).toBe(1500)
    const pairCall = (prisma.listing.findMany as Mock).mock.calls[0][0]
    expect(pairCall.skip).toBe(2)
    expect(pairCall.take).toBe(2)
    expect(pairCall.orderBy).toEqual([{ price: 'asc' }, { id: 'asc' }])
  })

  it('exact regardless of population size: 501 eligible listings still issue only count + 2 bounded row fetches, never a 500-row fetch-then-median', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(501)
    ;(prisma.listing.findFirst as Mock)
      .mockResolvedValueOnce({ price: 1 }) // lowest
      .mockResolvedValueOnce({ price: 50 }) // median (odd count -> skip 250)
    const result = await getInternalAskSummary({ catalogModelId: 'cat1' })
    expect(result.availableCopies).toBe(501)
    expect(result.medianAskCents).toBe(5000)
    const medianCall = (prisma.listing.findFirst as Mock).mock.calls[1][0]
    expect(medianCall.skip).toBe(250)
    expect(prisma.listing.findMany).not.toHaveBeenCalled()
  })

  it('uses the exact same eligibility predicate as getInternalAsks/getLowestAsk (active listing + available item), scoped by marketVariantId when supplied', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    await getInternalAskSummary({ catalogModelId: 'cat1', marketVariantId: 'v1' })
    const countCall = (prisma.listing.count as Mock).mock.calls[0][0]
    expect(countCall.where).toEqual({
      status: 'active',
      item: { status: 'available', catalogId: 'cat1', marketVariantId: 'v1' },
    })
  })

  it('inactive listing / reserved-or-sold item never counted (same WHERE as getInternalAsks, not a subtly different predicate)', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    await getInternalAskSummary({ catalogModelId: 'cat1' })
    const countCall = (prisma.listing.count as Mock).mock.calls[0][0]
    expect(countCall.where.status).toBe('active')
    expect(countCall.where.item.status).toBe('available')
  })

  it('never queries ExternalMarketObservation — external asks cannot affect Lowest/Median Ask/Available Copies', async () => {
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    await getInternalAskSummary({ catalogModelId: 'cat1' })
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
  })
})
