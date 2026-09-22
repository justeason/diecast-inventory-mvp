// 32B: structural coverage for §3/§27/§33/§37 — legacy recommendation
// concept removal, canonical facts rendered, item-detail migration.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const listSrc = readSrc('src/app/(admin)/admin/valuation/page.tsx')
const detailSrc = readSrc('src/app/(admin)/admin/valuation/models/[id]/page.tsx')
const itemDetailSrc = readSrc('src/app/(admin)/admin/items/[id]/page.tsx')

describe('§3 — legacy recommendation concept removed from migrated surfaces', () => {
  for (const [name, src] of [['valuation list', listSrc], ['valuation detail', detailSrc], ['item detail', itemDetailSrc]] as const) {
    it(`${name} page never shows Recommended Range/Target Price/legacy Market Position/numeric confidence score`, () => {
      expect(src).not.toMatch(/Recommended Range|Target Price|marketPositionClass|Market Position/)
      expect(src).not.toMatch(/confidence\.score|confidence\.level/)
    })
  }
})

describe('§27/§29 — valuation list heading and canonical columns', () => {
  it('heading is "Market Pricing"', () => {
    expect(listSrc).toContain('Market Pricing')
  })

  it('canonical columns: Estimated Market Value, Market Range, Confidence, Sales Evidence, Current Supply', () => {
    for (const label of ['Estimated Market Value', 'Market Range', 'Confidence', 'Sales Evidence', 'Current Supply']) {
      expect(listSrc).toContain(label)
    }
  })

  it('legacy-guidance-backed filters (listing_above_guidance/listing_below_guidance/stale_external_evidence) are removed, not faked', () => {
    expect(listSrc).not.toMatch(/listing_above_guidance|listing_below_guidance|stale_external_evidence/)
  })
})

describe('§33 — valuation detail renders canonical facts via the shared panel', () => {
  it('uses AdminPricingContextPanel, not the legacy PricingIntelligencePanel', () => {
    expect(detailSrc).toContain('AdminPricingContextPanel')
    expect(detailSrc).not.toContain('PricingIntelligencePanel')
  })

  it('requests Market Signals for the detail page (includeSignals: true)', () => {
    expect(detailSrc).toMatch(/includeSignals:\s*true/)
  })
})

describe('§37 — item detail Pricing section migrated to full-specificity canonical context', () => {
  it('uses AdminPricingContextPanel, not the legacy PricingIntelligenceSummary', () => {
    expect(itemDetailSrc).toContain('AdminPricingContextPanel')
    expect(itemDetailSrc).not.toContain('PricingIntelligenceSummary')
  })

  it('no legacy isAskOnly badge remains in the Ready-to-List card', () => {
    expect(itemDetailSrc).not.toMatch(/isAskOnly/)
  })

  it('full specificity is requested via itemLifecycleQuery.ts (catalogId + marketVariantId + condition)', () => {
    const lifecycleSrc = readSrc('src/lib/itemLifecycleQuery.ts')
    expect(lifecycleSrc).toMatch(/safeGetAdminPricingContext\([\s\S]*marketVariantId:\s*item\.marketVariantId[\s\S]*condition:\s*item\.condition/)
  })
})
