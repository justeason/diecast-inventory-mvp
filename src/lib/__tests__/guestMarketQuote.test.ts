// 27B §11/§12/§52/§53/§56/§80: guest camera-first model-level valuation.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/marketValuation', () => ({ getValuation: vi.fn() }))

import { getValuation } from '@/lib/marketValuation'
import { getGuestMarketQuote } from '@/lib/actions/guestMarketQuote'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('getGuestMarketQuote — model-level only, public, no auth required', () => {
  it('calls getValuation with catalogModelId only — no marketVariantId/condition (GuestSellerItem cannot canonically represent either)', async () => {
    ;(getValuation as Mock).mockResolvedValue({ status: 'insufficient_data' })
    await getGuestMarketQuote('cat1')
    expect(getValuation).toHaveBeenCalledWith({ catalogModelId: 'cat1' })
  })

  it('returns the valuation result verbatim', async () => {
    const valuation = { status: 'valued', estimatedValueCents: 1500 }
    ;(getValuation as Mock).mockResolvedValue(valuation)
    const result = await getGuestMarketQuote('cat1')
    expect(result).toEqual({ ok: true, valuation })
  })

  it('a missing/empty catalogModelId never calls getValuation, returns an error instead of a fake result', async () => {
    const result = await getGuestMarketQuote('')
    expect(result.ok).toBe(false)
    expect(getValuation).not.toHaveBeenCalled()
  })

  it('never calls anything requiring an authenticated session (no getBuyerSession import)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/actions/guestMarketQuote.ts'), 'utf-8')
    expect(src).not.toContain('getBuyerSession')
  })

  it('never touches private data — no ownershipLedger/portfolioQuery/commissionPolicy import', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/actions/guestMarketQuote.ts'), 'utf-8')
    expect(src).not.toMatch(/ownershipLedger|portfolioQuery|commissionPolicy|sellerProceedsEstimator/)
  })
})

describe('SellCaptureFlow wiring — fires on confirmCandidate, never blocks the add, no persisted state required (§52/§53/§68/§80)', () => {
  const flowSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/store/SellCaptureFlow.tsx'), 'utf-8')

  it('imports and calls getGuestMarketQuote from confirmCandidate', () => {
    expect(flowSrc).toContain("import { getGuestMarketQuote } from '@/lib/actions/guestMarketQuote'")
    const idx = flowSrc.indexOf('async function confirmCandidate')
    const end = flowSrc.indexOf('\n  }', idx)
    expect(flowSrc.slice(idx, end)).toContain('getGuestMarketQuote(catalogModelId)')
  })

  it('the quote fetch is fire-and-forget (.then, not awaited) — never blocks or delays the add', () => {
    const idx = flowSrc.indexOf('getGuestMarketQuote(catalogModelId)')
    const line = flowSrc.slice(idx, idx + 60)
    expect(line).toContain('.then(')
    expect(line).not.toMatch(/^await/)
  })

  it('quotes are keyed by catalogModelId in component state — no server-persisted quote field required for claim to work', () => {
    expect(flowSrc).toContain('quotesByModelId')
    expect(flowSrc).toContain('useState<Record<string, ValuationResult>>')
  })

  it('model-level disclosure copy is present, never implying condition specificity', () => {
    expect(flowSrc).toContain('Model-level estimate; more specific context may be available after item details are confirmed.')
  })

  it('insufficient/no-data state shows the standard disclosure, never a fabricated $0', () => {
    expect(flowSrc).toContain('Not enough direct sales data yet.')
  })
})
