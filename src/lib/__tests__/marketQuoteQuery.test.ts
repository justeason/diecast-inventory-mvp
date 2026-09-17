// 27B §23/§57/§58/§82: Core Market Quote — a shared composition of 23B
// valuation + 24B internal-ask summary + optional Last Sale. Market Model
// Page is the first consumer, the seller Market Snapshot the second.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/marketValuation', () => ({ getValuation: vi.fn() }))
vi.mock('@/lib/marketAskQuery', () => ({ getInternalAskSummary: vi.fn() }))
vi.mock('@/lib/marketSaleQuery', () => ({ getLatestSale: vi.fn() }))

import { getValuation } from '@/lib/marketValuation'
import { getInternalAskSummary } from '@/lib/marketAskQuery'
import { getLatestSale } from '@/lib/marketSaleQuery'
import { getMarketQuote } from '@/lib/marketQuoteQuery'

const ASOF = new Date('2026-06-01T00:00:00Z')

beforeEach(() => {
  vi.resetAllMocks()
  ;(getValuation as Mock).mockResolvedValue({ status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales' })
  ;(getInternalAskSummary as Mock).mockResolvedValue({ lowestAskCents: null, medianAskCents: null, availableCopies: 0 })
  ;(getLatestSale as Mock).mockResolvedValue(null)
})

describe('getMarketQuote — composition wiring', () => {
  it('always calls getValuation and getInternalAskSummary with the exact same catalogModelId/variantFilter/conditionFilter', async () => {
    await getMarketQuote({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF })
    expect(getValuation).toHaveBeenCalledWith({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF })
    expect(getInternalAskSummary).toHaveBeenCalledWith({ catalogModelId: 'cat1', marketVariantId: 'var1' })
  })

  it('condition is never passed to getInternalAskSummary (asks are never condition-scoped)', async () => {
    await getMarketQuote({ catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint' })
    const call = (getInternalAskSummary as Mock).mock.calls[0][0]
    expect(call.condition).toBeUndefined()
  })

  it('model-only request (no marketVariantId/condition) omits both from every downstream call', async () => {
    await getMarketQuote({ catalogModelId: 'cat1' })
    expect(getValuation).toHaveBeenCalledWith({ catalogModelId: 'cat1', asOf: expect.any(Date) })
    expect(getInternalAskSummary).toHaveBeenCalledWith({ catalogModelId: 'cat1' })
  })

  it('includeLastSale defaults falsy — getLatestSale is never called when omitted', async () => {
    await getMarketQuote({ catalogModelId: 'cat1' })
    expect(getLatestSale).not.toHaveBeenCalled()
  })

  it('includeLastSale: true issues both getLatestSale calls (combined internal+external, and internal-only)', async () => {
    await getMarketQuote({ catalogModelId: 'cat1', includeLastSale: true })
    expect(getLatestSale).toHaveBeenCalledTimes(2)
    const calls = (getLatestSale as Mock).mock.calls.map((c) => c[0].sources)
    expect(calls).toContainEqual(['internal', 'external'])
    expect(calls).toContainEqual(['internal'])
  })

  it('returns the exact valuation/askSummary/lastMarketSale/lastInternalSale from each underlying call', async () => {
    const valuation = { status: 'valued', estimatedValueCents: 1000 }
    const askSummary = { lowestAskCents: 500, medianAskCents: 600, availableCopies: 3 }
    const lastMarket = { priceCents: 900 }
    const lastInternal = { priceCents: 950 }
    ;(getValuation as Mock).mockResolvedValue(valuation)
    ;(getInternalAskSummary as Mock).mockResolvedValue(askSummary)
    ;(getLatestSale as Mock).mockResolvedValueOnce(lastMarket).mockResolvedValueOnce(lastInternal)

    const result = await getMarketQuote({ catalogModelId: 'cat1', includeLastSale: true })
    expect(result).toEqual({ valuation, askSummary, lastMarketSale: lastMarket, lastInternalSale: lastInternal })
  })

  it('all independent queries run in parallel (Promise.all), not a serial waterfall', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketQuoteQuery.ts'), 'utf-8')
    expect(src).toContain('await Promise.all([')
  })

  it('no 30D/momentum/velocity/Wanted signal CODE in the composition (§59/§71 — Series 30 territory; comments explaining the exclusion are fine)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketQuoteQuery.ts'), 'utf-8')
    const code = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/30D|momentum|velocity|[Ww]anted/)
  })
})
