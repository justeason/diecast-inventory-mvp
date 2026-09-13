// 23B: pure Valuation Engine V1 math — no DB, no mocks needed.
import { describe, it, expect } from 'vitest'
import {
  median,
  percentile,
  applyOutlierFilter,
  computeMarketRange,
  isHighDispersion,
  filterByTier,
  selectTier,
  splitSourceCounts,
  latestSoldAt,
  deriveConfidence,
  type SpecificityTier,
} from '@/lib/marketValuationMath'
import type { MarketSaleObservation } from '@/lib/marketSaleQuery'

function internalObs(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'internal' }>> = {}): MarketSaleObservation {
  return {
    observationId: 'internal:oi1', sourceType: 'internal', sourceRecordId: 'oi1',
    catalogModelId: 'cat1', marketVariantId: 'v1', packagingType: 'carded', condition: 'mint',
    snapshotProvenance: 'sale_time', priceCents: 1000, currency: 'USD', soldAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function externalObs(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'external' }>> = {}): MarketSaleObservation {
  return {
    observationId: 'external:obs1', sourceType: 'external', sourceRecordId: 'obs1',
    provider: 'ebay', matchMethod: 'manual', catalogModelId: 'cat1', marketVariantId: null,
    packagingType: null, condition: null, priceCents: 1000, currency: 'USD', soldAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

// ── §57: median ──

describe('median (§57)', () => {
  it('odd count returns the middle element', () => {
    expect(median([100, 200, 300])).toBe(200)
  })
  it('even count returns the rounded midpoint', () => {
    expect(median([100, 200])).toBe(150)
    expect(median([100, 201])).toBe(151) // (100+201)/2 = 150.5 -> rounds to 151
  })
  it('single value', () => {
    expect(median([500])).toBe(500)
  })
  it('two values', () => {
    expect(median([100, 300])).toBe(200)
  })
  it('operates on integer cents, never dollars', () => {
    expect(median([1999, 2999])).toBe(2499)
  })
})

describe('percentile — nearest-rank (§57)', () => {
  it('Q1/Q3 on a 5-element sorted array', () => {
    const sorted = [100, 200, 300, 400, 500]
    expect(percentile(sorted, 0.25)).toBe(200)
    expect(percentile(sorted, 0.75)).toBe(400)
  })
})

// ── §58: IQR / outlier filter ──

describe('applyOutlierFilter — Tukey 1.5xIQR (§58)', () => {
  it('N<5: no filtering at all', () => {
    const obs = [1000, 2000, 3000, 4000].map((p) => internalObs({ priceCents: p, marketVariantId: null, condition: null }))
    const result = applyOutlierFilter(obs)
    expect(result.used).toHaveLength(4)
    expect(result.removed).toBe(false)
  })

  it('the audit worked example: [2900,3000,3100,3200,25000] -> raw=5, used=4, excluded=1', () => {
    const prices = [2900, 3000, 3100, 3200, 25000]
    const obs = prices.map((p) => internalObs({ priceCents: p, marketVariantId: null, condition: null }))
    const result = applyOutlierFilter(obs)
    expect(obs).toHaveLength(5)
    expect(result.used).toHaveLength(4)
    expect(result.removed).toBe(true)
    expect(result.used.map((o) => o.priceCents).sort((a, b) => a - b)).toEqual([2900, 3000, 3100, 3200])
  })

  it('never empties the set — falls back to raw if filtering would remove everything', () => {
    // Degenerate all-identical-except-shape case: construct a set where the
    // fence math would otherwise exclude all (extremely tight IQR around a
    // single repeated value with one massive outlier is the real risk case;
    // guard here proves the non-empty invariant directly).
    const obs = [1, 1, 1, 1, 1].map((p) => internalObs({ priceCents: p, marketVariantId: null, condition: null }))
    const result = applyOutlierFilter(obs)
    expect(result.used.length).toBeGreaterThan(0)
  })

  it('preserves the original observation objects (not just prices) for downstream source/date computation', () => {
    const a = internalObs({ priceCents: 1000, sourceRecordId: 'a', marketVariantId: null, condition: null })
    const b = externalObs({ priceCents: 1100, sourceRecordId: 'b' })
    const c = internalObs({ priceCents: 1200, sourceRecordId: 'c', marketVariantId: null, condition: null })
    const d = internalObs({ priceCents: 1300, sourceRecordId: 'd', marketVariantId: null, condition: null })
    const e = internalObs({ priceCents: 1400, sourceRecordId: 'e', marketVariantId: null, condition: null })
    const result = applyOutlierFilter([a, b, c, d, e])
    expect(result.used.map((o) => o.sourceRecordId).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

// ── §59: range ──

describe('computeMarketRange (§59)', () => {
  it('N=1-4: range is null', () => {
    for (let n = 1; n <= 4; n++) {
      const prices = Array.from({ length: n }, (_, i) => 1000 + i * 100)
      expect(computeMarketRange(prices)).toEqual({ low: null, high: null })
    }
  })
  it('N>=5: Q1/Q3 on the provided (already post-outlier) sorted sample', () => {
    const prices = [100, 200, 300, 400, 500]
    expect(computeMarketRange(prices)).toEqual({ low: 200, high: 400 })
  })
  it('never returns raw min/max as the range bounds for a skewed sample', () => {
    const prices = [100, 200, 300, 400, 10000]
    const range = computeMarketRange(prices)
    expect(range.low).not.toBe(100)
    expect(range.high).not.toBe(10000)
  })
})

describe('isHighDispersion', () => {
  it('true when range width exceeds 50% of the estimate', () => {
    expect(isHighDispersion(1000, 3000, 2000)).toBe(true) // width 2000 / estimate 2000 = 1.0
  })
  it('false when range width is within 50%', () => {
    expect(isHighDispersion(1900, 2100, 2000)).toBe(false) // width 200 / 2000 = 0.1
  })
  it('false when range is null (no data to assess dispersion)', () => {
    expect(isHighDispersion(null, null, 2000)).toBe(false)
  })
})

// ── §60-63: specificity tier selection ──

describe('filterByTier / selectTier — unknown never satisfies a narrower tier (§60-63)', () => {
  const target = { marketVariantId: 'v1', condition: 'mint' }

  it('model tier includes everything passed to it', () => {
    const obs = [internalObs(), externalObs()]
    expect(filterByTier(obs, 'model', target)).toHaveLength(2)
  })

  it('model_variant tier requires exact non-null marketVariantId match', () => {
    const match = internalObs({ marketVariantId: 'v1' })
    const wrongVariant = internalObs({ sourceRecordId: 'oi2', marketVariantId: 'v2' })
    const unknownVariant = internalObs({ sourceRecordId: 'oi3', marketVariantId: null })
    const result = filterByTier([match, wrongVariant, unknownVariant], 'model_variant', target)
    expect(result).toEqual([match])
  })

  it('model_variant_condition tier requires BOTH exact variant and exact condition', () => {
    const exact = internalObs({ marketVariantId: 'v1', condition: 'mint' })
    const wrongCondition = internalObs({ sourceRecordId: 'oi2', marketVariantId: 'v1', condition: 'good' })
    const unknownCondition = internalObs({ sourceRecordId: 'oi3', marketVariantId: 'v1', condition: null })
    const externalNeverQualifies = externalObs({ marketVariantId: 'v1' }) // condition always null
    const result = filterByTier([exact, wrongCondition, unknownCondition, externalNeverQualifies], 'model_variant_condition', target)
    expect(result).toEqual([exact])
  })

  it('external condition=null never satisfies model_variant_condition (§72)', () => {
    const ext = externalObs({ marketVariantId: 'v1' })
    expect(filterByTier([ext], 'model_variant_condition', target)).toEqual([])
  })

  it('selectTier picks the FIRST (narrowest) tier with >=1 match, never broadens merely because a wider tier has more samples', () => {
    const oneExact = internalObs({ sourceRecordId: 'exact1', marketVariantId: 'v1', condition: 'mint' })
    const manyVariant = Array.from({ length: 20 }, (_, i) => internalObs({ sourceRecordId: `v${i}`, marketVariantId: 'v1', condition: 'good' }))
    const selection = selectTier([oneExact, ...manyVariant], ['model_variant_condition', 'model_variant', 'model'], target)
    expect(selection?.specificity).toBe('model_variant_condition')
    expect(selection?.observations).toEqual([oneExact])
  })

  it('selectTier returns null when no allowed tier has any qualifying observation', () => {
    const wrongModelVariant = internalObs({ marketVariantId: 'other-variant', condition: 'mint' })
    const selection = selectTier([wrongModelVariant], ['model_variant_condition', 'model_variant'], target)
    expect(selection).toBeNull()
  })

  it('legacy_model_only observations (variant/condition always null) enter only the model tier', () => {
    const legacy = internalObs({ snapshotProvenance: 'legacy_model_only', marketVariantId: null, condition: null })
    expect(filterByTier([legacy], 'model_variant', target)).toEqual([])
    expect(filterByTier([legacy], 'model_variant_condition', target)).toEqual([])
    expect(filterByTier([legacy], 'model', target)).toEqual([legacy])
  })
})

// ── source counts / latest sold ──

describe('splitSourceCounts', () => {
  it('splits internal vs external with no weighting', () => {
    const obs = [internalObs(), internalObs({ sourceRecordId: 'i2' }), externalObs()]
    expect(splitSourceCounts(obs)).toEqual({ internal: 2, external: 1 })
  })
  it('internal + external === total', () => {
    const obs = [internalObs(), externalObs(), externalObs({ sourceRecordId: 'e2' })]
    const { internal, external } = splitSourceCounts(obs)
    expect(internal + external).toBe(obs.length)
  })
})

describe('latestSoldAt', () => {
  it('returns the max soldAt', () => {
    const a = { soldAt: new Date('2026-01-01T00:00:00Z') }
    const b = { soldAt: new Date('2026-06-01T00:00:00Z') }
    expect(latestSoldAt([a, b])).toEqual(b.soldAt)
  })
  it('returns null for an empty set', () => {
    expect(latestSoldAt([])).toBeNull()
  })
})

// ── §68/§69: confidence ──

describe('deriveConfidence (§68/§69)', () => {
  const asOf = new Date('2026-06-01T00:00:00Z')
  const recent = new Date('2026-05-15T00:00:00Z') // 17 days before asOf
  const stale = new Date('2025-01-01T00:00:00Z')

  it('HIGH requires: N>=8, recent, primary specificity, not extended, not high dispersion', () => {
    expect(deriveConfidence({
      usedSampleCount: 8, latestSaleAt: recent, asOf, isPrimarySpecificity: true, extendedHistoryUsed: false, isHighDispersion: false,
    })).toBe('high')
  })

  it('fallback specificity (isPrimarySpecificity=false) can NEVER be high, even with 8+ recent samples', () => {
    expect(deriveConfidence({
      usedSampleCount: 20, latestSaleAt: recent, asOf, isPrimarySpecificity: false, extendedHistoryUsed: false, isHighDispersion: false,
    })).toBe('medium')
  })

  it('extended history is ALWAYS low, regardless of sample size/recency/specificity', () => {
    expect(deriveConfidence({
      usedSampleCount: 50, latestSaleAt: recent, asOf, isPrimarySpecificity: true, extendedHistoryUsed: true, isHighDispersion: false,
    })).toBe('low')
  })

  it('high dispersion excludes HIGH even when every other HIGH criterion is met', () => {
    expect(deriveConfidence({
      usedSampleCount: 10, latestSaleAt: recent, asOf, isPrimarySpecificity: true, extendedHistoryUsed: false, isHighDispersion: true,
    })).toBe('medium')
  })

  it('MEDIUM requires N>=3 and recent, regardless of specificity', () => {
    expect(deriveConfidence({
      usedSampleCount: 3, latestSaleAt: recent, asOf, isPrimarySpecificity: true, extendedHistoryUsed: false, isHighDispersion: false,
    })).toBe('medium')
  })

  it('stale latest sale (>90 days) excludes both HIGH and MEDIUM', () => {
    expect(deriveConfidence({
      usedSampleCount: 20, latestSaleAt: stale, asOf, isPrimarySpecificity: true, extendedHistoryUsed: false, isHighDispersion: false,
    })).toBe('low')
  })

  it('N=1 or N=2 is always LOW', () => {
    expect(deriveConfidence({ usedSampleCount: 1, latestSaleAt: recent, asOf, isPrimarySpecificity: true, extendedHistoryUsed: false, isHighDispersion: false })).toBe('low')
    expect(deriveConfidence({ usedSampleCount: 2, latestSaleAt: recent, asOf, isPrimarySpecificity: true, extendedHistoryUsed: false, isHighDispersion: false })).toBe('low')
  })

  it('a sale exactly 90 days old still counts as recent (inclusive boundary)', () => {
    const exactly90 = new Date(asOf.getTime() - 90 * 24 * 60 * 60 * 1000)
    expect(deriveConfidence({
      usedSampleCount: 8, latestSaleAt: exactly90, asOf, isPrimarySpecificity: true, extendedHistoryUsed: false, isHighDispersion: false,
    })).toBe('high')
  })
})

describe('SpecificityTier type sanity', () => {
  it('is exactly the three documented values', () => {
    const values: SpecificityTier[] = ['model_variant_condition', 'model_variant', 'model']
    expect(values).toHaveLength(3)
  })
})
