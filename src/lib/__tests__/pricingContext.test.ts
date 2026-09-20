// 31B: canonical Pricing Intelligence V2 — Pricing Context composition.
// Mocked-dependency tests (getValuation/getInternalAskSummary mocked), matching
// this codebase's established convention for composition-layer modules (see
// marketQuoteQuery.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/marketValuation', () => ({ getValuation: vi.fn() }))
vi.mock('@/lib/marketAskQuery', () => ({ getInternalAskSummary: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { getValuation } from '@/lib/marketValuation'
import { getInternalAskSummary } from '@/lib/marketAskQuery'
import { getPricingContext } from '@/lib/pricingContext'
import { prisma } from '@/lib/prisma'
import type { ValuationResult } from '@/lib/marketValuation'

const ASOF = new Date('2026-06-01T00:00:00Z')

function valued(overrides: Partial<Extract<ValuationResult, { status: 'valued' }>> = {}): Extract<ValuationResult, { status: 'valued' }> {
  return {
    status: 'valued',
    catalogModelId: 'cat1', marketVariantId: null, condition: null,
    estimatedValueCents: 1500, marketRangeLowCents: 1000, marketRangeHighCents: 2000,
    confidence: 'high', specificity: 'model', primarySpecificity: 'model',
    rawSampleCount: 8, usedSampleCount: 8, excludedOutlierCount: 0,
    internalSampleCount: 5, externalSampleCount: 3,
    asOf: ASOF, windowStart: new Date('2024-06-01T00:00:00Z'),
    extendedHistoryUsed: false, sampleTruncated: false,
    method: 'median_sales', outlierMethod: 'none', fallbackReason: null,
    latestSaleAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

const insufficient = (): ValuationResult => ({
  status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales',
})

beforeEach(() => {
  vi.resetAllMocks()
  ;(getInternalAskSummary as Mock).mockResolvedValue({ lowestAskCents: null, medianAskCents: null, availableCopies: 0 })
})

describe('getPricingContext — composition wiring', () => {
  it('calls getValuation and getInternalAskSummary with the same catalogModelId/marketVariantId, in parallel', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued())
    await getPricingContext({ catalogModelId: 'cat1', marketVariantId: 'var1', asOf: ASOF })
    expect(getValuation).toHaveBeenCalledWith({ catalogModelId: 'cat1', marketVariantId: 'var1', asOf: ASOF }, prisma)
    expect(getInternalAskSummary).toHaveBeenCalledWith({ catalogModelId: 'cat1', marketVariantId: 'var1' }, prisma)
  })

  it('condition is passed to getValuation but never to getInternalAskSummary (asks are never condition-scoped)', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued())
    await getPricingContext({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF })
    expect(getValuation).toHaveBeenCalledWith({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF }, prisma)
    const askCall = (getInternalAskSummary as Mock).mock.calls[0][0]
    expect(askCall.condition).toBeUndefined()
  })

  it('asOf is passed straight through — no default/fallback new Date()', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued())
    const context = await getPricingContext({ catalogModelId: 'cat1', asOf: ASOF })
    expect(context.asOf).toBe(ASOF)
  })
})

describe('getPricingContext — specificity disclosure (31B §55)', () => {
  it('model-only request: requested=model, resolved=model, exactMatch=true', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued({ specificity: 'model', primarySpecificity: 'model' }))
    const context = await getPricingContext({ catalogModelId: 'cat1', asOf: ASOF })
    expect(context.specificityDisclosure).toEqual({ requested: 'model', resolved: 'model', exactMatch: true })
  })

  it('condition requested, condition resolved: exactMatch=true', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued({ specificity: 'model_variant_condition', primarySpecificity: 'model_variant_condition' }))
    const context = await getPricingContext({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF })
    expect(context.specificityDisclosure).toEqual({ requested: 'model_variant_condition', resolved: 'model_variant_condition', exactMatch: true })
  })

  it('condition requested, variant resolved (within-model fallback): exactMatch=false, fallback never hidden', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued({ specificity: 'model_variant', primarySpecificity: 'model_variant_condition' }))
    const context = await getPricingContext({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF })
    expect(context.specificityDisclosure).toEqual({ requested: 'model_variant_condition', resolved: 'model_variant', exactMatch: false })
  })

  it('condition requested, model resolved (double fallback): exactMatch=false', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued({ specificity: 'model', primarySpecificity: 'model_variant_condition' }))
    const context = await getPricingContext({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF })
    expect(context.specificityDisclosure).toEqual({ requested: 'model_variant_condition', resolved: 'model', exactMatch: false })
  })

  it('variant requested, model resolved: exactMatch=false', async () => {
    ;(getValuation as Mock).mockResolvedValue(valued({ specificity: 'model', primarySpecificity: 'model_variant' }))
    const context = await getPricingContext({ catalogModelId: 'cat1', marketVariantId: 'var1', asOf: ASOF })
    expect(context.specificityDisclosure).toEqual({ requested: 'model_variant', resolved: 'model', exactMatch: false })
  })

  it('insufficient_data: resolved is null, exactMatch is false, requested is still disclosed', async () => {
    ;(getValuation as Mock).mockResolvedValue(insufficient())
    const context = await getPricingContext({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF })
    expect(context.specificityDisclosure).toEqual({ requested: 'model_variant_condition', resolved: null, exactMatch: false })
  })
})

describe('getPricingContext — evidence disclosure (31B §54)', () => {
  it('valued: exposes raw/used/excluded/internal/external sample counts verbatim from getValuation, never recomputed', async () => {
    ;(getValuation as Mock).mockResolvedValue(
      valued({ rawSampleCount: 12, usedSampleCount: 10, excludedOutlierCount: 2, internalSampleCount: 7, externalSampleCount: 3 }),
    )
    const context = await getPricingContext({ catalogModelId: 'cat1', asOf: ASOF })
    expect(context.evidenceDisclosure).toEqual({
      rawSampleCount: 12, usedSampleCount: 10, excludedOutlierCount: 2, internalSampleCount: 7, externalSampleCount: 3,
    })
  })

  it('insufficient_data: evidenceDisclosure is null — no sample to disclose', async () => {
    ;(getValuation as Mock).mockResolvedValue(insufficient())
    const context = await getPricingContext({ catalogModelId: 'cat1', asOf: ASOF })
    expect(context.evidenceDisclosure).toBeNull()
  })
})

describe('getPricingContext — bounded scope (31B §12: no unused signals)', () => {
  it('the module never imports getInternalAskDepth/getMarketSignals/getMedianDaysToSell/getSaleCount', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/pricingContext.ts'), 'utf-8')
    expect(src).not.toMatch(/getInternalAskDepth|getMarketSignals|getMedianDaysToSell|getSaleCount/)
  })
})
