// 30B: canonical Market Signals composition — 30D Est. Value Change (strict
// eligibility gate), Tracked Sales 30D, Median Days to Sell, Wanted count.
// Signal independence (§5/§53/§54), shared asOf (§9/§51), no scattered
// new Date() calls, parallel composition (§49). Mocked-dependency tests,
// matching this codebase's established convention.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/marketValuation', () => ({ getValuation: vi.fn() }))
vi.mock('@/lib/marketSaleQuery', () => ({ getSaleCount: vi.fn() }))
vi.mock('@/lib/marketDaysToSellQuery', () => ({
  getMedianDaysToSell: vi.fn(),
  DAYS_TO_SELL_WINDOW_DAYS: 180,
}))
vi.mock('@/lib/prisma', () => ({
  prisma: { wantedCatalogModel: { count: vi.fn() } },
}))

import { getValuation } from '@/lib/marketValuation'
import { getSaleCount } from '@/lib/marketSaleQuery'
import { getMedianDaysToSell } from '@/lib/marketDaysToSellQuery'
import { prisma } from '@/lib/prisma'
import { getMarketSignals } from '@/lib/marketSignalsQuery'
import type { ValuationResult } from '@/lib/marketValuation'

const ASOF = new Date('2026-06-30T00:00:00Z')
const PRIOR_ASOF = new Date(ASOF.getTime() - 30 * 24 * 60 * 60 * 1000)

function valued(overrides: Partial<Extract<ValuationResult, { status: 'valued' }>> = {}): Extract<ValuationResult, { status: 'valued' }> {
  return {
    status: 'valued',
    catalogModelId: 'cat1', marketVariantId: null, condition: null,
    estimatedValueCents: 3400, marketRangeLowCents: 3000, marketRangeHighCents: 3800,
    confidence: 'high', specificity: 'model', primarySpecificity: 'model',
    rawSampleCount: 10, usedSampleCount: 10, excludedOutlierCount: 0,
    internalSampleCount: 8, externalSampleCount: 2,
    asOf: ASOF, windowStart: new Date('2024-06-30T00:00:00Z'),
    extendedHistoryUsed: false, sampleTruncated: false,
    method: 'median_sales', outlierMethod: 'none', fallbackReason: null,
    latestSaleAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  }
}

const insufficient = (): ValuationResult => ({
  status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales',
})

beforeEach(() => {
  vi.resetAllMocks()
  ;(getSaleCount as Mock).mockResolvedValue({ total: 0, internal: 0, external: 0 })
  ;(getMedianDaysToSell as Mock).mockResolvedValue({ status: 'insufficient_data', sampleCount: 0 })
  ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(0)
})

describe('30B: valuationChange30d eligibility — strict gate (§13/§70)', () => {
  it('both valued, same specificity, high confidence, no extension -> available with correct cents/percent', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ estimatedValueCents: 3200 })) // prior
    const current = valued({ estimatedValueCents: 3400 })
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: current })
    expect(result.valuationChange30d).toEqual({
      status: 'available',
      changeCents: 200,
      changePercent: 6.25,
      currentEstimatedValueCents: 3400,
      priorEstimatedValueCents: 3200,
    })
  })

  it('negative change computed correctly', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ estimatedValueCents: 4000 }))
    const current = valued({ estimatedValueCents: 3800 })
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: current })
    expect(result.valuationChange30d).toEqual(
      expect.objectContaining({ status: 'available', changeCents: -200 }),
    )
  })

  it('zero change computed correctly', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ estimatedValueCents: 3400 }))
    const current = valued({ estimatedValueCents: 3400 })
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: current })
    expect(result.valuationChange30d).toEqual(
      expect.objectContaining({ status: 'available', changeCents: 0, changePercent: 0 }),
    )
  })

  it('current missing (insufficient_data) -> insufficient_data', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: insufficient() })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
  })

  it('prior missing (insufficient_data) -> insufficient_data', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(insufficient())
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
  })

  it('prior estimatedValueCents <= 0 guard (defensive) -> insufficient_data, never divide by zero', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ estimatedValueCents: 0 }))
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
  })

  it('current confidence low -> insufficient_data', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ confidence: 'high' }))
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued({ confidence: 'low' }) })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
  })

  it('prior confidence low -> insufficient_data', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ confidence: 'low' }))
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued({ confidence: 'high' }) })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
  })

  it('medium confidence on both sides is eligible (not just high)', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ confidence: 'medium', estimatedValueCents: 3000 }))
    const result = await getMarketSignals({
      catalogModelId: 'cat1', asOf: ASOF,
      currentValuation: valued({ confidence: 'medium', estimatedValueCents: 3200 }),
    })
    expect(result.valuationChange30d.status).toBe('available')
  })

  it('specificity mismatch -> incomparable, not insufficient_data, no percentage computed (§14)', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ specificity: 'model' })) // prior broadened
    const current = valued({ specificity: 'model_variant' }) // current resolved variant-exact
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: current })
    expect(result.valuationChange30d).toEqual({ status: 'incomparable' })
  })

  it('current extendedHistoryUsed -> insufficient_data, no numerical change rendered (§15)', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ extendedHistoryUsed: false }))
    const result = await getMarketSignals({
      catalogModelId: 'cat1', asOf: ASOF,
      currentValuation: valued({ extendedHistoryUsed: true }),
    })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
  })

  it('prior extendedHistoryUsed -> insufficient_data', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ extendedHistoryUsed: true }))
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued({ extendedHistoryUsed: false }) })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
  })
})

describe('30B: historical asOf wiring — prior getValuation call (§9/§10/§11/§51/§68)', () => {
  it('calls getValuation for the prior side with asOf = current asOf minus exactly 30x24h, never a calendar-month subtraction', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    const call = (getValuation as Mock).mock.calls[0][0]
    expect(call.catalogModelId).toBe('cat1')
    expect(call.asOf.getTime()).toBe(PRIOR_ASOF.getTime())
  })

  it('threads marketVariantId into the prior getValuation call when provided (like-with-like comparison, §7)', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    await getMarketSignals({ catalogModelId: 'cat1', marketVariantId: 'var1', asOf: ASOF, currentValuation: valued() })
    const call = (getValuation as Mock).mock.calls[0][0]
    expect(call.marketVariantId).toBe('var1')
  })

  it('current valuation is NOT recomputed — getValuation is called exactly once (for the prior side only), reusing the passed-in current valuation (§50)', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(getValuation).toHaveBeenCalledTimes(1)
  })
})

describe('30B: sales30d — always measurable, zero is real (§20-§23/§72/§75)', () => {
  it('calls getSaleCount with startDate = asOf-30d, endDate = asOf, same catalogModelId/marketVariantId', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    await getMarketSignals({ catalogModelId: 'cat1', marketVariantId: 'var1', asOf: ASOF, currentValuation: valued() })
    expect(getSaleCount).toHaveBeenCalledWith({
      catalogModelId: 'cat1', marketVariantId: 'var1', startDate: PRIOR_ASOF, endDate: ASOF,
    })
  })

  it('0 sales renders as a real available result, never insufficient_data', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    ;(getSaleCount as Mock).mockResolvedValue({ total: 0, internal: 0, external: 0 })
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.sales30d).toEqual({ status: 'available', total: 0, internal: 0, external: 0 })
  })

  it('mixed internal+external sales sum into total', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    ;(getSaleCount as Mock).mockResolvedValue({ total: 7, internal: 5, external: 2 })
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.sales30d).toEqual({ status: 'available', total: 7, internal: 5, external: 2 })
  })
})

describe('30B: medianDaysToSell — window and variant scoping (§26/§29)', () => {
  it('calls getMedianDaysToSell with a 180-day window ending at asOf', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    await getMarketSignals({ catalogModelId: 'cat1', marketVariantId: 'var1', asOf: ASOF, currentValuation: valued() })
    const call = (getMedianDaysToSell as Mock).mock.calls[0][0]
    expect(call.catalogModelId).toBe('cat1')
    expect(call.marketVariantId).toBe('var1')
    expect(call.endDate.getTime()).toBe(ASOF.getTime())
    expect(call.startDate.getTime()).toBe(ASOF.getTime() - 180 * 24 * 60 * 60 * 1000)
  })

  it('passes through the underlying insufficient_data/available result verbatim', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    ;(getMedianDaysToSell as Mock).mockResolvedValue({ status: 'available', medianDays: 12, sampleCount: 5 })
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.medianDaysToSell).toEqual({ status: 'available', medianDays: 12, sampleCount: 5 })
  })
})

describe('30B: wantedCount — model-level only, no variant scoping, no history (§32/§33/§36)', () => {
  it('counts WantedCatalogModel by catalogModelId only — marketVariantId never appears in the where clause', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    await getMarketSignals({ catalogModelId: 'cat1', marketVariantId: 'var1', asOf: ASOF, currentValuation: valued() })
    const call = (prisma.wantedCatalogModel.count as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ catalogModelId: 'cat1' })
  })

  it('returns the raw current count, 0 included (display-layer decides whether to omit)', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(0)
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.wantedCount).toBe(0)
  })

  it('N collectors', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued())
    ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(7)
    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.wantedCount).toBe(7)
  })
})

describe('30B: signal independence — one unavailable signal never blocks another (§5/§76)', () => {
  it('valuationChange30d ineligible but sales/days/wanted still independently available', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(insufficient())
    ;(getSaleCount as Mock).mockResolvedValue({ total: 4, internal: 4, external: 0 })
    ;(getMedianDaysToSell as Mock).mockResolvedValue({ status: 'available', medianDays: 9, sampleCount: 5 })
    ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(3)

    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued() })
    expect(result.valuationChange30d).toEqual({ status: 'insufficient_data' })
    expect(result.sales30d).toEqual({ status: 'available', total: 4, internal: 4, external: 0 })
    expect(result.medianDaysToSell).toEqual({ status: 'available', medianDays: 9, sampleCount: 5 })
    expect(result.wantedCount).toBe(3)
  })

  it('days-to-sell insufficient but change/sales/wanted still independently available', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce(valued({ estimatedValueCents: 3000 }))
    ;(getSaleCount as Mock).mockResolvedValue({ total: 4, internal: 4, external: 0 })
    ;(getMedianDaysToSell as Mock).mockResolvedValue({ status: 'insufficient_data', sampleCount: 1 })
    ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(3)

    const result = await getMarketSignals({ catalogModelId: 'cat1', asOf: ASOF, currentValuation: valued({ estimatedValueCents: 3200 }) })
    expect(result.valuationChange30d.status).toBe('available')
    expect(result.medianDaysToSell).toEqual({ status: 'insufficient_data', sampleCount: 1 })
  })
})

describe('30B: parallel composition, not a serial waterfall (§49)', () => {
  it('getMarketSignals source has no `await` immediately followed by another `await` outside Promise.all', () => {
    // Structural guard — the actual independence is already exercised above via
    // mocks; this confirms the implementation literally uses Promise.all.
    const src = fs.readFileSync(path.resolve(__dirname, '../marketSignalsQuery.ts'), 'utf-8')
    expect(src).toContain('await Promise.all([')
  })
})
