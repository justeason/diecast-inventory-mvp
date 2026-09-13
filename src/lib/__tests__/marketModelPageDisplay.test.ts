// 24B: pure display-logic helpers for the public Market Model Page — no
// Prisma, no React. Directly unit-tested (mirrors marketValuationMath.test.ts's
// convention of testing pure math separately from orchestration/rendering).
import { describe, it, expect } from 'vitest'
import {
  centsToDisplay,
  saleSourceLabel,
  formatEvidenceLine,
  isFallbackSpecificity,
  resolveLastSaleDisplay,
  computeChartPoints,
  PACKAGING_LABELS,
  CONDITION_LABELS,
} from '@/lib/marketModelPageDisplay'
import type { MarketSaleObservation } from '@/lib/marketSaleQuery'
import type { ValuationResult } from '@/lib/marketValuation'

function internalSale(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'internal' }>> = {}): MarketSaleObservation {
  return {
    observationId: 'internal:oi1', sourceType: 'internal', sourceRecordId: 'oi1',
    catalogModelId: 'cat1', marketVariantId: 'v1', packagingType: 'carded', condition: 'mint',
    snapshotProvenance: 'sale_time', priceCents: 1000, currency: 'USD', soldAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

function externalSale(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'external' }>> = {}): MarketSaleObservation {
  return {
    observationId: 'external:obs1', sourceType: 'external', sourceRecordId: 'obs1',
    provider: 'ebay', matchMethod: 'manual', catalogModelId: 'cat1', marketVariantId: null,
    packagingType: null, condition: null, priceCents: 1500, currency: 'USD', soldAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  }
}

function valued(overrides: Partial<Extract<ValuationResult, { status: 'valued' }>> = {}): Extract<ValuationResult, { status: 'valued' }> {
  return {
    status: 'valued',
    catalogModelId: 'cat1', marketVariantId: null, condition: null,
    estimatedValueCents: 1000, marketRangeLowCents: null, marketRangeHighCents: null,
    confidence: 'low', specificity: 'model', primarySpecificity: 'model',
    rawSampleCount: 1, usedSampleCount: 1, excludedOutlierCount: 0,
    internalSampleCount: 1, externalSampleCount: 0,
    asOf: new Date('2026-06-01T00:00:00Z'), windowStart: new Date('2024-06-01T00:00:00Z'),
    extendedHistoryUsed: false, sampleTruncated: false,
    method: 'median_sales', outlierMethod: 'none', fallbackReason: null,
    latestSaleAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

describe('centsToDisplay', () => {
  it('formats integer cents as a 2dp dollar string', () => {
    expect(centsToDisplay(1000)).toBe('$10.00')
    expect(centsToDisplay(999)).toBe('$9.99')
  })
})

describe('saleSourceLabel — public labeling, never raw provider (§22/§24/§89)', () => {
  it('internal -> CollectNTrades', () => {
    expect(saleSourceLabel(internalSale())).toBe('CollectNTrades')
  })

  it('external -> External marketplace, never the raw provider string', () => {
    const label = saleSourceLabel(externalSale({ provider: 'some-messy-admin-import-tag' }))
    expect(label).toBe('External marketplace')
    expect(label).not.toContain('some-messy-admin-import-tag')
  })
})

describe('formatEvidenceLine — conditional source disclosure (§18/§19)', () => {
  it('internal only, singular', () => {
    const v = valued({ usedSampleCount: 1, internalSampleCount: 1, externalSampleCount: 0 })
    expect(formatEvidenceLine(v)).toBe('Based on 1 CollectNTrades comparable sale.')
  })

  it('internal only, plural', () => {
    const v = valued({ usedSampleCount: 4, internalSampleCount: 4, externalSampleCount: 0 })
    expect(formatEvidenceLine(v)).toBe('Based on 4 CollectNTrades comparable sales.')
  })

  it('external only', () => {
    const v = valued({ usedSampleCount: 3, internalSampleCount: 0, externalSampleCount: 3 })
    expect(formatEvidenceLine(v)).toBe('Based on 3 comparable sales from tracked external marketplaces.')
  })

  it('mixed internal + external', () => {
    const v = valued({ usedSampleCount: 8, internalSampleCount: 3, externalSampleCount: 5 })
    expect(formatEvidenceLine(v)).toBe('Based on 8 comparable sales from CollectNTrades and tracked external marketplaces.')
  })

  it('never universally claims both sources when only one contributed', () => {
    const v = valued({ usedSampleCount: 2, internalSampleCount: 2, externalSampleCount: 0 })
    expect(formatEvidenceLine(v)).not.toContain('external')
  })

  it('outliers excluded — truthful count appended, singular', () => {
    const v = valued({ usedSampleCount: 7, internalSampleCount: 7, externalSampleCount: 0, excludedOutlierCount: 1 })
    expect(formatEvidenceLine(v)).toBe('Based on 7 CollectNTrades comparable sales; 1 unusual result excluded.')
  })

  it('outliers excluded — truthful count appended, plural', () => {
    const v = valued({ usedSampleCount: 6, internalSampleCount: 6, externalSampleCount: 0, excludedOutlierCount: 2 })
    expect(formatEvidenceLine(v)).toBe('Based on 6 CollectNTrades comparable sales; 2 unusual results excluded.')
  })

  it('no outlier clause when excludedOutlierCount is 0', () => {
    const v = valued({ usedSampleCount: 5, internalSampleCount: 5, externalSampleCount: 0, excludedOutlierCount: 0 })
    expect(formatEvidenceLine(v)).not.toContain('excluded')
  })
})

describe('isFallbackSpecificity (§9/§83)', () => {
  it('false when specificity matches the requested primarySpecificity (model-level default request)', () => {
    expect(isFallbackSpecificity(valued({ specificity: 'model', primarySpecificity: 'model' }))).toBe(false)
  })

  it('true when a variant-selected request broadened to a wider tier', () => {
    expect(isFallbackSpecificity(valued({ specificity: 'model', primarySpecificity: 'model_variant' }))).toBe(true)
  })
})

describe('resolveLastSaleDisplay (§22/§23/§69/§70)', () => {
  it('latest overall sale is internal -> no second identical row, no "no CollectNTrades sales" note', () => {
    const result = resolveLastSaleDisplay(internalSale(), internalSale())
    expect(result.showLastInternalRow).toBe(false)
    expect(result.showNoInternalSalesNote).toBe(false)
  })

  it('latest overall sale is external and an internal sale exists -> show both', () => {
    const result = resolveLastSaleDisplay(externalSale(), internalSale())
    expect(result.showLastInternalRow).toBe(true)
    expect(result.showNoInternalSalesNote).toBe(false)
  })

  it('latest overall sale is external and no internal sale exists -> compact "no CollectNTrades sales" note, no internal row', () => {
    const result = resolveLastSaleDisplay(externalSale(), null)
    expect(result.showLastInternalRow).toBe(false)
    expect(result.showNoInternalSalesNote).toBe(true)
  })

  it('no market sale at all -> neither row, no redundant empty state', () => {
    const result = resolveLastSaleDisplay(null, null)
    expect(result.showLastInternalRow).toBe(false)
    expect(result.showNoInternalSalesNote).toBe(false)
  })
})

describe('computeChartPoints — discrete scatter, no divide-by-zero (§34/§35/§75)', () => {
  const basePoint = { priceCents: 1000, sourceType: 'internal' as const }

  it('0 points -> empty array, no crash', () => {
    expect(computeChartPoints([], 300, 100, 10)).toEqual([])
  })

  it('1 point -> finite, in-bounds coordinates', () => {
    const points = computeChartPoints([{ ...basePoint, soldAt: new Date('2026-01-01') }], 300, 100, 10)
    expect(points).toHaveLength(1)
    expect(Number.isFinite(points[0].x)).toBe(true)
    expect(Number.isFinite(points[0].y)).toBe(true)
  })

  it('all points same timestamp -> no division by zero, all centered on x', () => {
    const t = new Date('2026-01-01')
    const points = computeChartPoints(
      [{ ...basePoint, soldAt: t, priceCents: 1000 }, { ...basePoint, soldAt: t, priceCents: 2000 }],
      300, 100, 10,
    )
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
    expect(points[0].x).toBe(points[1].x)
  })

  it('all points same price -> no division by zero, all centered on y', () => {
    const points = computeChartPoints(
      [
        { ...basePoint, soldAt: new Date('2026-01-01'), priceCents: 1000 },
        { ...basePoint, soldAt: new Date('2026-06-01'), priceCents: 1000 },
      ],
      300, 100, 10,
    )
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
    expect(points[0].y).toBe(points[1].y)
  })

  it('multiple sales same day all remain represented (no dedup/merge)', () => {
    const d = new Date('2026-03-01T00:00:00Z')
    const points = computeChartPoints(
      [
        { ...basePoint, soldAt: d, priceCents: 1000 },
        { ...basePoint, soldAt: d, priceCents: 1200 },
        { ...basePoint, soldAt: d, priceCents: 900 },
      ],
      300, 100, 10,
    )
    expect(points).toHaveLength(3)
  })

  it('wide date span scales linearly, never NaN', () => {
    const points = computeChartPoints(
      [
        { ...basePoint, soldAt: new Date('2018-01-01'), priceCents: 500 },
        { ...basePoint, soldAt: new Date('2026-06-01'), priceCents: 5000 },
      ],
      300, 100, 10,
    )
    for (const p of points) {
      expect(Number.isNaN(p.x)).toBe(false)
      expect(Number.isNaN(p.y)).toBe(false)
    }
  })
})

describe('PACKAGING_LABELS / CONDITION_LABELS — normalized display only', () => {
  it('has Carded/Loose labels', () => {
    expect(PACKAGING_LABELS.carded).toBe('Carded')
    expect(PACKAGING_LABELS.loose).toBe('Loose')
  })

  it('has the six-value condition vocabulary', () => {
    expect(CONDITION_LABELS.mint).toBe('Mint')
    expect(CONDITION_LABELS.damaged).toBe('Damaged')
  })
})
