// 22B: canonical ask (current-opportunity) primitives — internal vs external
// kept strictly separate; external asks never affect Lowest Ask.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    listing: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn() },
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
  getInternalAskDepth,
  buildInternalAskWhere,
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

// ── 28B: getInternalAskDepth — Current Ask Depth ────────────────────────────

function groupRow(price: number, count: number) {
  return { price, _count: { _all: count } }
}

describe('getInternalAskDepth — eligibility reuse (§3/§59)', () => {
  it('uses the exact same buildInternalAskWhere predicate as getInternalAsks/getInternalAskSummary — no second definition', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([])
    await getInternalAskDepth({ catalogModelId: 'cat1', marketVariantId: 'v1' })
    const call = (prisma.listing.groupBy as Mock).mock.calls[0][0]
    expect(call.where).toEqual(buildInternalAskWhere({ catalogModelId: 'cat1', marketVariantId: 'v1' }))
    expect(call.where).toEqual({
      status: 'active',
      item: { status: 'available', catalogId: 'cat1', marketVariantId: 'v1' },
    })
  })

  it('groups by price via a DB aggregate — never a bounded findMany/take/skip', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([])
    await getInternalAskDepth({ catalogModelId: 'cat1' })
    const call = (prisma.listing.groupBy as Mock).mock.calls[0][0]
    expect(call.by).toEqual(['price'])
    expect(call).not.toHaveProperty('take')
    expect(call).not.toHaveProperty('skip')
  })
})

describe('getInternalAskDepth — grouping and sorting (§7/§33/§62/§63/§68)', () => {
  it('$32 x1, $35 x2, $40 x1 -> three levels ascending by price, exact counts', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([
      groupRow(40, 1),
      groupRow(32, 1),
      groupRow(35, 2),
    ])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })
    expect(depth).toEqual([
      { priceCents: 3200, availableCopies: 1 },
      { priceCents: 3500, availableCopies: 2 },
      { priceCents: 4000, availableCopies: 1 },
    ])
  })

  it('N listings at the same price collapse into one level with count=N, never duplicate rows', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([groupRow(35, 3)])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })
    expect(depth).toEqual([{ priceCents: 3500, availableCopies: 3 }])
  })

  it('distinct Float prices that convert to the SAME canonical cents value merge into one level, counts summed (§7/§34)', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([groupRow(32.0, 1), groupRow(32.001, 2)])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })
    expect(depth).toEqual([{ priceCents: 3200, availableCopies: 3 }])
  })

  it('output order is deterministic ascending regardless of input row order', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([groupRow(99, 1), groupRow(1, 1), groupRow(50, 1)])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })
    expect(depth.map((l) => l.priceCents)).toEqual([100, 5000, 9900])
  })
})

describe('getInternalAskDepth — condition aggregation (§10/§64)', () => {
  it('two listings at the same price with different item conditions still collapse into one level (depth groups by price only, condition is never a grouping key)', async () => {
    // groupBy(['price']) inherently cannot split by condition since 'price' is
    // the only grouping field — two Carded listings ($35, Near Mint and Good)
    // are indistinguishable to this query and correctly merge.
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([groupRow(35, 2)])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1', marketVariantId: 'v1' })
    expect(depth).toEqual([{ priceCents: 3500, availableCopies: 2 }])
    const call = (prisma.listing.groupBy as Mock).mock.calls[0][0]
    expect(call.by).toEqual(['price'])
  })
})

describe('getInternalAskDepth — variant scope, no fallback (§9/§65)', () => {
  it('marketVariantId is threaded into the eligibility predicate exactly like getInternalAsks — Carded never falls back to All', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([])
    await getInternalAskDepth({ catalogModelId: 'cat1', marketVariantId: 'carded-variant' })
    const call = (prisma.listing.groupBy as Mock).mock.calls[0][0]
    expect(call.where.item.marketVariantId).toBe('carded-variant')
  })

  it('omitting marketVariantId (All) applies no variant filter', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([])
    await getInternalAskDepth({ catalogModelId: 'cat1' })
    const call = (prisma.listing.groupBy as Mock).mock.calls[0][0]
    expect(call.where.item).not.toHaveProperty('marketVariantId')
  })
})

describe('getInternalAskDepth — empty and single-level (§31/§32/§66/§67)', () => {
  it('zero eligible listings -> empty array (UI renders "No copies currently available.")', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })
    expect(depth).toEqual([])
  })

  it('exactly one eligible listing -> one normal level, not treated as a special/degenerate case', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([groupRow(32, 1)])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })
    expect(depth).toEqual([{ priceCents: 3200, availableCopies: 1 }])
  })
})

describe('getInternalAskDepth — money (§8/§69)', () => {
  it('uses the canonical internalPriceToCents conversion, never a raw Math.round(price*100) in the depth module', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketAskQuery.ts'), 'utf-8')
    const idx = src.indexOf('export async function getInternalAskDepth')
    const block = src.slice(idx, src.indexOf('\n}', idx))
    expect(block).toContain('internalPriceToCents(group.price)')
    expect(block).not.toMatch(/Math\.round\(.*price.*100\)/)
  })
})

describe('getInternalAskDepth — privacy (§20/§71)', () => {
  it('selects/returns only price and count — never a seller/profile/agreement field', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketAskQuery.ts'), 'utf-8')
    const idx = src.indexOf('export async function getInternalAskDepth')
    const block = src.slice(idx, src.indexOf('\n}', idx + 400))
    expect(block).not.toMatch(/seller|profile|agreement|payout|cost/i)
  })

  it('AskDepthLevel type has exactly priceCents and availableCopies, nothing else', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketAskQuery.ts'), 'utf-8')
    expect(src).toContain('export type AskDepthLevel = { priceCents: number; availableCopies: number }')
  })
})

// ── 28B: Lowest Ask / Available Copies parity with getInternalAskSummary ───

describe('28B: depth <-> summary parity (§11/§12/§60/§61)', () => {
  it('depth[0].priceCents equals getInternalAskSummary.lowestAskCents for the same eligible population', async () => {
    const listings = [
      { price: 32, id: 'l1' },
      { price: 35, id: 'l2' },
      { price: 35, id: 'l3' },
      { price: 40, id: 'l4' },
    ]

    ;(prisma.listing.groupBy as Mock).mockResolvedValue([
      groupRow(32, 1),
      groupRow(35, 2),
      groupRow(40, 1),
    ])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })

    ;(prisma.listing.count as Mock).mockResolvedValue(listings.length)
    ;(prisma.listing.findFirst as Mock).mockResolvedValue({ price: 32 }) // lowest, price ASC
    ;(prisma.listing.findMany as Mock).mockResolvedValue([{ price: 35 }, { price: 35 }]) // median pair (n=4)
    const summary = await getInternalAskSummary({ catalogModelId: 'cat1' })

    expect(depth[0].priceCents).toBe(summary.lowestAskCents)
  })

  it('SUM(depth.availableCopies) equals getInternalAskSummary.availableCopies for the same eligible population', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([
      groupRow(32, 1),
      groupRow(35, 2),
      groupRow(40, 1),
    ])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })
    const depthTotal = depth.reduce((sum, level) => sum + level.availableCopies, 0)

    ;(prisma.listing.count as Mock).mockResolvedValue(4)
    ;(prisma.listing.findFirst as Mock).mockResolvedValue({ price: 32 })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([{ price: 35 }, { price: 35 }])
    const summary = await getInternalAskSummary({ catalogModelId: 'cat1' })

    expect(depthTotal).toBe(summary.availableCopies)
  })

  it('zero eligible listings: depth is empty and summary.availableCopies is 0 — both agree', async () => {
    ;(prisma.listing.groupBy as Mock).mockResolvedValue([])
    const depth = await getInternalAskDepth({ catalogModelId: 'cat1' })

    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    const summary = await getInternalAskSummary({ catalogModelId: 'cat1' })

    expect(depth).toEqual([])
    expect(summary.availableCopies).toBe(0)
    expect(summary.lowestAskCents).toBeNull()
  })
})

// ── 28B: market-boundary discipline ─────────────────────────────────────────

describe('28B: ask depth never feeds valuation/signals (§29/§30/§72)', () => {
  it('marketAskQuery.ts never imports getValuation/getMarketSignals/valuation math', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketAskQuery.ts'), 'utf-8')
    expect(src).not.toMatch(/getValuation|getMarketSignals|marketValuationMath/)
  })
})
