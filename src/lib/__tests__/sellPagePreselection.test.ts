// 19C: /sell?catalogId preselection, the ?claimed=1 success banner, and the
// SellCaptureFlow additions (preselected confirm card, actionable saved-batch
// banner link, guest "Continue to Sell" CTA, authenticated "Submit Items for
// Sale" CTA). All structural (source inspection) — no DB/network required,
// matching this repo's existing convention for capture-flow tests.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

const pageSrc = readSrc('src/app/(store)/sell/page.tsx')
const flowSrc = readSrc('src/components/store/SellCaptureFlow.tsx')

describe('/sell page.tsx: catalogId preselection is read-only (§35)', () => {
  it('resolves catalogId via a plain findUnique — never a write — and falls back to null when absent', () => {
    expect(pageSrc).toContain('prisma.catalogModel.findUnique(')
    expect(pageSrc).toContain('catalogId')
    expect(pageSrc).not.toMatch(/catalogModel\.(create|update|upsert|delete)/)
  })

  it('passes preselected, isAuthenticated, and justClaimed down to SellCaptureFlow', () => {
    const idx = pageSrc.indexOf('<SellCaptureFlow')
    const block = pageSrc.slice(idx, pageSrc.indexOf('/>', idx))
    expect(block).toContain('preselected={preselected}')
    expect(block).toContain('isAuthenticated={!!session}')
    expect(block).toContain("justClaimed={claimed === '1'}")
  })

  it('an invalid/absent catalogId never blocks rendering — Promise.resolve(null) fallback, no notFound()', () => {
    expect(pageSrc).toContain('Promise.resolve(null)')
    expect(pageSrc).not.toContain('notFound()')
  })
})

describe('SellCaptureFlow: preselected-model confirm card reuses the same guarded confirmCandidate entry point', () => {
  it('the preselected card exists and its button calls confirmCandidate, not a separate add path', () => {
    const idx = flowSrc.indexOf('preselected &&')
    expect(idx).toBeGreaterThan(-1)
    const block = flowSrc.slice(idx, flowSrc.indexOf('</section>', idx))
    expect(block).toContain('onClick={() => confirmCandidate(preselected.id)}')
    expect(block).toContain('Confirm & Add')
  })

  it('an explicit Add click is still required — the preselected model is never auto-added on render', () => {
    const idx = flowSrc.indexOf('preselected &&')
    const block = flowSrc.slice(idx, flowSrc.indexOf('</section>', idx))
    expect(block).not.toMatch(/useEffect/)
  })
})

describe('SellCaptureFlow: saved-guest banner is actionable (§32)', () => {
  it('the unclaimedGuestBatchCount banner links to /account/sell/claim via next/link', () => {
    const idx = flowSrc.indexOf('unclaimedGuestBatchCount > 0')
    const block = flowSrc.slice(idx, flowSrc.indexOf(')}', idx))
    expect(block).toContain('href="/account/sell/claim"')
    expect(block).toContain('Continue Saved Batch')
  })

  it('the justClaimed success banner is distinct from the unclaimed-batch banner', () => {
    expect(flowSrc).toContain('justClaimed &&')
    expect(flowSrc).toContain('Your saved items were added to your selling batch.')
  })
})

describe('SellCaptureFlow: end-of-batch CTA wording is exact (§29/§30) — never Submit/Save & Submit for guests', () => {
  it('guest (unauthenticated) CTA is "Continue to Sell", linking to /account/sell/claim', () => {
    const idx = flowSrc.indexOf('isAuthenticated ? (')
    const block = flowSrc.slice(idx, flowSrc.indexOf('</section>', idx))
    expect(block).toContain('Continue to Sell')
    expect(block).toContain('href="/account/sell/claim"')
    expect(block).not.toMatch(/>Submit</)
    expect(block).not.toMatch(/Save &amp; Submit|Save & Submit/)
  })

  it('authenticated CTA is exactly "Submit Items for Sale" and calls handleSubmitBatch (submitSellBatch)', () => {
    expect(flowSrc).toContain('Submit Items for Sale')
    expect(flowSrc).toContain('onClick={handleSubmitBatch}')
    expect(flowSrc).toContain('await submitSellBatch()')
  })

  it('the end-of-batch CTA section only renders when the batch has at least one item', () => {
    const idx = flowSrc.indexOf('{items.length > 0 && (')
    expect(idx).toBeGreaterThan(-1)
  })

  it('successful authenticated submission redirects to /account/sell (chosen destination, reported)', () => {
    const idx = flowSrc.indexOf('async function handleSubmitBatch')
    const block = flowSrc.slice(idx, flowSrc.indexOf('\n  }', idx))
    expect(block).toContain("router.push('/account/sell')")
  })

  it('handleSubmitBatch is guarded by a synchronous ref, same double-submit-prevention pattern as confirmCandidate (19B Final Runtime Reconciliation)', () => {
    expect(flowSrc).toContain('const submitInFlightRef = useRef(false)')
    const idx = flowSrc.indexOf('async function handleSubmitBatch')
    const block = flowSrc.slice(idx, flowSrc.indexOf('\n  }', idx))
    const guardIdx = block.indexOf('if (submitInFlightRef.current) return')
    const setIdx = block.indexOf('submitInFlightRef.current = true')
    const awaitIdx = block.indexOf('await submitSellBatch()')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(guardIdx)
    expect(awaitIdx).toBeGreaterThan(setIdx)
    expect(block).toContain('} finally {')
    expect(block).toContain('submitInFlightRef.current = false')
  })
})
