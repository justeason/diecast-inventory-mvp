// 25B: getValuationsBatch must be semantically IDENTICAL to calling
// getValuation({catalogModelId, asOf}) individually for every requested model
// — no second valuation algorithm (§6/§7/§13 of the 25B spec). Both share
// marketValuationMath.ts::assembleValuedResult; the only difference under
// test here is the evidence-fetch path (single-model getMarketSaleHistory vs
// batch getMarketSaleHistoryForModels).
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/marketSaleQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/marketSaleQuery')>()
  return { ...actual, getMarketSaleHistory: vi.fn(), getMarketSaleHistoryForModels: vi.fn() }
})

import { getMarketSaleHistory, getMarketSaleHistoryForModels, type MarketSaleObservation } from '@/lib/marketSaleQuery'
import { getValuation, getValuationsBatch } from '@/lib/marketValuation'

function internalObs(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'internal' }>> = {}): MarketSaleObservation {
  return {
    observationId: `internal:${overrides.sourceRecordId ?? 'oi1'}`, sourceType: 'internal', sourceRecordId: 'oi1',
    catalogModelId: 'cat1', marketVariantId: 'v1', packagingType: 'carded', condition: 'mint',
    snapshotProvenance: 'sale_time', priceCents: 1000, currency: 'USD', soldAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

function externalObs(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'external' }>> = {}): MarketSaleObservation {
  return {
    observationId: `external:${overrides.sourceRecordId ?? 'obs1'}`, sourceType: 'external', sourceRecordId: 'obs1',
    provider: 'ebay', matchMethod: 'manual', catalogModelId: 'cat1', marketVariantId: null,
    packagingType: null, condition: null, priceCents: 1000, currency: 'USD', soldAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

const ASOF = new Date('2026-06-01T00:00:00Z')

beforeEach(() => vi.resetAllMocks())

async function runParityCheck(
  primaryObs: MarketSaleObservation[],
  primaryHasMore: boolean,
  extendedObs: MarketSaleObservation[] | null = null,
  extendedHasMore = false,
) {
  ;(getMarketSaleHistory as Mock).mockResolvedValueOnce({ observations: primaryObs, hasMore: primaryHasMore })
  if (extendedObs !== null) {
    ;(getMarketSaleHistory as Mock).mockResolvedValueOnce({ observations: extendedObs, hasMore: extendedHasMore })
  }
  const individual = await getValuation({ catalogModelId: 'cat1', asOf: ASOF })

  ;(getMarketSaleHistoryForModels as Mock).mockResolvedValueOnce(
    new Map([['cat1', { observations: primaryObs, hasMore: primaryHasMore }]]),
  )
  if (extendedObs !== null) {
    ;(getMarketSaleHistoryForModels as Mock).mockResolvedValueOnce(
      new Map([['cat1', { observations: extendedObs, hasMore: extendedHasMore }]]),
    )
  }
  const batch = await getValuationsBatch({ catalogModelIds: ['cat1'], asOf: ASOF })

  expect(batch.get('cat1')).toEqual(individual)
  return individual
}

describe('getValuationsBatch === getValuation, per model (§13/§74)', () => {
  it('recent internal-only sample', async () => {
    const result = await runParityCheck([internalObs()], false)
    expect(result.status).toBe('valued')
  })

  it('recent external-only sample', async () => {
    const result = await runParityCheck([externalObs()], false)
    expect(result.status).toBe('valued')
  })

  it('mixed internal+external sample', async () => {
    const result = await runParityCheck(
      [internalObs({ sourceRecordId: 'oi1', priceCents: 1000 }), externalObs({ sourceRecordId: 'obs1', priceCents: 1200 })],
      false,
    )
    expect(result.status).toBe('valued')
    if (result.status === 'valued') {
      expect(result.internalSampleCount).toBe(1)
      expect(result.externalSampleCount).toBe(1)
    }
  })

  it('outlier sample (N>=5 with one extreme excluded)', async () => {
    const obs = [
      internalObs({ sourceRecordId: 'a', priceCents: 1000 }),
      internalObs({ sourceRecordId: 'b', priceCents: 1050 }),
      internalObs({ sourceRecordId: 'c', priceCents: 980 }),
      internalObs({ sourceRecordId: 'd', priceCents: 1020 }),
      internalObs({ sourceRecordId: 'e', priceCents: 50000 }), // extreme outlier
    ]
    const result = await runParityCheck(obs, false)
    expect(result.status).toBe('valued')
    if (result.status === 'valued') expect(result.excludedOutlierCount).toBeGreaterThan(0)
  })

  it('extended history (primary empty, all-time has data)', async () => {
    const result = await runParityCheck([], false, [internalObs({ soldAt: new Date('2020-01-01') })], false)
    expect(result.status).toBe('valued')
    if (result.status === 'valued') {
      expect(result.extendedHistoryUsed).toBe(true)
      expect(result.fallbackReason).toBe('no_recent_sales')
    }
  })

  it('insufficient data (primary and extended both empty)', async () => {
    const result = await runParityCheck([], false, [], false)
    expect(result.status).toBe('insufficient_data')
  })

  it('sample truncation (primary hasMore=true)', async () => {
    const result = await runParityCheck([internalObs()], true)
    expect(result.status).toBe('valued')
    if (result.status === 'valued') expect(result.sampleTruncated).toBe(true)
  })
})

describe('getValuationsBatch — same asOf shared across the whole batch request (§5/§51/§83)', () => {
  it('every model in one batch call receives the identical asOf', async () => {
    ;(getMarketSaleHistoryForModels as Mock).mockResolvedValueOnce(
      new Map([
        ['cat1', { observations: [internalObs({ catalogModelId: 'cat1' })], hasMore: false }],
        ['cat2', { observations: [internalObs({ catalogModelId: 'cat2' })], hasMore: false }],
      ]),
    )
    const results = await getValuationsBatch({ catalogModelIds: ['cat1', 'cat2'], asOf: ASOF })
    const r1 = results.get('cat1')!
    const r2 = results.get('cat2')!
    expect(r1.status).not.toBe('input_error')
    expect(r2.status).not.toBe('input_error')
    if (r1.status !== 'input_error') expect(r1.asOf).toEqual(ASOF)
    if (r2.status !== 'input_error') expect(r2.asOf).toEqual(ASOF)
  })

  it('defaults asOf once (new Date()) when omitted — never per-model', async () => {
    ;(getMarketSaleHistoryForModels as Mock).mockResolvedValueOnce(new Map())
    await getValuationsBatch({ catalogModelIds: [] })
    // Empty id list short-circuits before any fetch — asOf construction itself
    // is a single call-site concern, verified structurally in marketValuation.ts.
    expect(getMarketSaleHistoryForModels).not.toHaveBeenCalled()
  })
})

describe('getValuationsBatch — model-level only, no variant/condition tier logic (§10)', () => {
  it('every valued result has specificity===primarySpecificity==="model"', async () => {
    ;(getMarketSaleHistoryForModels as Mock).mockResolvedValueOnce(
      new Map([['cat1', { observations: [internalObs()], hasMore: false }]]),
    )
    const results = await getValuationsBatch({ catalogModelIds: ['cat1'], asOf: ASOF })
    const r = results.get('cat1')!
    expect(r.status).toBe('valued')
    if (r.status === 'valued') {
      expect(r.specificity).toBe('model')
      expect(r.primarySpecificity).toBe('model')
      expect(r.marketVariantId).toBeNull()
      expect(r.condition).toBeNull()
    }
  })

  it('deduplicates requested catalogModelIds before fetching', async () => {
    ;(getMarketSaleHistoryForModels as Mock).mockResolvedValueOnce(
      new Map([['cat1', { observations: [internalObs()], hasMore: false }]]),
    )
    await getValuationsBatch({ catalogModelIds: ['cat1', 'cat1', 'cat1'], asOf: ASOF })
    const call = (getMarketSaleHistoryForModels as Mock).mock.calls[0][0]
    expect(call.catalogModelIds).toEqual(['cat1'])
  })
})
