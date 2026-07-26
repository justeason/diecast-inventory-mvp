import { describe, it, expect } from 'vitest'
import {
  computeEstimate,
  median,
  percentile,
  deriveConfidence,
  MIN_WINDOW_COMPS,
  type TargetModel,
  type ComparableSale,
  type ComparableRecord,
} from '@/lib/resaleEstimator'

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = new Date('2025-06-01T00:00:00Z').getTime()
const RECENT = new Date('2025-01-01T00:00:00Z')       // within 24 months of NOW
const OLD = new Date('2022-01-01T00:00:00Z')            // outside 24 months of NOW

function target(overrides: Partial<TargetModel> = {}): TargetModel {
  return {
    id: 'model-A',
    brand: 'Hot Wheels',
    name: 'Twin Mill',
    series: 'ZAMAC',
    year: 2022,
    ...overrides,
  }
}

function sale(overrides: Partial<ComparableSale> = {}): ComparableSale {
  return {
    orderItemId: 'oi-1',
    orderId: 'ord-1',
    catalogModelId: 'model-A',
    catalogBrand: 'Hot Wheels',
    catalogName: 'Twin Mill',
    catalogSeries: 'ZAMAC',
    catalogYear: 2022,
    soldPriceCents: 1000,
    listingCreatedAt: new Date('2025-01-01T00:00:00Z'),
    orderCompletedAt: RECENT,
    sku: 'SKU-001',
    ...overrides,
  }
}

function makeSales(
  count: number,
  base: Partial<ComparableSale> = {},
  priceCents: number[] = [],
): ComparableSale[] {
  return Array.from({ length: count }, (_, i) => ({
    ...sale({ ...base, orderItemId: `oi-${i + 1}`, sku: `SKU-${i + 1}` }),
    soldPriceCents: priceCents[i] ?? 1000 + i * 100,
  }))
}

// ── median ────────────────────────────────────────────────────────────────────

describe('median', () => {
  it('odd count returns middle element', () => {
    expect(median([1, 3, 5])).toBe(3)
    expect(median([100, 200, 300, 400, 500])).toBe(300)
  })

  it('even count returns rounded average of two middle elements', () => {
    expect(median([1, 2, 3, 4])).toBe(Math.round((2 + 3) / 2))
    expect(median([100, 200])).toBe(150)
    expect(median([100, 201])).toBe(151)
  })

  it('single element returns that element', () => {
    expect(median([42])).toBe(42)
  })

  it('throws on empty array', () => {
    expect(() => median([])).toThrow()
  })
})

// ── percentile ────────────────────────────────────────────────────────────────

describe('percentile', () => {
  it('p25 on 4 elements is floor(0.25*3)=0 → min', () => {
    expect(percentile([100, 200, 300, 400], 0.25)).toBe(100)
  })

  it('p75 on 4 elements is floor(0.75*3)=2 → third element', () => {
    expect(percentile([100, 200, 300, 400], 0.75)).toBe(300)
  })

  it('p50 is same as median for odd count', () => {
    const arr = [1, 3, 5]
    expect(percentile(arr, 0.5)).toBe(3)
  })

  it('single element returns that element for any p', () => {
    expect(percentile([99], 0.25)).toBe(99)
    expect(percentile([99], 0.75)).toBe(99)
  })

  it('throws on empty array', () => {
    expect(() => percentile([], 0.5)).toThrow()
  })
})

// ── deriveConfidence ──────────────────────────────────────────────────────────

describe('deriveConfidence', () => {
  it('0 comps → insufficient', () => {
    expect(deriveConfidence(0, 'exact', false)).toBe('insufficient')
  })

  it('1 comp exact → low', () => {
    expect(deriveConfidence(1, 'exact', false)).toBe('low')
  })

  it('4 comps exact → low', () => {
    expect(deriveConfidence(4, 'exact', false)).toBe('low')
  })

  it('5 comps exact → medium', () => {
    expect(deriveConfidence(5, 'exact', false)).toBe('medium')
  })

  it('10 comps exact → high', () => {
    expect(deriveConfidence(10, 'exact', false)).toBe('high')
  })

  it('10 comps model_family downgrades one level → medium', () => {
    expect(deriveConfidence(10, 'model_family', false)).toBe('medium')
  })

  it('10 comps series_year downgrades one level → medium', () => {
    expect(deriveConfidence(10, 'series_year', false)).toBe('medium')
  })

  it('10 comps brand_series downgrades two levels → low', () => {
    expect(deriveConfidence(10, 'brand_series', false)).toBe('low')
  })

  it('extendedHistoryUsed downgrades one additional level', () => {
    expect(deriveConfidence(10, 'exact', true)).toBe('medium')
  })

  it('cannot go below insufficient', () => {
    expect(deriveConfidence(1, 'brand_series', true)).toBe('insufficient')
  })
})

// ── computeEstimate — exact match ─────────────────────────────────────────────

describe('computeEstimate — exact match', () => {
  it('uses exact match sales for estimate', () => {
    const t = target()
    const sales = makeSales(5, {}, [1000, 1100, 1200, 1300, 1400])
    const result = computeEstimate(t, sales, NOW)
    expect(result.matchLevel).toBe('exact')
    expect(result.comparableCount).toBe(5)
    expect(result.estimatedPrice).toBe(1200)
  })

  it('excludes non-matching models at exact level', () => {
    const t = target({ id: 'model-B' })
    const sales = makeSales(5)
    const result = computeEstimate(t, sales, NOW)
    // model-A sales won't exact-match model-B
    // but brand+name matches → model_family
    expect(result.matchLevel).toBe('model_family')
  })
})

// ── computeEstimate — fallback hierarchy ──────────────────────────────────────

describe('computeEstimate — fallback hierarchy', () => {
  it('falls back to model_family when no exact match', () => {
    const t = target({ id: 'model-B' })
    const sales = makeSales(5, { catalogModelId: 'model-A' })
    const result = computeEstimate(t, sales, NOW)
    expect(result.matchLevel).toBe('model_family')
  })

  it('falls back to series_year when brand+name differ', () => {
    const t = target({ id: 'model-B', name: 'Camaro' })
    const sales = makeSales(5, {
      catalogModelId: 'model-C',
      catalogName: 'Mustang',
      catalogSeries: 'ZAMAC',
      catalogYear: 2022,
    })
    const result = computeEstimate(t, sales, NOW)
    expect(result.matchLevel).toBe('series_year')
  })

  it('falls back to brand_series when series matches but year differs', () => {
    const t = target({ id: 'model-B', name: 'Camaro', year: 2021 })
    const sales = makeSales(5, {
      catalogModelId: 'model-C',
      catalogName: 'Mustang',
      catalogSeries: 'ZAMAC',
      catalogYear: 2022,
    })
    const result = computeEstimate(t, sales, NOW)
    expect(result.matchLevel).toBe('brand_series')
  })

  it('returns insufficient when nothing matches', () => {
    const t = target({ id: 'model-Z', brand: 'Matchbox', name: 'Unknown', series: null, year: null })
    const sales = makeSales(5) // catalogModelId: 'model-A', brand: 'Hot Wheels'
    const result = computeEstimate(t, sales, NOW)
    expect(result.matchLevel).toBe('insufficient')
    expect(result.estimatedPrice).toBeNull()
    expect(result.comparableCount).toBe(0)
  })
})

// ── computeEstimate — no comparables ──────────────────────────────────────────

describe('computeEstimate — no comparables', () => {
  it('returns null prices and insufficient confidence', () => {
    const result = computeEstimate(target(), [], NOW)
    expect(result.estimatedPrice).toBeNull()
    expect(result.lowPrice).toBeNull()
    expect(result.highPrice).toBeNull()
    expect(result.estimatedDaysToSell).toBeNull()
    expect(result.comparableCount).toBe(0)
    expect(result.confidence).toBe('insufficient')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('does not return $0.00 as estimate', () => {
    const result = computeEstimate(target(), [], NOW)
    expect(result.estimatedPrice).toBeNull()
  })
})

// ── computeEstimate — one comparable ─────────────────────────────────────────

describe('computeEstimate — one comparable', () => {
  it('returns the single observation as estimate with low confidence', () => {
    const result = computeEstimate(target(), [sale({ soldPriceCents: 1500 })], NOW)
    expect(result.estimatedPrice).toBe(1500)
    expect(result.lowPrice).toBe(1500)
    expect(result.highPrice).toBe(1500)
    expect(result.confidence).toBe('low')
    expect(result.comparableCount).toBe(1)
    expect(result.warnings.some((w) => w.includes('1 comparable'))).toBe(true)
  })
})

// ── computeEstimate — price statistics ───────────────────────────────────────

describe('computeEstimate — price statistics', () => {
  it('uses median not average as primary estimate', () => {
    // average = (100+200+10000)/3 = 3433, median = 200
    const sales = [
      sale({ orderItemId: 'a', soldPriceCents: 100 }),
      sale({ orderItemId: 'b', soldPriceCents: 200 }),
      sale({ orderItemId: 'c', soldPriceCents: 10000 }),
    ]
    const result = computeEstimate(target(), sales, NOW)
    expect(result.estimatedPrice).toBe(200)
  })

  it('25th percentile is low price, 75th is high price', () => {
    const sales = [100, 200, 300, 400].map((p, i) =>
      sale({ orderItemId: `oi-${i}`, soldPriceCents: p }),
    )
    const result = computeEstimate(target(), sales, NOW)
    expect(result.lowPrice).toBe(100)   // p25 = index 0
    expect(result.highPrice).toBe(300)  // p75 = index 2
  })
})

// ── computeEstimate — days to sell ───────────────────────────────────────────

describe('computeEstimate — days to sell', () => {
  it('computes days to sell as completedAt - listingCreatedAt', () => {
    const listing = new Date('2025-01-01T00:00:00Z')
    const completed = new Date('2025-01-11T00:00:00Z')
    const result = computeEstimate(
      target(),
      [sale({ listingCreatedAt: listing, orderCompletedAt: completed })],
      NOW,
    )
    expect(result.estimatedDaysToSell).toBe(10)
  })

  it('excludes negative durations from days-to-sell calculation', () => {
    const listing = new Date('2025-01-11T00:00:00Z')
    const completed = new Date('2025-01-01T00:00:00Z') // completed before listing
    const validSale = sale({
      orderItemId: 'valid',
      listingCreatedAt: new Date('2025-01-01T00:00:00Z'),
      orderCompletedAt: new Date('2025-01-06T00:00:00Z'),
    })
    const badSale = sale({
      orderItemId: 'bad',
      listingCreatedAt: listing,
      orderCompletedAt: completed,
    })
    const result = computeEstimate(target(), [validSale, badSale], NOW)
    // Only valid sale contributes 5 days
    expect(result.estimatedDaysToSell).toBe(5)
    // Bad sale still counted as a price comparable
    expect(result.comparableCount).toBe(2)
    // Bad sale daysToSell is null in the comparable record
    const badRecord = result.comparables.find((c) => c.orderItemId === 'bad')
    expect(badRecord?.daysToSell).toBeNull()
  })

  it('returns null daysToSell when all durations are negative', () => {
    const listing = new Date('2025-02-01T00:00:00Z')
    const completed = new Date('2025-01-01T00:00:00Z')
    const result = computeEstimate(
      target(),
      [sale({ listingCreatedAt: listing, orderCompletedAt: completed })],
      NOW,
    )
    expect(result.estimatedDaysToSell).toBeNull()
  })
})

// ── computeEstimate — recency window ─────────────────────────────────────────

describe('computeEstimate — recency window', () => {
  it(`uses recent window when >= ${MIN_WINDOW_COMPS} comps within 24 months`, () => {
    const recentSales = makeSales(MIN_WINDOW_COMPS, { orderCompletedAt: RECENT })
    const oldSale = sale({ orderItemId: 'old', soldPriceCents: 9999, orderCompletedAt: OLD })
    const result = computeEstimate(target(), [...recentSales, oldSale], NOW)
    expect(result.extendedHistoryUsed).toBe(false)
    expect(result.comparableCount).toBe(MIN_WINDOW_COMPS)
    // old sale excluded from estimate
    expect(result.estimatedPrice).not.toBe(9999)
  })

  it('expands to all history when fewer than MIN_WINDOW_COMPS in recent window', () => {
    const oldSales = makeSales(5, { orderCompletedAt: OLD })
    const result = computeEstimate(target(), oldSales, NOW)
    expect(result.extendedHistoryUsed).toBe(true)
    expect(result.comparableCount).toBe(5)
    expect(result.warnings.some((w) => w.includes('24 months'))).toBe(true)
  })

  it('extendedHistoryUsed is false when all comps happen to be within window even if < MIN_WINDOW_COMPS', () => {
    const recentSales = makeSales(2, { orderCompletedAt: RECENT })
    const result = computeEstimate(target(), recentSales, NOW)
    expect(result.extendedHistoryUsed).toBe(false)
  })
})

// ── computeEstimate — unrelated sales cannot hide exact comparables ───────────

describe('computeEstimate — unrelated sales cannot hide exact comparables', () => {
  it('many recent unrelated brand_series sales do not block an older exact match', () => {
    const t = target() // id: 'model-A', brand: 'Hot Wheels', series: 'ZAMAC', year: 2022

    // 50 recent sales for a different model in the same series (brand_series level)
    const unrelateds = Array.from({ length: 50 }, (_, i) =>
      sale({
        orderItemId: `unrelated-${i}`,
        sku: `UNRELATED-${i}`,
        catalogModelId: 'model-OTHER',
        catalogName: 'Deora III',  // different name → not model_family
        orderCompletedAt: RECENT,
        soldPriceCents: 500,
      }),
    )

    // 3 old exact matches for the target model
    const exactMatches = Array.from({ length: 3 }, (_, i) =>
      sale({
        orderItemId: `exact-${i}`,
        sku: `EXACT-${i}`,
        catalogModelId: 'model-A',
        orderCompletedAt: OLD,
        soldPriceCents: 2000 + i * 100,
      }),
    )

    const result = computeEstimate(t, [...unrelateds, ...exactMatches], NOW)
    // Exact match must be chosen over brand_series, despite the unrelated sales outnumbering it
    expect(result.matchLevel).toBe('exact')
    expect(result.comparableCount).toBe(3)
    expect(result.extendedHistoryUsed).toBe(true) // old exact, no recent exact
    // Price from exact matches only, not the $5.00 unrelated sales
    expect(result.estimatedPrice).toBe(2100) // median of [2000, 2100, 2200]
  })
})

// ── computeEstimate — deduplication ──────────────────────────────────────────

describe('computeEstimate — deduplication', () => {
  it('deduplicates by orderItemId', () => {
    const dup = [
      sale({ orderItemId: 'oi-1', soldPriceCents: 1000 }),
      sale({ orderItemId: 'oi-1', soldPriceCents: 2000 }), // duplicate id
      sale({ orderItemId: 'oi-2', soldPriceCents: 1500 }),
    ]
    const result = computeEstimate(target(), dup, NOW)
    expect(result.comparableCount).toBe(2) // only oi-1 (first) and oi-2
  })
})

// ── computeEstimate — cent normalization ─────────────────────────────────────

describe('computeEstimate — cent normalization', () => {
  it('prices in cents avoid floating-point rounding artifacts', () => {
    // $19.99 → 1999 cents, $20.01 → 2001 cents, median = 2000 cents = $20.00
    const sales = [
      sale({ orderItemId: 'a', soldPriceCents: 1999 }),
      sale({ orderItemId: 'b', soldPriceCents: 2001 }),
    ]
    const result = computeEstimate(target(), sales, NOW)
    expect(result.estimatedPrice).toBe(2000)
    // Display: (2000 / 100).toFixed(2) === '20.00'
    expect((result.estimatedPrice / 100).toFixed(2)).toBe('20.00')
  })
})

// ── ComparableRecord — no buyer data ─────────────────────────────────────────

describe('ComparableRecord shape — no buyer data', () => {
  it('comparable records do not include buyer name, email, or phone', () => {
    const result = computeEstimate(target(), [sale()], NOW)
    const record = result.comparables[0] as ComparableRecord & Record<string, unknown>
    expect('buyerName' in record).toBe(false)
    expect('buyerEmail' in record).toBe(false)
    expect('buyerPhone' in record).toBe(false)
    expect('customerProfileId' in record).toBe(false)
  })
})
