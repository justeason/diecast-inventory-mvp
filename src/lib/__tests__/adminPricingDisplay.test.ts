// 32B: pure-function tests for adminPricingDisplay.ts. No DB, no mocking.
import { describe, it, expect } from 'vitest'
import {
  ADMIN_CONFIDENCE_LABELS,
  describeSpecificityFallback,
  classifyPriceVsMarketRange,
  PRICE_VS_RANGE_LABELS,
  parsePriceInputToCents,
} from '@/lib/adminPricingDisplay'
import type { ValuationResult } from '@/lib/marketValuation'

type ValuedResult = Extract<ValuationResult, { status: 'valued' }>

function valued(overrides: Partial<ValuedResult> = {}): ValuedResult {
  return {
    status: 'valued',
    catalogModelId: 'cat1',
    marketVariantId: 'v1',
    condition: 'mint',
    estimatedValueCents: 2000,
    marketRangeLowCents: 1800,
    marketRangeHighCents: 2200,
    confidence: 'high',
    specificity: 'model_variant_condition',
    primarySpecificity: 'model_variant_condition',
    rawSampleCount: 8,
    usedSampleCount: 8,
    excludedOutlierCount: 0,
    internalSampleCount: 8,
    externalSampleCount: 0,
    asOf: new Date(),
    windowStart: new Date(),
    extendedHistoryUsed: false,
    sampleTruncated: false,
    method: 'median_sales',
    outlierMethod: 'iqr_1_5',
    fallbackReason: null,
    latestSaleAt: new Date(),
    ...overrides,
  }
}

describe('ADMIN_CONFIDENCE_LABELS', () => {
  it('has exactly the 3 canonical confidence values — no legacy 4th "insufficient" entry', () => {
    expect(Object.keys(ADMIN_CONFIDENCE_LABELS).sort()).toEqual(['high', 'low', 'medium'])
  })
})

describe('describeSpecificityFallback', () => {
  it('returns null for an exact-specificity result (no fallback)', () => {
    expect(describeSpecificityFallback(valued())).toBeNull()
  })

  it('reuses the exact customer-facing model-level fallback copy', () => {
    const msg = describeSpecificityFallback(valued({ specificity: 'model', primarySpecificity: 'model_variant_condition' }))
    expect(msg).toBe('Not enough packaging-specific sales — using broader model-level sales due to limited packaging-specific history.')
  })

  it('reuses the exact customer-facing condition-level fallback copy', () => {
    const msg = describeSpecificityFallback(valued({ specificity: 'model_variant', primarySpecificity: 'model_variant_condition' }))
    expect(msg).toBe('Not enough sales at the exact condition — using packaging-level sales across all conditions.')
  })

  it('never uses fair/unfair/underpriced/overpriced language', () => {
    const msg = describeSpecificityFallback(valued({ specificity: 'model', primarySpecificity: 'model_variant' }))!
    expect(msg.toLowerCase()).not.toMatch(/fair|unfair|underpriced|overpriced|good deal|bad deal/)
  })
})

describe('classifyPriceVsMarketRange', () => {
  it('classifies below/within/above with exact bounds — no ±5% tolerance band', () => {
    expect(classifyPriceVsMarketRange(1799, 1800, 2200)).toBe('below_range')
    expect(classifyPriceVsMarketRange(1800, 1800, 2200)).toBe('within_range') // inclusive lower bound
    expect(classifyPriceVsMarketRange(2000, 1800, 2200)).toBe('within_range')
    expect(classifyPriceVsMarketRange(2200, 1800, 2200)).toBe('within_range') // inclusive upper bound
    expect(classifyPriceVsMarketRange(2201, 1800, 2200)).toBe('above_range')
  })

  it('returns null when no Market Range exists to compare against', () => {
    expect(classifyPriceVsMarketRange(2000, null, 2200)).toBeNull()
    expect(classifyPriceVsMarketRange(2000, 1800, null)).toBeNull()
    expect(classifyPriceVsMarketRange(2000, null, null)).toBeNull()
  })
})

describe('PRICE_VS_RANGE_LABELS', () => {
  it('uses plain, non-judgmental copy — never fair/unfair/underpriced/overpriced/good deal/bad deal', () => {
    for (const label of Object.values(PRICE_VS_RANGE_LABELS)) {
      expect(label.toLowerCase()).not.toMatch(/fair|unfair|underpriced|overpriced|good deal|bad deal/)
    }
    expect(PRICE_VS_RANGE_LABELS.below_range).toBe('Below Market Range')
    expect(PRICE_VS_RANGE_LABELS.within_range).toBe('Within Market Range')
    expect(PRICE_VS_RANGE_LABELS.above_range).toBe('Above Market Range')
  })
})

describe('parsePriceInputToCents', () => {
  it('parses a valid price string via the canonical Float-dollars-to-cents boundary', () => {
    expect(parsePriceInputToCents('19.99')).toBe(1999)
    expect(parsePriceInputToCents('0')).toBe(0)
  })

  it('returns null for empty/invalid/negative input — never NaN or a fabricated value', () => {
    expect(parsePriceInputToCents('')).toBeNull()
    expect(parsePriceInputToCents('abc')).toBeNull()
    expect(parsePriceInputToCents('-5')).toBeNull()
  })
})
