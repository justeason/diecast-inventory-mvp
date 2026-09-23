// 32C: behavioral tests for riskPricingQuery.ts — the ONE DB boundary manual
// mutation/risk code may use for canonical pricing evidence. getValuation is
// mocked at the function boundary (its own correctness is covered by
// marketValuation.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/marketValuation', () => ({ getValuation: vi.fn() }))

import { getValuation } from '@/lib/marketValuation'
import { fetchRiskPricingEvidence } from '@/lib/riskPricingQuery'

beforeEach(() => vi.resetAllMocks())

describe('fetchRiskPricingEvidence', () => {
  it('returns null when valuation is insufficient — no canonical range, never fabricated', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce({ status: 'insufficient_data' })
    const evidence = await fetchRiskPricingEvidence({ catalogModelId: 'cat1', asOf: new Date('2026-01-01') })
    expect(evidence).toBeNull()
  })

  it('builds full PricingEvidence from a valued result, using the canonical requested/resolved specificity', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce({
      status: 'valued', estimatedValueCents: 2000, marketRangeLowCents: 1800, marketRangeHighCents: 2200,
      confidence: 'high', extendedHistoryUsed: false, primarySpecificity: 'model_variant_condition', specificity: 'model_variant',
      rawSampleCount: 6, usedSampleCount: 5, excludedOutlierCount: 1, internalSampleCount: 4, externalSampleCount: 1,
    })
    const asOf = new Date('2026-01-01')
    const evidence = await fetchRiskPricingEvidence({ catalogModelId: 'cat1', asOf })
    expect(evidence).toEqual({
      asOf: asOf.toISOString(),
      estimatedValueCents: 2000, marketRangeLowCents: 1800, marketRangeHighCents: 2200,
      confidence: 'high', extendedHistoryUsed: false,
      requestedSpecificity: 'model_variant_condition', resolvedSpecificity: 'model_variant',
      rawSampleCount: 6, usedSampleCount: 5, excludedOutlierCount: 1, internalSampleCount: 4, externalSampleCount: 1,
    })
  })

  it('§30/§31/§51: a technical getValuation failure propagates uncaught — never converted to a silent null/allow', async () => {
    ;(getValuation as Mock).mockRejectedValueOnce(new Error('db unreachable'))
    await expect(fetchRiskPricingEvidence({ catalogModelId: 'cat1', asOf: new Date() })).rejects.toThrow('db unreachable')
  })

  it('passes marketVariantId/condition straight through — strongest requested specificity, no weakening', async () => {
    ;(getValuation as Mock).mockResolvedValueOnce({ status: 'insufficient_data' })
    await fetchRiskPricingEvidence({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: new Date() })
    expect(getValuation).toHaveBeenCalledWith({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: expect.any(Date) })
  })
})
