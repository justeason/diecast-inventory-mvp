// 22B: canonical ask (current-opportunity) primitives — internal vs external
// kept strictly separate; external asks never affect Lowest Ask.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    listing: { findMany: vi.fn() },
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
