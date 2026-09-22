// 32B follow-up: error-isolation coverage for optional, display-only pricing
// enrichment (§1/§2/§11). getPricingContext/getInternalAskDepth/
// getMarketSignals are mocked at the function boundary; logger is mocked to
// prove errors are logged server-side and never re-thrown/exposed raw.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/pricingContext', () => ({ getPricingContext: vi.fn() }))
vi.mock('@/lib/marketAskQuery', () => ({ getInternalAskDepth: vi.fn() }))
vi.mock('@/lib/marketSignalsQuery', () => ({ getMarketSignals: vi.fn() }))
vi.mock('@/lib/serverLogger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { getPricingContext } from '@/lib/pricingContext'
import { getInternalAskDepth } from '@/lib/marketAskQuery'
import { getMarketSignals } from '@/lib/marketSignalsQuery'
import { logger } from '@/lib/serverLogger'
import { getAdminPricingContext, safeGetAdminPricingContext } from '@/lib/adminPricingContext'

const FAKE_PRICING_CONTEXT = {
  valuation: { status: 'insufficient_data' as const },
  askSummary: { lowestAskCents: null, medianAskCents: null, availableCopies: 0 },
  specificityDisclosure: { requested: 'model', resolved: null, exactMatch: false },
  evidenceDisclosure: null,
  asOf: new Date('2026-01-01'),
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(getPricingContext as Mock).mockResolvedValue(FAKE_PRICING_CONTEXT)
  ;(getInternalAskDepth as Mock).mockResolvedValue([])
})

describe('§2 — Market Signals failure never blanks base pricing facts', () => {
  it('EMV/Market Range/Confidence/Lowest Ask/Ask Depth still populate when only getMarketSignals throws', async () => {
    ;(getMarketSignals as Mock).mockRejectedValueOnce(new Error('signals boom'))
    const result = await getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date(), includeSignals: true })
    expect(result.pricing).toBe(FAKE_PRICING_CONTEXT)
    expect(result.askDepth).toEqual([])
    expect(result.signals).toBeNull()
  })

  it('logs the signals failure server-side via the canonical logger', async () => {
    ;(getMarketSignals as Mock).mockRejectedValueOnce(new Error('signals boom'))
    await getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date(), includeSignals: true })
    expect(logger.error).toHaveBeenCalledWith('admin_pricing_context_signals_failed', expect.any(Error), expect.objectContaining({ catalogModelId: 'cat1' }))
  })

  it('never throws to the caller when signals fails — the composition still resolves', async () => {
    ;(getMarketSignals as Mock).mockRejectedValueOnce(new Error('signals boom'))
    await expect(getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date(), includeSignals: true })).resolves.toBeDefined()
  })
})

describe('§1 — base pricing-context failure is NOT isolated inside getAdminPricingContext itself', () => {
  it('a getPricingContext failure still rejects getAdminPricingContext — isolation lives one layer up, in safeGetAdminPricingContext', async () => {
    ;(getPricingContext as Mock).mockRejectedValueOnce(new Error('pricing boom'))
    await expect(getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date() })).rejects.toThrow('pricing boom')
  })

  it('a getInternalAskDepth failure also rejects getAdminPricingContext', async () => {
    ;(getInternalAskDepth as Mock).mockRejectedValueOnce(new Error('ask boom'))
    await expect(getAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date() })).rejects.toThrow('ask boom')
  })
})

describe('§1 — safeGetAdminPricingContext isolates the base-facts boundary', () => {
  it('returns null (never throws) when the underlying composition fails', async () => {
    ;(getPricingContext as Mock).mockRejectedValueOnce(new Error('db unreachable'))
    const result = await safeGetAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date() }, { route: 'test' })
    expect(result).toBeNull()
  })

  it('logs via the canonical server logger, including caller-supplied route metadata', async () => {
    ;(getPricingContext as Mock).mockRejectedValueOnce(new Error('db unreachable'))
    await safeGetAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date() }, { route: '/admin/items/[id]', itemId: 'item1' })
    expect(logger.error).toHaveBeenCalledWith(
      'admin_pricing_context_failed',
      expect.any(Error),
      expect.objectContaining({ route: '/admin/items/[id]', itemId: 'item1' }),
    )
  })

  it('returns the real context unchanged on success — the wrapper adds nothing when there is no failure', async () => {
    const result = await safeGetAdminPricingContext({ catalogModelId: 'cat1', asOf: new Date() }, { route: 'test' })
    expect(result).toEqual({ pricing: FAKE_PRICING_CONTEXT, askDepth: [], signals: null })
  })
})
