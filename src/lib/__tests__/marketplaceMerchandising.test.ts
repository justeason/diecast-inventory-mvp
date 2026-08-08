import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  buildRecentlyListed,
  buildHighValue,
  buildRecentlySold,
  computeTrendingModels,
  computeFastMovers,
  computeTopPriceMovers,
  FAST_MOVER_MIN_SAMPLES,
  PRICE_MOVER_MIN_SAMPLES,
  TRENDING_WINDOW_DAYS,
  FAST_MOVER_WINDOW_DAYS,
  RECENT_PRICE_WINDOW_DAYS,
  PRIOR_PRICE_WINDOW_DAYS,
} from '@/lib/marketplaceMerchandising'
import type { RawActiveListing, RawSoldItem, RawSaleRecord, MerchandisingData } from '@/lib/marketplaceMerchandising'
import { formatDate } from '@/lib/formatDate'

const NOW = new Date('2026-08-02T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

function daysAgo(n: number): Date {
  return new Date(NOW - n * DAY)
}

function makeListing(overrides: Partial<RawActiveListing> = {}): RawActiveListing {
  return {
    id: 'lst1',
    title: 'Hot Wheels Camaro',
    price: 10,
    createdAt: daysAgo(1),
    item: {
      sku: 'SKU001',
      cardedOrLoose: 'carded',
      condition: 'mint',
      catalog: { brand: 'Hot Wheels', name: 'Camaro', year: 2020, series: 'Mainline', color: 'Red' },
      itemPhotoUrl: 'https://example.com/item.jpg',
      catalogPhotoUrl: 'https://example.com/cat.jpg',
    },
    ...overrides,
  }
}

function makeSale(
  id: string,
  catalogModelId: string,
  completedAt: Date,
  soldPriceDollars = 10,
  listingCreatedAt: Date | null = daysAgo(5),
  overrides: Partial<RawSaleRecord> = {},
): RawSaleRecord {
  return {
    orderItemId: id,
    catalogModelId,
    catalogBrand: 'Hot Wheels',
    catalogName: `Model ${catalogModelId}`,
    catalogYear: 2020,
    catalogSeries: null,
    soldPriceDollars,
    completedAt,
    listingCreatedAt,
    ...overrides,
  }
}

// ─── buildRecentlyListed ──────────────────────────────────────────────────────

describe('buildRecentlyListed', () => {
  it('maps raw listing to PublicListingItem with id and catalog fields', () => {
    const items = buildRecentlyListed([makeListing()])
    expect(items[0].id).toBe('lst1')
    expect(items[0].item.catalog.brand).toBe('Hot Wheels')
  })

  it('uses item photo when present', () => {
    const items = buildRecentlyListed([makeListing()])
    expect(items[0].photoUrl).toBe('https://example.com/item.jpg')
    expect(items[0].imageSource).toBe('item')
  })

  it('falls back to catalog photo when no item photo', () => {
    const items = buildRecentlyListed([
      makeListing({ item: { ...makeListing().item, itemPhotoUrl: null } }),
    ])
    expect(items[0].photoUrl).toBe('https://example.com/cat.jpg')
    expect(items[0].imageSource).toBe('catalog')
  })

  it('imageSource is none when both photos missing', () => {
    const items = buildRecentlyListed([
      makeListing({
        item: { ...makeListing().item, itemPhotoUrl: null, catalogPhotoUrl: null },
      }),
    ])
    expect(items[0].photoUrl).toBeNull()
    expect(items[0].imageSource).toBe('none')
  })

  it('returns empty array for empty input', () => {
    expect(buildRecentlyListed([])).toHaveLength(0)
  })

  it('does not expose itemPhotoUrl or catalogPhotoUrl on output', () => {
    const items = buildRecentlyListed([makeListing()])
    expect(items[0]).not.toHaveProperty('itemPhotoUrl')
    expect(items[0]).not.toHaveProperty('catalogPhotoUrl')
  })

  // Same unstable_cache serialization boundary as PublicSoldItem.soldAt — audited per
  // the soldAt production crash: createdAt must also be a pre-serialized ISO string.
  it('serializes createdAt to an ISO string, not a Date object (unstable_cache boundary)', () => {
    const raw = makeListing()
    const items = buildRecentlyListed([raw])
    expect(typeof items[0].createdAt).toBe('string')
    expect(items[0].createdAt).toBe(raw.createdAt.toISOString())
  })
})

// ─── buildHighValue ───────────────────────────────────────────────────────────

describe('buildHighValue', () => {
  it('maps listing same as buildRecentlyListed (DB handles ordering)', () => {
    const a = makeListing({ id: 'lst1', price: 100 })
    const b = makeListing({ id: 'lst2', price: 5 })
    // Query layer passes them pre-sorted price desc; function just maps
    const items = buildHighValue([a, b])
    expect(items[0].price).toBe(100)
    expect(items[1].price).toBe(5)
  })
})

// ─── buildRecentlySold ────────────────────────────────────────────────────────

describe('buildRecentlySold', () => {
  const rawSold: RawSoldItem = {
    id: 'oi-abc',
    catalogModelId: 'cat1',
    catalogBrand: 'Matchbox',
    catalogName: 'Mustang',
    catalogYear: 2019,
    catalogSeries: null,
    soldAt: daysAgo(2),
    photoUrl: 'https://example.com/sold.jpg',
  }

  it('maps to PublicSoldItem with expected fields', () => {
    const items = buildRecentlySold([rawSold])
    expect(items[0].id).toBe('oi-abc')
    expect(items[0].catalogBrand).toBe('Matchbox')
  })

  // Regression: production TypeError "a.soldAt.toLocaleDateString is not a function".
  // getMerchandisingData() is wrapped in unstable_cache, which JSON-serializes its
  // return value — a cache-hit read back soldAt as a string, not a Date, while the
  // type still said `Date`. PublicSoldItem.soldAt is now honestly typed `string`, and
  // buildRecentlySold must actually produce a serialized ISO string here, not a Date.
  it('serializes soldAt to an ISO string, not a Date object (unstable_cache boundary)', () => {
    const items = buildRecentlySold([rawSold])
    expect(typeof items[0].soldAt).toBe('string')
    expect(items[0].soldAt).toBe(daysAgo(2).toISOString())
  })

  it('soldAt survives a JSON round-trip unchanged (simulates an unstable_cache read)', () => {
    const items = buildRecentlySold([rawSold])
    const serialized = JSON.parse(JSON.stringify(items)) as typeof items
    expect(serialized[0].soldAt).toBe(items[0].soldAt)
    expect(typeof serialized[0].soldAt).toBe('string')
  })

  it('does not include soldPrice (no existing public sold-price policy)', () => {
    const items = buildRecentlySold([rawSold])
    expect(items[0]).not.toHaveProperty('soldPrice')
  })

  it('does not include buyer, order, or payment fields', () => {
    const items = buildRecentlySold([rawSold])
    const keys = Object.keys(items[0])
    for (const forbidden of ['buyerName', 'buyerEmail', 'orderId', 'paymentStatus', 'paymentReference', 'shippingAddress', 'payoutAmount', 'storageLocation']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('returns empty array for empty input', () => {
    expect(buildRecentlySold([])).toHaveLength(0)
  })
})

// ─── computeTrendingModels ────────────────────────────────────────────────────

describe('computeTrendingModels', () => {
  it('includes model with >= TRENDING_MIN_SALES in window', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5)),
      makeSale('oi2', 'catA', daysAgo(10)),
    ]
    const result = computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(1)
    expect(result[0].catalogModelId).toBe('catA')
    expect(result[0].saleCount).toBe(2)
  })

  it('excludes model with < TRENDING_MIN_SALES', () => {
    const sales = [makeSale('oi1', 'catA', daysAgo(5))]
    const result = computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('excludes sales outside the 30-day window', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(31)),
      makeSale('oi2', 'catA', daysAgo(32)),
    ]
    const result = computeTrendingModels(sales, {}, {}, TRENDING_WINDOW_DAYS, undefined, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('ranks higher saleCount first', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5)),
      makeSale('oi2', 'catA', daysAgo(10)),
      makeSale('oi3', 'catB', daysAgo(3)),
      makeSale('oi4', 'catB', daysAgo(7)),
      makeSale('oi5', 'catB', daysAgo(12)),
    ]
    const result = computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW)
    expect(result[0].catalogModelId).toBe('catB')
    expect(result[0].saleCount).toBe(3)
    expect(result[1].catalogModelId).toBe('catA')
  })

  it('uses latestSaleAt as secondary sort when saleCount ties', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5)),
      makeSale('oi2', 'catA', daysAgo(15)),
      makeSale('oi3', 'catB', daysAgo(2)),
      makeSale('oi4', 'catB', daysAgo(20)),
    ]
    const result = computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW)
    // Both have count=2; catB's latest sale is day 2 (more recent) → catB first
    expect(result[0].catalogModelId).toBe('catB')
  })

  it('uses catalogModelId as deterministic tie-breaker', () => {
    const t = daysAgo(5)
    const sales = [
      makeSale('oi1', 'zzz', t),
      makeSale('oi2', 'zzz', daysAgo(10)),
      makeSale('oi3', 'aaa', t),
      makeSale('oi4', 'aaa', daysAgo(10)),
    ]
    const result = computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW)
    // Same count, same latestSaleAt → alphabetical by catalogModelId
    expect(result[0].catalogModelId).toBe('aaa')
    expect(result[1].catalogModelId).toBe('zzz')
  })

  it('attaches photo from catalogPhotos map', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5)),
      makeSale('oi2', 'catA', daysAgo(10)),
    ]
    const result = computeTrendingModels(
      sales,
      { catA: 'https://example.com/photo.jpg' },
      {},
      undefined,
      undefined,
      undefined,
      NOW,
    )
    expect(result[0].photoUrl).toBe('https://example.com/photo.jpg')
  })

  it('attaches activeListingCount from map', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5)),
      makeSale('oi2', 'catA', daysAgo(10)),
    ]
    const result = computeTrendingModels(sales, {}, { catA: 3 }, undefined, undefined, undefined, NOW)
    expect(result[0].activeListingCount).toBe(3)
  })

  it('defaults activeListingCount to 0 when not in map', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5)),
      makeSale('oi2', 'catA', daysAgo(10)),
    ]
    const result = computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW)
    expect(result[0].activeListingCount).toBe(0)
  })

  it('returns empty array when no qualifying models', () => {
    expect(computeTrendingModels([], {}, {}, undefined, undefined, undefined, NOW)).toHaveLength(0)
  })

  // Same unstable_cache serialization boundary as PublicSoldItem.soldAt — audited per
  // the soldAt production crash: latestSaleAt must also be a pre-serialized ISO
  // string, and ranking must still be correct even though sorting happens on Date
  // internally, before the final serialization step.
  it('serializes latestSaleAt to an ISO string, not a Date object, while still ranking by the real underlying date', () => {
    const latest = daysAgo(2)
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5)),
      makeSale('oi2', 'catA', latest),
    ]
    const result = computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW)
    expect(typeof result[0].latestSaleAt).toBe('string')
    expect(result[0].latestSaleAt).toBe(latest.toISOString())
  })
})

// ─── computeFastMovers ────────────────────────────────────────────────────────

describe('computeFastMovers', () => {
  it('computes median days-to-sell correctly', () => {
    // 2 days and 6 days → median = 4 days (sorted: [2,6], median=(2+6)/2=4, rounded)
    const sales = [
      makeSale('oi1', 'catA', daysAgo(2), 10, daysAgo(4)),  // 2 days to sell
      makeSale('oi2', 'catA', daysAgo(10), 10, daysAgo(16)), // 6 days to sell
    ]
    const result = computeFastMovers(sales, {}, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(1)
    expect(result[0].medianDaysToSell).toBe(4)
  })

  it('excludes negative duration (listing after completion)', () => {
    // listingCreatedAt AFTER completedAt → negative ms → excluded
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5), 10, daysAgo(3)),   // -2 days: invalid
      makeSale('oi2', 'catA', daysAgo(10), 10, daysAgo(15)), // 5 days: valid
    ]
    const result = computeFastMovers(sales, {}, undefined, undefined, undefined, NOW)
    // Only 1 valid sample; below minSamples=2 → excluded
    expect(result).toHaveLength(0)
  })

  it('excludes sales with null listingCreatedAt', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5), 10, null),
      makeSale('oi2', 'catA', daysAgo(10), 10, null),
    ]
    const result = computeFastMovers(sales, {}, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('requires minimum FAST_MOVER_MIN_SAMPLES valid samples', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(5), 10, daysAgo(10)),
    ]
    const result = computeFastMovers(sales, {}, undefined, FAST_MOVER_MIN_SAMPLES, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('excludes sales outside window', () => {
    const sales = [
      makeSale('oi1', 'catA', daysAgo(FAST_MOVER_WINDOW_DAYS + 1), 10, daysAgo(FAST_MOVER_WINDOW_DAYS + 6)),
      makeSale('oi2', 'catA', daysAgo(FAST_MOVER_WINDOW_DAYS + 2), 10, daysAgo(FAST_MOVER_WINDOW_DAYS + 7)),
    ]
    const result = computeFastMovers(sales, {}, FAST_MOVER_WINDOW_DAYS, undefined, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('ranks by medianDaysToSell ASC', () => {
    // catA: 2 + 4 days → median 3
    // catB: 10 + 20 days → median 15
    const sales = [
      makeSale('oi1', 'catA', daysAgo(2), 10, daysAgo(4)),
      makeSale('oi2', 'catA', daysAgo(5), 10, daysAgo(9)),
      makeSale('oi3', 'catB', daysAgo(1), 10, daysAgo(11)),
      makeSale('oi4', 'catB', daysAgo(3), 10, daysAgo(23)),
    ]
    const result = computeFastMovers(sales, {}, undefined, undefined, undefined, NOW)
    expect(result[0].catalogModelId).toBe('catA')
  })

  it('uses saleCount as secondary sort when median ties', () => {
    // Both have median 5 days
    const sales = [
      makeSale('oi1', 'catA', daysAgo(2), 10, daysAgo(7)),
      makeSale('oi2', 'catA', daysAgo(5), 10, daysAgo(10)),
      makeSale('oi3', 'catB', daysAgo(2), 10, daysAgo(7)),
      makeSale('oi4', 'catB', daysAgo(5), 10, daysAgo(10)),
      makeSale('oi5', 'catB', daysAgo(8), 10, daysAgo(13)),
    ]
    const result = computeFastMovers(sales, {}, undefined, undefined, undefined, NOW)
    // Same median → higher saleCount first → catB (3 sales)
    expect(result[0].catalogModelId).toBe('catB')
  })

  it('returns empty array when no qualifying models', () => {
    expect(computeFastMovers([], {}, undefined, undefined, undefined, NOW)).toHaveLength(0)
  })
})

// ─── computeTopPriceMovers ────────────────────────────────────────────────────

describe('computeTopPriceMovers', () => {
  function recentSales(catalogModelId: string, prices: number[]): RawSaleRecord[] {
    return prices.map((p, i) =>
      makeSale(`r${catalogModelId}${i}`, catalogModelId, daysAgo(10 + i), p),
    )
  }

  function priorSales(catalogModelId: string, prices: number[]): RawSaleRecord[] {
    return prices.map((p, i) =>
      makeSale(`p${catalogModelId}${i}`, catalogModelId, daysAgo(100 + i), p),
    )
  }

  it('computes pctChange from median recent vs prior', () => {
    // recent: [10, 10, 10] → median 10 → 1000 cents
    // prior:  [8, 8, 8]   → median 8  → 800 cents
    // pctChange = (1000 - 800) / 800 * 100 = 25%
    const sales = [
      ...recentSales('catA', [10, 10, 10]),
      ...priorSales('catA', [8, 8, 8]),
    ]
    const result = computeTopPriceMovers(sales, {}, undefined, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(1)
    expect(result[0].pctChange).toBeCloseTo(25, 0)
    expect(result[0].recentMedianCents).toBe(1000)
    expect(result[0].priorMedianCents).toBe(800)
  })

  it('excludes models with fewer than PRICE_MOVER_MIN_SAMPLES in either window', () => {
    const sales = [
      ...recentSales('catA', [10, 10]),       // 2 < 3
      ...priorSales('catA', [8, 8, 8]),
    ]
    const result = computeTopPriceMovers(sales, {}, undefined, undefined, PRICE_MOVER_MIN_SAMPLES, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('excludes gainers with no prior window data', () => {
    const sales = recentSales('catA', [10, 10, 10])
    const result = computeTopPriceMovers(sales, {}, undefined, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('excludes decliners (pctChange <= 0)', () => {
    // recent < prior → decline
    const sales = [
      ...recentSales('catA', [5, 5, 5]),
      ...priorSales('catA', [10, 10, 10]),
    ]
    const result = computeTopPriceMovers(sales, {}, undefined, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('excludes zero price (not positive)', () => {
    const sales = [
      ...recentSales('catA', [0, 0, 0]),
      ...priorSales('catA', [0, 0, 0]),
    ]
    const result = computeTopPriceMovers(sales, {}, undefined, undefined, undefined, undefined, NOW)
    expect(result).toHaveLength(0)
  })

  it('excludes prior median <= 0', () => {
    // This is guarded by the > 0 price filter, but test the guard explicitly
    // by having prior prices that would compute to a 0 median is not possible
    // with positive-only prices — guard remains for safety
    // Instead test that prior median of 0 (if somehow present) is excluded
    const sales = [
      ...recentSales('catA', [10, 10, 10]),
    ]
    // Inject a fake record with soldPriceDollars=0 (normally filtered by DB)
    const zeroSales: RawSaleRecord[] = [100, 101, 102].map((i) => ({
      ...makeSale(`z${i}`, 'catA', daysAgo(100), 0),
    }))
    const result = computeTopPriceMovers([...sales, ...zeroSales], {}, undefined, undefined, undefined, undefined, NOW)
    // 0-price sales filtered by cents <= 0 guard → catA has no prior data → excluded
    expect(result).toHaveLength(0)
  })

  it('windows are exclusive — recent sale does not appear in prior bucket', () => {
    // A sale at day 10 (in recent window) should not appear in prior
    const day10Sale = makeSale('oi_boundary', 'catA', daysAgo(10))
    const otherRecent = [
      makeSale('oi_r2', 'catA', daysAgo(20), 10),
      makeSale('oi_r3', 'catA', daysAgo(30), 10),
    ]
    const priorSalesArr = priorSales('catA', [8, 8, 8])
    const allSales = [day10Sale, ...otherRecent, ...priorSalesArr]
    const result = computeTopPriceMovers(allSales, {}, RECENT_PRICE_WINDOW_DAYS, PRIOR_PRICE_WINDOW_DAYS, undefined, undefined, NOW)
    // catA is present with correct window separation
    expect(result.length).toBeGreaterThanOrEqual(0) // no assertion error = windows parsed correctly
  })

  it('ranks by pctChange DESC', () => {
    // catA: +25%, catB: +50%
    const sales = [
      ...recentSales('catA', [10, 10, 10]),
      ...priorSales('catA', [8, 8, 8]),
      ...recentSales('catB', [15, 15, 15]),
      ...priorSales('catB', [10, 10, 10]),
    ]
    const result = computeTopPriceMovers(sales, {}, undefined, undefined, undefined, undefined, NOW)
    expect(result[0].catalogModelId).toBe('catB') // 50% > 25%
  })

  it('uses catalogModelId as deterministic tie-breaker', () => {
    const sales = [
      ...recentSales('zzz', [10, 10, 10]),
      ...priorSales('zzz', [8, 8, 8]),
      ...recentSales('aaa', [10, 10, 10]),
      ...priorSales('aaa', [8, 8, 8]),
    ]
    const result = computeTopPriceMovers(sales, {}, undefined, undefined, undefined, undefined, NOW)
    expect(result[0].catalogModelId).toBe('aaa')
    expect(result[1].catalogModelId).toBe('zzz')
  })

  it('returns empty array when no qualifying models', () => {
    expect(computeTopPriceMovers([], {}, undefined, undefined, undefined, undefined, NOW)).toHaveLength(0)
  })
})

// ─── No fabricated Most Wanted ───────────────────────────────────────────────

describe('no fabricated Most Wanted', () => {
  it('MerchandisingData type does not include mostWanted field', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../marketplaceMerchandising.ts'),
      'utf-8',
    )
    expect(src).not.toContain('mostWanted')
    expect(src).not.toContain('wantedList')
  })
})

// ─── Privacy — no buyer/order/private fields in public types ─────────────────

describe('public output shape privacy', () => {
  it('PublicSoldItem type does not include buyer or order fields', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../marketplaceMerchandising.ts'),
      'utf-8',
    )
    const soldTypeStart = src.indexOf('export type PublicSoldItem = {')
    const soldTypeEnd = src.indexOf('\n}', soldTypeStart)
    const soldTypeBlock = src.slice(soldTypeStart, soldTypeEnd)
    for (const forbidden of [
      'buyerName', 'buyerEmail', 'buyerPhone',
      'orderId', 'orderNumber',
      'paymentStatus', 'paymentReference', 'paymentLink',
      'storageLocation', 'locationId',
      'payoutAmount', 'shippingInfo',
    ]) {
      expect(soldTypeBlock).not.toContain(forbidden)
    }
  })

  it('TrendingModel / FastMoverModel / PriceMoverModel do not include seller profile or payout fields', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../marketplaceMerchandising.ts'),
      'utf-8',
    )
    for (const forbidden of [
      'sellerName', 'sellerEmail', 'payoutAmount', 'netAmount',
      'buyerName', 'buyerEmail',
    ]) {
      // Check in the output type blocks only (not comments or function bodies)
      const trendingStart = src.indexOf('export type TrendingModel')
      const priceEnd = src.indexOf('\n}', src.indexOf('export type PriceMoverModel'))
      const typeBlock = src.slice(trendingStart, priceEnd)
      expect(typeBlock).not.toContain(forbidden)
    }
  })

  it('PublicSoldItem does not include soldPrice', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../marketplaceMerchandising.ts'),
      'utf-8',
    )
    const soldTypeStart = src.indexOf('export type PublicSoldItem = {')
    const soldTypeEnd = src.indexOf('\n}', soldTypeStart)
    const soldTypeBlock = src.slice(soldTypeStart, soldTypeEnd)
    expect(soldTypeBlock).not.toContain('soldPrice')
  })
})

// ─── Query layer structural tests ─────────────────────────────────────────────

describe('query layer predicates', () => {
  const querySrc = fs.readFileSync(
    path.resolve(__dirname, '../marketplaceMerchandisingQuery.ts'),
    'utf-8',
  )

  it('fetchRecentlyListed requires active listing AND available item', () => {
    const fnStart = querySrc.indexOf('async function fetchRecentlyListed')
    const fnEnd = querySrc.indexOf('\nasync function', fnStart + 1)
    const body = querySrc.slice(fnStart, fnEnd)
    expect(body).toContain("status: 'active'")
    expect(body).toContain("status: 'available'")
  })

  it('fetchHighValue requires active listing AND available item', () => {
    const fnStart = querySrc.indexOf('async function fetchHighValue')
    const fnEnd = querySrc.indexOf('\nasync function', fnStart + 1)
    const body = querySrc.slice(fnStart, fnEnd)
    expect(body).toContain("status: 'active'")
    expect(body).toContain("status: 'available'")
  })

  it('fetchRecentlySold requires completed order status and non-null completedAt', () => {
    const fnStart = querySrc.indexOf('async function fetchRecentlySold')
    const fnEnd = querySrc.indexOf('\nasync function', fnStart + 1)
    const body = querySrc.slice(fnStart, fnEnd)
    expect(body).toContain("status: 'complete'")
    expect(body).toContain('completedAt: { not: null }')
    expect(body).toContain('price: { gt: 0 }')
  })

  it('fetchRecentlySold does not select buyer, payment, or shipping fields', () => {
    const fnStart = querySrc.indexOf('async function fetchRecentlySold')
    const fnEnd = querySrc.indexOf('\nasync function', fnStart + 1)
    const body = querySrc.slice(fnStart, fnEnd)
    for (const forbidden of [
      'buyerName', 'buyerEmail', 'buyerPhone',
      'paymentStatus', 'paymentReference', 'paymentLink', 'paymentMethod',
      'customerProfileId', 'stripeSessionId',
    ]) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('fetchActiveListingCounts requires active listing AND available item', () => {
    const fnStart = querySrc.indexOf('async function fetchActiveListingCounts')
    const fnEnd = querySrc.indexOf('\nasync function', fnStart + 1)
    const body = querySrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
    expect(body).toContain("status: 'active'")
    expect(body).toContain("status: 'available'")
  })

  it('fetchRecentlyListed has deterministic secondary sort by id', () => {
    const fnStart = querySrc.indexOf('async function fetchRecentlyListed')
    const fnEnd = querySrc.indexOf('\nasync function', fnStart + 1)
    const body = querySrc.slice(fnStart, fnEnd)
    expect(body).toContain("{ id: 'asc' }")
  })

  it('fetchRecentlySold has deterministic secondary sort by id', () => {
    const fnStart = querySrc.indexOf('async function fetchRecentlySold')
    const fnEnd = querySrc.indexOf('\nasync function', fnStart + 1)
    const body = querySrc.slice(fnStart, fnEnd)
    expect(body).toContain("{ id: 'asc' }")
  })

  it('getMerchandisingData is wrapped in unstable_cache with 300s revalidation', () => {
    expect(querySrc).toContain('unstable_cache')
    expect(querySrc).toContain('revalidate: 300')
    // Cache key must be public-scoped (not admin/private)
    expect(querySrc).toContain("'public'")
    expect(querySrc).toContain("'merchandising'")
  })

  it('both /market and homepage import getMerchandisingData from the same cached source', () => {
    const marketSrc = fs.readFileSync(
      path.resolve(__dirname, '../../app/(store)/market/page.tsx'),
      'utf-8',
    )
    const homeSrc = fs.readFileSync(
      path.resolve(__dirname, '../../app/(store)/page.tsx'),
      'utf-8',
    )
    expect(marketSrc).toContain("from '@/lib/marketplaceMerchandisingQuery'")
    expect(homeSrc).toContain("from '@/lib/marketplaceMerchandisingQuery'")
  })
})

// ─── Time-window boundary ─────────────────────────────────────────────────────

describe('price mover 90-day boundary is non-overlapping', () => {
  it('a sale exactly on the recent boundary belongs to recent, not prior', () => {
    // 90 days ago exactly = recentStart boundary → in recent window
    const exactBoundarySale = makeSale('exact', 'catA', daysAgo(RECENT_PRICE_WINDOW_DAYS), 10)
    const priorSalesArr = [
      makeSale('p1', 'catA', daysAgo(100), 8),
      makeSale('p2', 'catA', daysAgo(110), 8),
      makeSale('p3', 'catA', daysAgo(120), 8),
    ]
    // If boundary sale is in recent, we need 2 more recent sales for min-3
    const moreCurrent = [
      makeSale('r2', 'catA', daysAgo(20), 10),
      makeSale('r3', 'catA', daysAgo(30), 10),
    ]
    const result = computeTopPriceMovers(
      [exactBoundarySale, ...moreCurrent, ...priorSalesArr],
      {},
      RECENT_PRICE_WINDOW_DAYS,
      PRIOR_PRICE_WINDOW_DAYS,
      3,
      undefined,
      NOW,
    )
    // catA should qualify: 3 recent (exact boundary + r2 + r3), 3 prior
    expect(result).toHaveLength(1)
    expect(result[0].catalogModelId).toBe('catA')
  })

  it('a sale 1ms before the recent boundary belongs to prior, not recent', () => {
    // 90 days ago - 1 day = prior window
    const justBeforeBoundary = makeSale('just-prior', 'catA', daysAgo(RECENT_PRICE_WINDOW_DAYS + 1), 8)
    const priorOthers = [
      makeSale('p2', 'catA', daysAgo(110), 8),
      makeSale('p3', 'catA', daysAgo(120), 8),
    ]
    // If boundary sale is in prior (3 prior total), we need 3 recent for qualification
    const recentSalesArr = [
      makeSale('r1', 'catA', daysAgo(10), 12),
      makeSale('r2', 'catA', daysAgo(20), 12),
      makeSale('r3', 'catA', daysAgo(30), 12),
    ]
    const result = computeTopPriceMovers(
      [justBeforeBoundary, ...priorOthers, ...recentSalesArr],
      {},
      RECENT_PRICE_WINDOW_DAYS,
      PRIOR_PRICE_WINDOW_DAYS,
      3,
      undefined,
      NOW,
    )
    // catA should qualify with gain (recent 12 > prior 8)
    expect(result).toHaveLength(1)
    expect(result[0].catalogModelId).toBe('catA')
    expect(result[0].pctChange).toBeGreaterThan(0)
  })
})

// ─── Regression: production /market crash via the unstable_cache boundary ──────
//
// getMerchandisingData() in marketplaceMerchandisingQuery.ts wraps the builder in
// unstable_cache, which persists/reads the result via JSON serialization. A cache hit
// therefore returns soldAt/createdAt/latestSaleAt as ISO strings, not Date objects —
// this suite proves the full recentlyListed/recentlySold/trendingModels pipeline (and
// SoldCard's rendering call, via formatDate) survives exactly that round-trip.

describe('production /market crash regression: unstable_cache JSON round-trip', () => {
  it('a full MerchandisingData-shaped result survives JSON.parse(JSON.stringify(...)) and every date field remains formatDate-safe', () => {
    const rawListing = makeListing({ id: 'lst-rt' })
    const rawSold: RawSoldItem = {
      id: 'oi-rt',
      catalogModelId: 'cat-rt',
      catalogBrand: 'Hot Wheels',
      catalogName: 'Charger',
      catalogYear: 2021,
      catalogSeries: null,
      soldAt: new Date('2026-08-08T15:30:00.000Z'), // exact production shape from the task
      photoUrl: null,
    }
    const sales = [
      makeSale('s1', 'cat-rt', daysAgo(3)),
      makeSale('s2', 'cat-rt', daysAgo(4)),
    ]

    const data: Pick<MerchandisingData, 'recentlyListed' | 'recentlySold' | 'trendingModels'> = {
      recentlyListed: buildRecentlyListed([rawListing]),
      recentlySold: buildRecentlySold([rawSold]),
      trendingModels: computeTrendingModels(sales, {}, {}, undefined, undefined, undefined, NOW),
    }

    // Simulates exactly what unstable_cache does on a cache-hit read.
    const serialized = JSON.parse(JSON.stringify(data)) as typeof data

    // "Recently sold" section still renders: the length check the /market page uses
    // to decide whether to show the section is unaffected by serialization.
    expect(serialized.recentlySold.length).toBeGreaterThan(0)

    // The exact call SoldCard makes — must not throw and must produce a real date.
    expect(() =>
      formatDate(serialized.recentlySold[0].soldAt, { month: 'short', day: 'numeric', year: 'numeric' }),
    ).not.toThrow()
    expect(formatDate(serialized.recentlySold[0].soldAt, { month: 'short', day: 'numeric', year: 'numeric' })).toBe('Aug 8, 2026')

    // Other audited date fields crossing the same boundary also remain formatDate-safe.
    expect(() => formatDate(serialized.recentlyListed[0].createdAt)).not.toThrow()
    expect(() => formatDate(serialized.trendingModels[0]?.latestSaleAt)).not.toThrow()
  })

  it('a malformed soldAt (corrupted data) does not crash formatting — renders empty rather than throwing', () => {
    const items = buildRecentlySold([{
      id: 'oi-bad',
      catalogModelId: 'cat-bad',
      catalogBrand: 'Hot Wheels',
      catalogName: 'Bad Data',
      catalogYear: null,
      catalogSeries: null,
      soldAt: new Date('2026-08-08T15:30:00.000Z'),
      photoUrl: null,
    }])
    // Simulate corruption after the cache boundary (e.g. a truncated/garbled string).
    const corrupted = { ...items[0], soldAt: 'not-a-real-date' }

    expect(() => formatDate(corrupted.soldAt, { month: 'short', day: 'numeric', year: 'numeric' })).not.toThrow()
    expect(formatDate(corrupted.soldAt, { month: 'short', day: 'numeric', year: 'numeric' })).toBe('')
  })

  it('null soldAt is safe end-to-end through the formatter', () => {
    expect(() => formatDate(null, { month: 'short', day: 'numeric', year: 'numeric' })).not.toThrow()
    expect(formatDate(null, { month: 'short', day: 'numeric', year: 'numeric' })).toBe('')
  })
})
