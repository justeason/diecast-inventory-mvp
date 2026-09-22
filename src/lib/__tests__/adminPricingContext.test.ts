// 32B: behavioral tests for getAdminPricingContext — composition ONLY over
// already-canonical primitives (31B getPricingContext, 28B getInternalAskDepth,
// 30B getMarketSignals), each mocked at the function boundary; their own
// correctness is covered by pricingContext.test.ts / marketAskQuery.test.ts /
// marketSignalsQuery.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/pricingContext', () => ({ getPricingContext: vi.fn() }))
vi.mock('@/lib/marketAskQuery', () => ({ getInternalAskDepth: vi.fn() }))
vi.mock('@/lib/marketSignalsQuery', () => ({ getMarketSignals: vi.fn() }))

import { getPricingContext } from '@/lib/pricingContext'
import { getInternalAskDepth } from '@/lib/marketAskQuery'
import { getMarketSignals } from '@/lib/marketSignalsQuery'
import { getAdminPricingContext } from '@/lib/adminPricingContext'

const FAKE_VALUATION = { status: 'insufficient_data' as const }
const FAKE_PRICING_CONTEXT = {
  valuation: FAKE_VALUATION,
  askSummary: { lowestAskCents: null, medianAskCents: null, availableCopies: 0 },
  specificityDisclosure: { requested: 'model', resolved: null, exactMatch: false },
  evidenceDisclosure: null,
  asOf: new Date('2026-01-01'),
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(getPricingContext as Mock).mockResolvedValue(FAKE_PRICING_CONTEXT)
  ;(getInternalAskDepth as Mock).mockResolvedValue([])
  ;(getMarketSignals as Mock).mockResolvedValue({ valuationChange30d: { status: 'insufficient_data' }, sales30d: { status: 'available', total: 0, internal: 0, external: 0 }, medianDaysToSell: { status: 'insufficient_data' }, wantedCount: 0 })
})

describe('getAdminPricingContext', () => {
  it('composes pricing + askDepth, with signals null by default (never fetched unless requested)', async () => {
    const result = await getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date('2026-01-01') })
    expect(result.pricing).toBe(FAKE_PRICING_CONTEXT)
    expect(result.askDepth).toEqual([])
    expect(result.signals).toBeNull()
    expect(getMarketSignals).not.toHaveBeenCalled()
  })

  it('fetches Market Signals only when includeSignals is explicitly true — never for a default/list call', async () => {
    const result = await getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date('2026-01-01'), includeSignals: true })
    expect(getMarketSignals).toHaveBeenCalledTimes(1)
    expect(result.signals).not.toBeNull()
  })

  it('passes the SAME asOf into both getPricingContext and getMarketSignals — one shared request-level clock', async () => {
    const asOf = new Date('2026-03-15')
    await getAdminPricingContext({ catalogModelId: 'cat1', asOf, includeSignals: true })
    expect((getPricingContext as Mock).mock.calls[0][0].asOf).toBe(asOf)
    expect((getMarketSignals as Mock).mock.calls[0][0].asOf).toBe(asOf)
  })

  it('passes the resolved valuation from getPricingContext into getMarketSignals as currentValuation — never a second, redundant valuation fetch', async () => {
    await getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date(), includeSignals: true })
    expect((getMarketSignals as Mock).mock.calls[0][0].currentValuation).toBe(FAKE_VALUATION)
  })

  it('threads marketVariantId into askDepth/signals filters when provided, and omits it when not', async () => {
    await getAdminPricingContext({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: new Date(), includeSignals: true })
    expect((getInternalAskDepth as Mock).mock.calls[0][0]).toEqual({ catalogModelId: 'cat1', marketVariantId: 'v1' })
    expect((getMarketSignals as Mock).mock.calls[0][0].marketVariantId).toBe('v1')

    vi.clearAllMocks()
    ;(getPricingContext as Mock).mockResolvedValue(FAKE_PRICING_CONTEXT)
    ;(getInternalAskDepth as Mock).mockResolvedValue([])
    await getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date() })
    expect((getInternalAskDepth as Mock).mock.calls[0][0]).toEqual({ catalogModelId: 'cat1' })
  })

  it('never fetches Ask Depth/Signals with a condition filter — those primitives are model/variant-level only', async () => {
    await getAdminPricingContext({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: new Date(), includeSignals: true })
    expect((getInternalAskDepth as Mock).mock.calls[0][0]).not.toHaveProperty('condition')
    expect((getMarketSignals as Mock).mock.calls[0][0]).not.toHaveProperty('condition')
  })
})
