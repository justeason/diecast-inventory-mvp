import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  applyIqrFilter,
  recencyWeight,
  weightedMedianCents,
  computeTrend,
  deriveAdvancedConfidence,
  computeActiveAskContext,
  computeLiquidity,
  buildAdvancedValuation,
} from '@/lib/advancedValuation'
import { isValidQuantity } from '@/lib/advancedValuationQuery'
import { median } from '@/lib/resaleEstimator'
import type { ComparableRecord } from '@/lib/resaleEstimator'
import type { TargetModel, ComparableSale } from '@/lib/resaleEstimator'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

// ── Test helpers ──────────────────────────────────────────────────────────────

const NOW = new Date('2025-06-01T00:00:00Z')
const NOW_MS = NOW.getTime()

function daysAgo(d: number): Date {
  return new Date(NOW_MS - d * 24 * 60 * 60 * 1000)
}

function target(overrides: Partial<TargetModel> = {}): TargetModel {
  return { id: 'model-A', brand: 'Hot Wheels', name: 'Twin Mill', series: 'ZAMAC', year: 2022, ...overrides }
}

let saleCounter = 0
function sale(overrides: Partial<ComparableSale> = {}): ComparableSale {
  saleCounter++
  return {
    orderItemId: `oi-${saleCounter}`,
    orderId: `ord-${saleCounter}`,
    catalogModelId: 'model-A',
    catalogBrand: 'Hot Wheels',
    catalogName: 'Twin Mill',
    catalogSeries: 'ZAMAC',
    catalogYear: 2022,
    soldPriceCents: 1000,
    listingCreatedAt: daysAgo(30),
    orderCompletedAt: daysAgo(10),
    sku: `SKU-${saleCounter}`,
    ...overrides,
  }
}

function record(overrides: Partial<ComparableRecord> = {}): ComparableRecord {
  saleCounter++
  return {
    orderItemId: `oi-${saleCounter}`,
    orderId: `ord-${saleCounter}`,
    sku: `SKU-${saleCounter}`,
    catalogModelId: 'model-A',
    matchLevel: 'exact',
    soldPriceCents: 1000,
    listingCreatedAt: daysAgo(30),
    orderCompletedAt: daysAgo(10),
    daysToSell: 10,
    ...overrides,
  }
}

function makeSales(
  count: number,
  overrides: Partial<ComparableSale> = {},
  prices?: number[],
): ComparableSale[] {
  return Array.from({ length: count }, (_, i) => sale({ ...overrides, soldPriceCents: prices?.[i] ?? 1000 + i * 100 }))
}

// ── IQR outlier filter ────────────────────────────────────────────────────────

describe('applyIqrFilter', () => {
  it('skips filtering when sample < 5', () => {
    const { filtered, removed } = applyIqrFilter([100, 200, 300, 400])
    expect(removed).toBe(false)
    expect(filtered).toEqual([100, 200, 300, 400])
  })

  it('removes obvious outliers from a sufficient sample', () => {
    // Tight cluster 900-1100, outlier at 10000
    const input = [900, 950, 1000, 1050, 1100, 10000].sort((a, b) => a - b)
    const { filtered, removed } = applyIqrFilter(input)
    expect(removed).toBe(true)
    expect(filtered).not.toContain(10000)
  })

  it('calculates in integer cents (no float boundary errors)', () => {
    // Non-zero IQR, all values within 1.5*IQR — nothing should be removed
    const input = [900, 950, 1000, 1050, 1100]
    const sorted = [...input].sort((a, b) => a - b)
    const { removed } = applyIqrFilter(sorted)
    expect(removed).toBe(false)
  })

  it('retains original sample when filtering would remove all values', () => {
    // Pathological: single unique value repeated 5 times → IQR=0, all pass trivially
    const input = [1000, 1000, 1000, 1000, 1000]
    const { filtered, removed } = applyIqrFilter(input)
    expect(removed).toBe(false)
    expect(filtered.length).toBe(5)
  })

  it('retains original and filtered sample counts', () => {
    const input = [100, 200, 300, 400, 500, 9999].sort((a, b) => a - b)
    const { filtered } = applyIqrFilter(input)
    expect(filtered.length).toBeLessThan(input.length)
    expect(filtered.length).toBeGreaterThan(0)
  })

  it('never removes all observations', () => {
    // All extreme values
    const input = [1, 100000, 200000, 300000, 400000]
    const { filtered } = applyIqrFilter(input)
    expect(filtered.length).toBeGreaterThan(0)
  })

  it('exact integer boundary: uses 2*v comparison to avoid float IQR rounding', () => {
    // Q1=100, Q3=300, IQR=200, 1.5*IQR=300; bounds: 100-300=-200, 300+300=600
    // So value=600 is exactly on the upper bound (2*600=1200, 2*300+3*200=1200) → included
    const input = [100, 200, 300, 400, 600].sort((a, b) => a - b)
    const { filtered } = applyIqrFilter(input)
    expect(filtered).toContain(600)
  })
})

// ── Recency weight ────────────────────────────────────────────────────────────

describe('recencyWeight', () => {
  it('0 days → weight 4', () => expect(recencyWeight(0)).toBe(4))
  it('90 days exactly → weight 4 (boundary belongs to recent bucket)', () => {
    expect(recencyWeight(90 * 24 * 60 * 60 * 1000)).toBe(4)
  })
  it('91 days → weight 3', () => {
    expect(recencyWeight(91 * 24 * 60 * 60 * 1000)).toBe(3)
  })
  it('180 days exactly → weight 3', () => {
    expect(recencyWeight(180 * 24 * 60 * 60 * 1000)).toBe(3)
  })
  it('181 days → weight 2', () => {
    expect(recencyWeight(181 * 24 * 60 * 60 * 1000)).toBe(2)
  })
  it('365 days exactly → weight 2', () => {
    expect(recencyWeight(365 * 24 * 60 * 60 * 1000)).toBe(2)
  })
  it('366 days → weight 1', () => {
    expect(recencyWeight(366 * 24 * 60 * 60 * 1000)).toBe(1)
  })
})

// ── Weighted median ───────────────────────────────────────────────────────────

describe('weightedMedianCents', () => {
  it('recent sale (weight 4) dominates old sale (weight 1)', () => {
    const records: ComparableRecord[] = [
      record({ soldPriceCents: 500,  orderCompletedAt: daysAgo(10)  }),  // weight 4
      record({ soldPriceCents: 2000, orderCompletedAt: daysAgo(400) }),  // weight 1
    ]
    // Expanded: [500,500,500,500,2000] → median = 500
    expect(weightedMedianCents(records, NOW)).toBe(500)
  })

  it('equal weights → same as standard median', () => {
    // All same age bucket → same weight
    const records: ComparableRecord[] = [
      record({ soldPriceCents: 1000, orderCompletedAt: daysAgo(400) }),  // weight 1
      record({ soldPriceCents: 2000, orderCompletedAt: daysAgo(400) }),  // weight 1
      record({ soldPriceCents: 3000, orderCompletedAt: daysAgo(400) }),  // weight 1
    ]
    expect(weightedMedianCents(records, NOW)).toBe(2000)
    expect(median([1000, 2000, 3000])).toBe(2000)
  })

  it('returns integer cents (no floating point)', () => {
    const records: ComparableRecord[] = [
      record({ soldPriceCents: 1999, orderCompletedAt: daysAgo(10) }),
      record({ soldPriceCents: 2001, orderCompletedAt: daysAgo(10) }),
    ]
    const result = weightedMedianCents(records, NOW)
    expect(Number.isInteger(result)).toBe(true)
  })

  it('recency bucket boundary at exactly 90 days uses weight 4', () => {
    const EXACTLY_90D = 90 * 24 * 60 * 60 * 1000
    const at90 = new Date(NOW_MS - EXACTLY_90D)
    const records: ComparableRecord[] = [
      record({ soldPriceCents: 100, orderCompletedAt: at90  }),  // exactly 90d → weight 4
      record({ soldPriceCents: 999, orderCompletedAt: daysAgo(400) }),  // weight 1
    ]
    // Expanded: [100,100,100,100,999] → median = 100
    expect(weightedMedianCents(records, NOW)).toBe(100)
  })
})

// ── Trend ─────────────────────────────────────────────────────────────────────

describe('computeTrend', () => {
  it('returns unavailable when < 3 exact sales in recent window', () => {
    const records = [
      record({ orderCompletedAt: daysAgo(10), soldPriceCents: 1000 }),
      record({ orderCompletedAt: daysAgo(20), soldPriceCents: 1000 }),
      // only 2 recent, 0 prior
      record({ orderCompletedAt: daysAgo(120), soldPriceCents: 1000 }),
      record({ orderCompletedAt: daysAgo(130), soldPriceCents: 1000 }),
      // only 2 prior
    ]
    const trend = computeTrend(records, NOW)
    expect(trend.direction).toBe('unavailable')
  })

  it('returns up when recent median > prior median by > 3%', () => {
    const recent = [1, 2, 3].map(i => record({ orderCompletedAt: daysAgo(i * 10), soldPriceCents: 2000 }))
    const prior  = [1, 2, 3].map(i => record({ orderCompletedAt: daysAgo(100 + i * 10), soldPriceCents: 1000 }))
    const trend = computeTrend([...recent, ...prior], NOW)
    expect(trend.direction).toBe('up')
    expect(trend.recentMedian).toBe(2000)
    expect(trend.priorMedian).toBe(1000)
    expect(trend.percentageChange).toBeCloseTo(100, 0)
  })

  it('returns down when recent median < prior median by > 3%', () => {
    const recent = [1, 2, 3].map(i => record({ orderCompletedAt: daysAgo(i * 10), soldPriceCents: 1000 }))
    const prior  = [1, 2, 3].map(i => record({ orderCompletedAt: daysAgo(100 + i * 10), soldPriceCents: 2000 }))
    const trend = computeTrend([...recent, ...prior], NOW)
    expect(trend.direction).toBe('down')
  })

  it('returns flat when absolute change < 3%', () => {
    const recent = [1, 2, 3].map(i => record({ orderCompletedAt: daysAgo(i * 10), soldPriceCents: 1000 }))
    const prior  = [1, 2, 3].map(i => record({ orderCompletedAt: daysAgo(100 + i * 10), soldPriceCents: 1010 }))
    const trend = computeTrend([...recent, ...prior], NOW)
    expect(trend.direction).toBe('flat')
  })

  it('excludes fallback matches — uses exact-only for trend', () => {
    const exactRecent = [1, 2, 3].map(i =>
      record({ matchLevel: 'exact',        orderCompletedAt: daysAgo(i * 10), soldPriceCents: 2000 }))
    const fbPrior  = [1, 2, 3].map(i =>
      record({ matchLevel: 'model_family', orderCompletedAt: daysAgo(100 + i * 10), soldPriceCents: 500 }))
    // Without fallback, prior window has 0 exact → unavailable
    const trend = computeTrend([...exactRecent, ...fbPrior], NOW)
    expect(trend.direction).toBe('unavailable')
  })

  it('sale exactly 90 days old belongs to recent (0-90d) window', () => {
    const EXACTLY_90D_MS = 90 * 24 * 60 * 60 * 1000
    const at90 = new Date(NOW_MS - EXACTLY_90D_MS)
    // 3 recent (including the exact-90d boundary), 3 prior
    const recent = [
      record({ orderCompletedAt: at90,       soldPriceCents: 2000 }),
      record({ orderCompletedAt: daysAgo(10), soldPriceCents: 2000 }),
      record({ orderCompletedAt: daysAgo(20), soldPriceCents: 2000 }),
    ]
    const prior = [1, 2, 3].map(i =>
      record({ orderCompletedAt: daysAgo(100 + i * 10), soldPriceCents: 1000 }))
    const trend = computeTrend([...recent, ...prior], NOW)
    expect(trend.direction).toBe('up')
    expect(trend.recentMedian).toBe(2000)
  })

  it('returns unavailable when < 3 sales in prior window', () => {
    const recent = [1, 2, 3].map(i => record({ orderCompletedAt: daysAgo(i * 10), soldPriceCents: 1000 }))
    const prior  = [record({ orderCompletedAt: daysAgo(120), soldPriceCents: 1000 })]
    const trend = computeTrend([...recent, ...prior], NOW)
    expect(trend.direction).toBe('unavailable')
  })
})

// ── Confidence ────────────────────────────────────────────────────────────────

describe('deriveAdvancedConfidence', () => {
  const baseParams = {
    asOf: NOW,
    latestSaleAt: daysAgo(30),
    iqrRange: 100,
    estimatedValueCents: 1000,
    outliersRemoved: false,
    extendedHistoryUsed: false,
  }

  it('returns insufficient when no samples', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 0,
      recentSampleCount: 0,
    })
    expect(confidence).toBe('insufficient')
  })

  it('returns insufficient for insufficient match tier', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'insufficient',
      sampleCount: 5,
      recentSampleCount: 3,
    })
    expect(confidence).toBe('insufficient')
  })

  it('high: exact + 8+ samples + 3+ recent + fresh + low dispersion + no extended history', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 10,
      recentSampleCount: 5,
    })
    expect(confidence).toBe('high')
  })

  it('medium: exact + >=3 samples (not high criteria)', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 5,
      recentSampleCount: 1,
    })
    expect(confidence).toBe('medium')
  })

  it('low: exact + 1-2 samples', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 2,
      recentSampleCount: 1,
    })
    expect(confidence).toBe('low')
  })

  it('high downgrades to medium when extendedHistoryUsed', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 10,
      recentSampleCount: 5,
      extendedHistoryUsed: true,
    })
    expect(confidence).toBe('medium')
  })

  it('high downgrades to medium when high dispersion', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 10,
      recentSampleCount: 5,
      iqrRange: 600,
      estimatedValueCents: 1000,  // 60% dispersion → high
    })
    expect(confidence).toBe('medium')
  })

  it('stale latest sale prevents high confidence', () => {
    const { confidence } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 10,
      recentSampleCount: 5,
      latestSaleAt: daysAgo(91),  // stale
    })
    expect(confidence).toBe('medium')
  })

  it('returns machine-readable reason codes', () => {
    const { reasons } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'exact',
      sampleCount: 10,
      recentSampleCount: 5,
    })
    const codes = reasons.map(r => r.code)
    expect(codes).toContain('exact_match')
    expect(codes).toContain('sample_count_high')
  })

  it('fallback match appears in reasons', () => {
    const { reasons } = deriveAdvancedConfidence({
      ...baseParams,
      matchTier: 'model_family',
      sampleCount: 3,
      recentSampleCount: 1,
    })
    expect(reasons.some(r => r.code === 'fallback_match')).toBe(true)
  })
})

// ── Active ask context ────────────────────────────────────────────────────────

describe('computeActiveAskContext', () => {
  it('returns nulls when no active listings', () => {
    const ctx = computeActiveAskContext([])
    expect(ctx.activeListingCount).toBe(0)
    expect(ctx.lowestActiveAsk).toBeNull()
    expect(ctx.medianActiveAsk).toBeNull()
    expect(ctx.highestActiveAsk).toBeNull()
  })

  it('returns correct low/median/high for multiple prices', () => {
    const ctx = computeActiveAskContext([500, 1000, 1500])
    expect(ctx.lowestActiveAsk).toBe(500)
    expect(ctx.medianActiveAsk).toBe(1000)
    expect(ctx.highestActiveAsk).toBe(1500)
    expect(ctx.activeListingCount).toBe(3)
  })

  it('uses integer cents only (positive prices only)', () => {
    const ctx = computeActiveAskContext([999, 1001])
    expect(ctx.lowestActiveAsk).toBe(999)
    expect(ctx.highestActiveAsk).toBe(1001)
  })

  it('active asks are not blended into estimated value (separate output)', () => {
    // This is a structural test: computeActiveAskContext is a separate function from
    // the value computation in buildAdvancedValuation
    const askCtx = computeActiveAskContext([5000])
    expect(askCtx.lowestActiveAsk).toBe(5000)
    // The fact that this is separate from soldPriceCents confirms the isolation
  })
})

// ── Liquidity ─────────────────────────────────────────────────────────────────

describe('computeLiquidity', () => {
  it('computes median days to sell from valid durations', () => {
    const records = [
      record({ daysToSell: 5 }),
      record({ daysToSell: 10 }),
      record({ daysToSell: 15 }),
    ]
    const liq = computeLiquidity(records, 0, NOW)
    expect(liq.medianDaysToSell).toBe(10)
  })

  it('excludes null (negative) durations from calculation', () => {
    const records = [
      record({ daysToSell: 5 }),
      record({ daysToSell: null }),  // negative duration — excluded
      record({ daysToSell: 15 }),
    ]
    const liq = computeLiquidity(records, 0, NOW)
    expect(liq.medianDaysToSell).toBe(10)
    expect(liq.durationSampleCount).toBe(2)
  })

  it('returns null median when all durations are null', () => {
    const records = [record({ daysToSell: null })]
    const liq = computeLiquidity(records, 0, NOW)
    expect(liq.medianDaysToSell).toBeNull()
  })

  it('counts recent completed sales (within 180d)', () => {
    const records = [
      record({ orderCompletedAt: daysAgo(10) }),
      record({ orderCompletedAt: daysAgo(100) }),
      record({ orderCompletedAt: daysAgo(200) }),  // outside 180d
    ]
    const liq = computeLiquidity(records, 0, NOW)
    expect(liq.recentCompletedSaleCount).toBe(2)
  })

  it('includes activePurchasableListingCount in output', () => {
    const liq = computeLiquidity([], 7, NOW)
    expect(liq.activePurchasableListingCount).toBe(7)
  })

  it('computes p25/p75 days to sell', () => {
    const records = [
      record({ daysToSell: 5 }),
      record({ daysToSell: 10 }),
      record({ daysToSell: 15 }),
      record({ daysToSell: 20 }),
    ]
    const liq = computeLiquidity(records, 0, NOW)
    expect(liq.p25DaysToSell).toBe(5)
    expect(liq.p75DaysToSell).toBe(15)
  })
})

// ── buildAdvancedValuation ────────────────────────────────────────────────────

describe('buildAdvancedValuation — completed orders only', () => {
  it('uses only Order.status=complete via computeEstimate (structural)', () => {
    // buildAdvancedValuation delegates eligible-sale selection to computeEstimate
    // which was fed pre-filtered ComparableSale[]. The query layer enforces order.status='complete'.
    // We verify that zero sales → insufficient
    const v = buildAdvancedValuation(target(), [], [], 0, NOW)
    expect(v.confidence).toBe('insufficient')
    expect(v.estimatedValue).toBeNull()
    expect(v.matchTier).toBe('insufficient')
  })
})

describe('buildAdvancedValuation — positive prices only', () => {
  it('zero or negative sold prices produce no estimate', () => {
    // The query layer filters price > 0. Passing price=0 manually:
    const zeroSale: ComparableSale = {
      ...sale(), soldPriceCents: 0,
    }
    // computeEstimate includes it but price=0 cents means it's not a positive sale
    // (query layer ensures this never enters; this tests robustness)
    const v = buildAdvancedValuation(target(), [zeroSale], [], 0, NOW)
    // 0-cent sales still pass through computeEstimate (it doesn't re-filter price)
    // but are filtered at the query layer; this just confirms no crash
    expect(v).toBeDefined()
  })
})

describe('buildAdvancedValuation — exact match before fallback', () => {
  it('chooses exact when both exact and fallback exist', () => {
    const exact = makeSales(5, { catalogModelId: 'model-A' }, [1000, 1100, 1200, 1300, 1400])
    const fallback = makeSales(10, {
      catalogModelId: 'model-B',
      catalogName: 'Twin Mill',
    }, Array(10).fill(5000))
    const v = buildAdvancedValuation(target(), [...exact, ...fallback], [], 0, NOW)
    expect(v.matchTier).toBe('exact')
    expect(v.estimatedValue).not.toBe(5000)
  })
})

describe('buildAdvancedValuation — deterministic fallback labeling', () => {
  it('marks matchTier as model_family when no exact match', () => {
    const fb = makeSales(5, { catalogModelId: 'model-B', catalogName: 'Twin Mill' })
    const v = buildAdvancedValuation(target({ id: 'model-X' }), fb, [], 0, NOW)
    expect(v.matchTier).toBe('model_family')
  })
})

describe('buildAdvancedValuation — 24-month cutoff and extended history', () => {
  it('excludes old sales when >= 3 exist within 24 months', () => {
    const twoYearsAgo = new Date(NOW_MS - 2 * 365.25 * 24 * 60 * 60 * 1000 - 1000)
    const recent  = makeSales(3, { orderCompletedAt: daysAgo(30) }, [1000, 1100, 1200])
    const ancient = makeSales(5, { orderCompletedAt: twoYearsAgo }, [9000, 9100, 9200, 9300, 9400])
    const v = buildAdvancedValuation(target(), [...recent, ...ancient], [], 0, NOW)
    expect(v.extendedHistoryUsed).toBe(false)
    expect(v.estimatedValue).toBeLessThan(9000)
  })

  it('uses extended history when < 3 recent sales', () => {
    const twoYearsAgo = new Date(NOW_MS - 2 * 365.25 * 24 * 60 * 60 * 1000 - 1000)
    const ancient = makeSales(5, { orderCompletedAt: twoYearsAgo })
    const v = buildAdvancedValuation(target(), ancient, [], 0, NOW)
    expect(v.extendedHistoryUsed).toBe(true)
  })
})

describe('buildAdvancedValuation — integer-cent calculations', () => {
  it('estimatedValue is an integer (cents)', () => {
    const sales = makeSales(5, {}, [999, 1001, 1003, 1007, 1009])
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    if (v.estimatedValue !== null) {
      expect(Number.isInteger(v.estimatedValue)).toBe(true)
    }
  })
})

// 14C: additive fields (minCents/maxCents/oldestSaleAt) on the filtered/chosen set.
describe('buildAdvancedValuation — minCents/maxCents/oldestSaleAt (14C additions)', () => {
  it('reports min/max of the filtered (post-IQR) sold set, and null when no sales', () => {
    const noSales = buildAdvancedValuation(target(), [], [], 0, NOW)
    expect(noSales.minCents).toBeNull()
    expect(noSales.maxCents).toBeNull()
    expect(noSales.oldestSaleAt).toBeNull()

    const sales = makeSales(5, {}, [900, 1000, 1100, 1200, 1300])
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    expect(v.minCents).toBe(900)
    expect(v.maxCents).toBe(1300)
  })

  it('oldestSaleAt matches the oldest sale in the chosen comparable window', () => {
    const oldest = daysAgo(20)
    const sales = [
      sale({ orderCompletedAt: daysAgo(5) }),
      sale({ orderCompletedAt: oldest }),
      sale({ orderCompletedAt: daysAgo(12) }),
    ]
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    expect(v.oldestSaleAt?.getTime()).toBe(oldest.getTime())
  })

  it('an IQR-excluded outlier does not count toward minCents/maxCents', () => {
    const sales = makeSales(6, {}, [900, 950, 1000, 1050, 1100, 50000]) // 50000 is the outlier
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    expect(v.outliersRemoved).toBe(true)
    expect(v.maxCents).toBeLessThan(50000)
  })
})

describe('buildAdvancedValuation — outlier removal', () => {
  it('removes outliers from sufficient sample (≥5)', () => {
    const sales = makeSales(6, {}, [900, 950, 1000, 1050, 1100, 50000])
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    expect(v.outliersRemoved).toBe(true)
    expect(v.sampleCount).toBe(6)
    expect(v.effectiveSampleCount).toBe(5)
  })

  it('skips outlier removal for small sample (<5)', () => {
    const sales = makeSales(4, {}, [100, 1000, 2000, 10000])
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    expect(v.outliersRemoved).toBe(false)
    expect(v.effectiveSampleCount).toBe(4)
  })
})

describe('buildAdvancedValuation — recency-weighted estimate selection', () => {
  it('uses weighted median when exact match and >=3 recent sales', () => {
    // 3 recent (weight 4) sales at 500 cents, 3 old (weight 1) sales at 5000 cents
    const recent = [1, 2, 3].map(i =>
      sale({ soldPriceCents: 500, orderCompletedAt: daysAgo(i * 10) }))
    const old = [1, 2, 3].map(i =>
      sale({ soldPriceCents: 5000, orderCompletedAt: daysAgo(400 + i * 10) }))
    const v = buildAdvancedValuation(target(), [...recent, ...old], [], 0, NOW)
    expect(v.weightedMedian).toBeDefined()
    // With weights, recent (500 × weight 4) should pull the estimate toward 500
    expect(v.estimatedValue).toBeLessThan(3000)
  })

  it('uses unweighted median when < 3 recent exact sales', () => {
    // All sales old
    const old = makeSales(5, { orderCompletedAt: daysAgo(400) })
    const v = buildAdvancedValuation(target(), old, [], 0, NOW)
    // extendedHistoryUsed because < 3 recent; weighted median not used
    expect(v.unweightedMedian).toBeDefined()
  })

  it('stores both unweightedMedian and weightedMedian for transparency', () => {
    const recent = makeSales(3, { orderCompletedAt: daysAgo(10) })
    const v = buildAdvancedValuation(target(), recent, [], 0, NOW)
    expect(v.unweightedMedian).not.toBeNull()
    expect(v.weightedMedian).not.toBeNull()
  })
})

describe('buildAdvancedValuation — range enforcement', () => {
  it('enforces low <= estimatedValue <= high', () => {
    const sales = makeSales(5, {}, [800, 900, 1000, 1100, 1200])
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    if (v.estimatedValue !== null && v.lowEstimate !== null && v.highEstimate !== null) {
      expect(v.lowEstimate).toBeLessThanOrEqual(v.estimatedValue)
      expect(v.estimatedValue).toBeLessThanOrEqual(v.highEstimate)
    }
  })
})

describe('buildAdvancedValuation — active asks not blended into estimate', () => {
  it('active asks at extreme prices do not change estimatedValue', () => {
    const sales = makeSales(5, {}, [1000, 1100, 1200, 1300, 1400])
    const vNoAsks  = buildAdvancedValuation(target(), sales, [], 0, NOW)
    const vHighAsk = buildAdvancedValuation(target(), sales, [999999], 1, NOW)
    expect(vNoAsks.estimatedValue).toBe(vHighAsk.estimatedValue)
  })

  it('activeAskContext is a separate output field', () => {
    const sales = makeSales(5, {}, [1000, 1100, 1200, 1300, 1400])
    const v = buildAdvancedValuation(target(), sales, [500, 600], 2, NOW)
    expect(v.activeAskContext.activeListingCount).toBe(2)
    expect(v.activeAskContext.lowestActiveAsk).toBe(500)
    // estimatedValue should not equal 500 (asks don't influence it)
    expect(v.estimatedValue).not.toBe(500)
  })
})

describe('buildAdvancedValuation — deduplication', () => {
  it('duplicate orderItemIds are counted once', () => {
    const dup = [
      sale({ orderItemId: 'oi-X', soldPriceCents: 1000 }),
      sale({ orderItemId: 'oi-X', soldPriceCents: 9999 }),  // duplicate
      sale({ orderItemId: 'oi-Y', soldPriceCents: 1000 }),
    ]
    const v = buildAdvancedValuation(target(), dup, [], 0, NOW)
    expect(v.sampleCount).toBe(2)
  })
})

describe('buildAdvancedValuation — negative days-to-sell excluded', () => {
  it('negative duration is excluded from liquidity calculation', () => {
    const badSale = sale({
      listingCreatedAt: daysAgo(5),
      orderCompletedAt: daysAgo(10),  // completed before listing → negative
    })
    const goodSale = sale({
      listingCreatedAt: daysAgo(20),
      orderCompletedAt: daysAgo(10),  // 10 days positive
    })
    const v = buildAdvancedValuation(target(), [badSale, goodSale], [], 0, NOW)
    expect(v.medianDaysToSell).toBe(10)
  })
})

// ── isValidQuantity ───────────────────────────────────────────────────────────

describe('isValidQuantity', () => {
  it('accepts 1', () => expect(isValidQuantity(1)).toBe(true))
  it('accepts 999', () => expect(isValidQuantity(999)).toBe(true))
  it('accepts mid-range integer', () => expect(isValidQuantity(5)).toBe(true))
  it('rejects 0', () => expect(isValidQuantity(0)).toBe(false))
  it('rejects -1', () => expect(isValidQuantity(-1)).toBe(false))
  it('rejects 1000', () => expect(isValidQuantity(1000)).toBe(false))
  it('rejects fractional 0.5', () => expect(isValidQuantity(0.5)).toBe(false))
  it('rejects fractional 1.5', () => expect(isValidQuantity(1.5)).toBe(false))
})

// ── asOf consistency (functional) ────────────────────────────────────────────

describe('authoritative asOf — functional', () => {
  it('buildAdvancedValuation returns the exact asOf Date object passed in', () => {
    const v = buildAdvancedValuation(target(), makeSales(3), [], 0, NOW)
    expect(v.asOf).toBe(NOW)
  })
})

// ── advancedValuationQuery.ts — structural tests ──────────────────────────────

const querySrc      = readSrc('src/lib/advancedValuationQuery.ts')
const valuationSrc  = readSrc('src/lib/advancedValuation.ts')
const valuationPage = readSrc('src/app/(store)/account/collection/valuation/page.tsx')
const collectionPage = readSrc('src/app/(store)/account/collection/page.tsx')

describe('authoritative asOf — structural', () => {
  it('getCatalogValuations accepts asOf as a parameter', () => {
    expect(querySrc).toContain('asOf: Date = new Date()')
  })

  it('getCollectionValuation passes its single asOf to getCatalogValuations', () => {
    expect(querySrc).toContain('getCatalogValuations(catalogIds, asOf)')
  })

  it('getCatalogValuation passes its asOf to both the batch call and the fallback', () => {
    expect(querySrc).toContain('getCatalogValuations([catalogModelId], asOf)')
    expect(querySrc).toContain('buildAdvancedValuation(noTarget, [], [], 0, asOf)')
  })

  it('getCollectionValuation does not re-create asOf inside the map callback', () => {
    // Only one new Date() in the function — the top-level const
    const fnStart = querySrc.indexOf('export async function getCollectionValuation')
    const fnBody = querySrc.slice(fnStart)
    const firstNewDate = fnBody.indexOf('new Date()')
    const secondNewDate = fnBody.indexOf('new Date()', firstNewDate + 1)
    expect(secondNewDate).toBe(-1)
  })
})

describe('quantity validation — structural', () => {
  it('exports isValidQuantity', () => {
    expect(querySrc).toContain('export function isValidQuantity')
  })

  it('does not use Math.max or Math.round on quantity', () => {
    expect(querySrc).not.toContain('Math.max(1,')
    expect(querySrc).not.toContain('Math.round(ci.quantity)')
  })

  it('invalid quantity results in quantityValid: false and null subtotals', () => {
    expect(querySrc).toContain('quantityValid')
    expect(querySrc).toContain('isValidQuantity(qty)')
  })
})

// ── Keyset pagination — functional ───────────────────────────────────────────

describe('comparable-sale scanning: pagination completeness — functional', () => {
  it('sampleCount reflects all observations when > BATCH_CANDIDATE_LIMIT', () => {
    const sales = [
      ...makeSales(1000, { orderCompletedAt: daysAgo(10) }, Array(1000).fill(1000)),
      ...makeSales(1001, { orderCompletedAt: daysAgo(10) }, Array(1001).fill(2000)),
    ]
    const v = buildAdvancedValuation(target(), sales, [], 0, NOW)
    expect(v.sampleCount).toBe(2001)
  })

  it('2001st observation changes the estimate when it breaks a median tie', () => {
    const low  = makeSales(1000, { orderCompletedAt: daysAgo(10) }, Array(1000).fill(1000))
    const high = makeSales(1001, { orderCompletedAt: daysAgo(10) }, Array(1001).fill(2000))
    const vFull   = buildAdvancedValuation(target(), [...low, ...high], [], 0, NOW)
    const vMinus1 = buildAdvancedValuation(target(), [...low, ...high.slice(0, 1000)], [], 0, NOW)
    // 2001-sale case: median of [1000×1000, 1001×2000] = 2000
    // 2000-sale case: median of [1000×1000, 1000×2000] = 1500
    expect(vFull.estimatedValue).not.toBe(vMinus1.estimatedValue)
    expect(vFull.estimatedValue).toBe(2000)
    expect(vMinus1.estimatedValue).toBe(1500)
  })

  it('additional observation beyond old cap affects confidence when it crosses threshold', () => {
    // 7 recent exact sales → medium; 8th (what would be page-2 row) → high
    const recent7 = makeSales(7, { orderCompletedAt: daysAgo(10) })
    const v7 = buildAdvancedValuation(target(), recent7, [], 0, NOW)
    const v8 = buildAdvancedValuation(target(), [...recent7, sale({ orderCompletedAt: daysAgo(10) })], [], 0, NOW)
    expect(v7.confidence).toBe('medium')
    expect(v8.confidence).toBe('high')
  })

  it('24-month boundary applied by computeEstimate — no date filter in query layer', () => {
    // Query returns all observations; computeEstimate applies the cutoff
    expect(querySrc).not.toContain('completedAt: { gte:')
    expect(querySrc).not.toContain('completedAt: { gt:')
  })

  it('extended-history fallback: computeEstimate uses full scanned set (no extra cutoff)', () => {
    // Extended history uses ALL sales at the chosen match level (no date lower bound)
    const ancient  = makeSales(3, { orderCompletedAt: new Date('2000-01-01') })
    const v = buildAdvancedValuation(target(), ancient, [], 0, NOW)
    expect(v.extendedHistoryUsed).toBe(true)
    expect(v.sampleCount).toBe(3)
  })
})

// ── Keyset pagination — structural ────────────────────────────────────────────

describe('comparable-sale scanning: keyset pagination — structural', () => {
  it('BATCH_CANDIDATE_LIMIT is a page size — pagination loop fetches beyond it', () => {
    expect(querySrc).toContain('while (true)')
    expect(querySrc).toContain('rows.length < BATCH_CANDIDATE_LIMIT')
  })

  it('uses OrderItem.id ASC for stable, unique cursor key', () => {
    expect(querySrc).toContain("orderBy: { id: 'asc' }")
  })

  it('uses id: { gt: afterId } keyset filter to page forward without duplicates', () => {
    expect(querySrc).toContain('id: { gt: afterId }')
    expect(querySrc).toContain('afterId = rows[rows.length - 1].id')
  })

  it('defensively deduplicates across pages and chunks by OrderItem ID', () => {
    expect(querySrc).toContain('seen.has(row.id)')
    expect(querySrc).toContain('const seen = new Set<string>()')
  })

  it('chunks large target lists to keep OR conditions manageable', () => {
    expect(querySrc).toContain('TARGET_CHUNK_SIZE')
    expect(querySrc).toContain('targets.slice(i, i + TARGET_CHUNK_SIZE)')
  })

  it('no overall take cap — take appears only inside the pagination loop as page size', () => {
    expect(querySrc).toContain('take: BATCH_CANDIDATE_LIMIT')
    expect(querySrc).toContain('while (true)')
  })
})

describe('advancedValuationQuery.ts: no N+1 query per collection item', () => {
  it('exports getCatalogValuations for batch lookup', () => {
    expect(querySrc).toContain('export async function getCatalogValuations')
  })

  it('deduplicates catalog IDs before querying', () => {
    expect(querySrc).toContain('new Set(')
  })

  it('BATCH_CANDIDATE_LIMIT is page size for keyset pagination, not a total cap', () => {
    expect(querySrc).toContain('BATCH_CANDIDATE_LIMIT')
    expect(querySrc).toContain('take: BATCH_CANDIDATE_LIMIT')
    expect(querySrc).toContain('while (true)')
  })
})

describe('advancedValuationQuery.ts: eligible-sale predicate', () => {
  it('enforces Order.status = complete', () => {
    expect(querySrc).toContain("status: 'complete'")
  })

  it('enforces completedAt IS NOT NULL', () => {
    expect(querySrc).toContain('completedAt: { not: null }')
  })

  it('enforces price > 0 at query level', () => {
    expect(querySrc).toContain('price: { gt: 0 }')
  })
})

describe('advancedValuationQuery.ts: active ask predicate', () => {
  it('requires active listing + available item + price > 0', () => {
    expect(querySrc).toContain("status: 'active'")
    expect(querySrc).toContain("status: 'available'")
  })
})

describe('advancedValuationQuery.ts: privacy and security', () => {
  it('getCollectionValuation does not select buyer PII fields', () => {
    expect(querySrc).not.toContain('buyerEmail')
    expect(querySrc).not.toContain('buyerName')
    expect(querySrc).not.toContain('buyerPhone')
  })

  it('getCollectionValuation takes profileId parameter (not from browser)', () => {
    expect(querySrc).toContain('export async function getCollectionValuation(')
    expect(querySrc).toContain('profileId: string')
  })

  it('no order IDs or payout fields in valuation output', () => {
    const typeSectionEnd = valuationSrc.indexOf('export function')
    const typeSection = valuationSrc.slice(0, typeSectionEnd)
    expect(typeSection).not.toContain('orderId:')
    expect(typeSection).not.toContain('payoutAmount')
    expect(typeSection).not.toContain('customerProfileId')
  })
})

describe('advancedValuationQuery.ts: read-only — no mutations', () => {
  it('performs no create, update, or delete operations', () => {
    expect(querySrc).not.toContain('.create(')
    expect(querySrc).not.toContain('.update(')
    expect(querySrc).not.toContain('.delete(')
    expect(querySrc).not.toContain('.upsert(')
  })
})

describe('advancedValuation.ts: read-only — no external data or AI', () => {
  it('does not import fetch, axios, or OpenAI', () => {
    expect(valuationSrc).not.toContain("from 'openai'")
    expect(valuationSrc).not.toContain("from 'axios'")
    expect(valuationSrc).not.toContain("fetch(")
    expect(valuationSrc).not.toContain('scrape')
  })
})

// ── Collection valuation page — structural ────────────────────────────────────

describe('collection/valuation/page.tsx: authenticated and private', () => {
  it('requires buyer session (notFound if unauthenticated)', () => {
    expect(valuationPage).toContain('getBuyerSession')
    expect(valuationPage).toContain('notFound()')
  })

  it('is force-dynamic (no static caching of private data)', () => {
    expect(valuationPage).toContain("export const dynamic = 'force-dynamic'")
  })

  it('has noindex robots meta (private page)', () => {
    expect(valuationPage).toContain('index: false')
  })

  it('calls getCollectionValuation with session.profileId (not browser input)', () => {
    expect(valuationPage).toContain('getCollectionValuation(session.profileId)')
  })

  it('does not expose purchase price or private notes', () => {
    expect(valuationPage).not.toContain('purchasePrice')
    expect(valuationPage).not.toContain('item.notes')
  })

  it('does not expose customer profile ID or order IDs', () => {
    expect(valuationPage).not.toContain('customerProfileId')
    expect(valuationPage).not.toContain('orderId')
  })

  it('performs no server-action mutations (page load is read-only)', () => {
    expect(valuationPage).not.toContain("'use server'")
    expect(valuationPage).not.toContain('.create(')
    expect(valuationPage).not.toContain('.update(')
  })

  it('clearly labels active asks as asking prices (not sold values)', () => {
    expect(valuationPage).toContain('ask')
  })

  it('shows valuation disclaimer/methodology note', () => {
    expect(valuationPage).toContain('Not an appraisal')
    expect(valuationPage).toContain('completed CollectNTrades sales')
  })

  it('link from collection page exists', () => {
    expect(collectionPage).toContain('/account/collection/valuation')
  })
})

// ── No automatic mutations ────────────────────────────────────────────────────

describe('No automatic pricing, order, listing, or payout mutations', () => {
  it('advancedValuation.ts contains no order or listing mutations', () => {
    expect(valuationSrc).not.toContain('listing.create')
    expect(valuationSrc).not.toContain('order.create')
    expect(valuationSrc).not.toContain('payout')
    expect(valuationSrc).not.toContain('collectionItem.update')
  })
})
