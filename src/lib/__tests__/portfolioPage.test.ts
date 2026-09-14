/**
 * 25B: /account/collection (merged Collection + Portfolio) and the retired
 * /account/collection/valuation redirect. Structural/source-text checks,
 * mirroring the established 16H/24B convention (no React rendering harness
 * exists in this codebase).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

const collectionSrc = readSrc('src/app/(store)/account/collection/page.tsx')
const collectionCode = stripComments(collectionSrc)
const redirectSrc = readSrc('src/app/(store)/account/collection/valuation/page.tsx')
const portfolioQuerySrc = readSrc('src/lib/portfolioQuery.ts')
const accountNavSrc = readSrc('src/components/store/AccountNav.tsx')
const customerNavSrc = readSrc('src/lib/customerNav.ts')
const communityQuerySrc = readSrc('src/lib/communityLeaderboardsQuery.ts')

// ── Routing (§57/§84) ────────────────────────────────────────────────────────

describe('25B: route merge — /account/collection renders Portfolio + Collection; old valuation route redirects', () => {
  it('/account/collection/valuation redirects, never 404s, never renders its own UI', () => {
    expect(redirectSrc).toContain("redirect('/account/collection')")
    expect(redirectSrc).not.toContain('notFound()')
    expect(redirectSrc).not.toMatch(/<div|<section|<table/)
  })

  it('no new /account/portfolio route was introduced', () => {
    expect(exists('src/app/(store)/account/portfolio')).toBe(false)
  })

  it('page title remains "My Collection", not renamed to "Portfolio"', () => {
    expect(collectionSrc).toContain("title: 'My Collection | CollectNTrades'")
  })

  it('account nav still has exactly one Collection entry, no new Portfolio nav item', () => {
    expect(customerNavSrc).toContain("href: '/account/collection'")
    expect(customerNavSrc).not.toMatch(/href:\s*['"]\/account\/portfolio['"]/)
    expect(accountNavSrc).not.toContain('Portfolio')
  })
})

// ── Legacy migration (§3/§85) ────────────────────────────────────────────────

describe('25B: Collection Portfolio uses ONLY 23B getValuationsBatch — no legacy engine', () => {
  it('the merged page imports getPortfolio, never getCollectionValuation/AdvancedValuation directly', () => {
    expect(collectionSrc).toContain("from '@/lib/portfolioQuery'")
    expect(collectionSrc).not.toMatch(/getCollectionValuation|AdvancedValuation|AdvancedConfidence|resaleEstimator|pricingIntelligence/)
  })

  it('portfolioQuery.ts sources market value exclusively from getValuationsBatch (23B)', () => {
    expect(portfolioQuerySrc).toContain("from '@/lib/marketValuation'")
    expect(stripComments(portfolioQuerySrc)).not.toMatch(/AdvancedValuation|getCollectionValuation|resaleEstimator|pricingIntelligence/)
  })

  it('seller and admin legacy engines remain untouched', () => {
    expect(exists('src/lib/advancedValuationQuery.ts')).toBe(true)
    expect(exists('src/lib/resaleEstimator.ts')).toBe(true)
    expect(exists('src/lib/pricingIntelligence.ts')).toBe(true)
    const sellSrc = readSrc('src/app/(store)/account/sell/[id]/page.tsx')
    expect(sellSrc).toMatch(/computeEstimate|getPricingIntelligence/)
  })
})

// ── Old fields removed (§37/§44/§64-67/§86) ─────────────────────────────────

describe('25B: legacy Collection Valuation table columns are gone', () => {
  it('no Match/Trend/Lowest ask/Ext. ref./Low-High-estimate columns anywhere in Collection', () => {
    expect(collectionSrc).not.toMatch(/Ext\. ref\.|Lowest ask|Low estimate|High estimate/)
    expect(collectionSrc).not.toMatch(/tierLabel|trendBadge|matchTier/)
  })

  it('portfolioQuery.ts computes no aggregate Market Range (§29/§40/§93)', () => {
    expect(portfolioQuerySrc).not.toMatch(/marketRangeLow|marketRangeHigh|totalLow|totalHigh/)
  })
})

// ── Same-asOf / whole-collection wiring at the page level (§14/§51) ─────────

describe('25B: page computes Portfolio once, over the whole collection, with one asOf', () => {
  it('one asOf constant feeds both the visible-page query and getPortfolio', () => {
    expect(collectionCode).toContain('const asOf = new Date()')
    expect(collectionCode).toContain('getPortfolio(session.profileId, asOf)')
  })

  it('getPortfolio is called exactly once per request (not per visible row)', () => {
    const matches = [...collectionSrc.matchAll(/getPortfolio\(/g)]
    expect(matches.length).toBe(1)
  })

  it('per-row Portfolio fields are looked up from the single portfolio result via a map, never a second valuation call inside the render loop', () => {
    const mapIdx = collectionSrc.indexOf('items.map((item)')
    const mapEnd = collectionSrc.indexOf('</div>\n\n          <div className="mt-6 flex gap-4">')
    const loopBlock = collectionSrc.slice(mapIdx, mapEnd === -1 ? undefined : mapEnd)
    expect(loopBlock).not.toMatch(/getPortfolio|getValuationsBatch|getValuation\(/)
    expect(loopBlock).toContain('holdingByItemId.get(item.id)')
  })
})

// ── Per-row display (§30-33/§41/§42/§43) ────────────────────────────────────

describe('25B: per-holding display distinguishes per-copy value from holding total, shows confidence, no numeric score', () => {
  it('shows both "Est. value/copy" and "Holding value" distinctly when quantity > 1', () => {
    expect(collectionSrc).toContain('Est. value/copy:')
    expect(collectionSrc).toContain('Holding value:')
  })

  it('confidence uses the categorical V1 labels, never a 0-100 score', () => {
    expect(collectionSrc).toContain('CONFIDENCE_LABELS')
    expect(collectionSrc).not.toMatch(/confidence\.score|confidenceScore/)
  })
})

// ── Multi-copy / unknown cost UX (§30/§31/§32/§61) ──────────────────────────

describe('25B: cost UX per policy — ambiguous multi-copy never shown as usable cost, unknown cost gets a CTA', () => {
  it('ambiguous_quantity renders a review-needed note, not a cost figure', () => {
    expect(collectionSrc).toContain('Recorded purchase price needs review for multi-copy holding')
  })

  it('unknown cost (qty=1, no price) links to the existing edit flow, not a new cost-editing subsystem', () => {
    expect(collectionSrc).toContain('Add purchase price')
    expect(collectionSrc).toContain('/edit#purchasePrice')
  })

  it('invalid recorded cost is disclosed, not silently dropped or clamped', () => {
    expect(collectionSrc).toContain('Recorded purchase price is invalid')
  })
})

// ── Actions preserved (§37/§38/§46/§87) ─────────────────────────────────────

describe('25B: existing Collection actions remain functional and unchanged', () => {
  it('View Market, Sell One, Add Another, and the public/private toggle are all still present', () => {
    expect(collectionSrc).toContain('View Market')
    expect(collectionSrc).toContain('Sell One')
    expect(collectionSrc).toContain('Add Another')
    expect(collectionSrc).toContain('toggleCollectionItemPublic')
  })

  it('View Market still links to /catalog/[catalogId] (24B Market Model Page)', () => {
    expect(collectionSrc).toContain('href={`/catalog/${item.catalogId}`}')
  })

  it('no seller-pricing/offer logic was added or altered here', () => {
    expect(collectionSrc).not.toMatch(/sellerPricingGuidance|pricingIntelligence|instantOffer/)
  })
})

// ── Freeform items (§47/§88) ─────────────────────────────────────────────────

describe('25B: freeform (catalogId=null) items remain visible with independent cost/value handling', () => {
  it('the row still renders without a catalogId (no crash-causing assumption of catalogId presence for identity/photo)', () => {
    expect(collectionCode).toContain('displayName(item)')
  })

  it('"View Market"/"Add Another" links are still conditionally gated on catalogId presence', () => {
    const gates = [...collectionSrc.matchAll(/\{item\.catalogId && \(/g)].map((m) => m.index!)
    expect(gates.length).toBeGreaterThanOrEqual(2)
    const addAnotherIdx = collectionSrc.indexOf('Add Another')
    const viewMarketIdx = collectionSrc.indexOf('View Market')
    expect(gates.some((g) => g < addAnotherIdx && addAnotherIdx - g < 400)).toBe(true)
    expect(gates.some((g) => g < viewMarketIdx && viewMarketIdx - g < 400)).toBe(true)
  })
})

// ── Privacy (§60/§89) ────────────────────────────────────────────────────────

describe('25B: Portfolio financial fields never reach public showcase/community surfaces', () => {
  it('communityLeaderboardsQuery.ts never selects purchasePrice/purchaseDate', () => {
    expect(communityQuerySrc).not.toMatch(/purchasePrice|purchaseDate/)
  })

  it('communityLeaderboardsQuery.ts does not import getPortfolio/portfolioQuery', () => {
    expect(communityQuerySrc).not.toMatch(/getPortfolio|portfolioQuery/)
  })

  it('portfolioQuery.ts is never imported by any community/showcase file', () => {
    const communityDir = path.join(root, 'src/app/(store)/community')
    function walk(dir: string): string[] {
      if (!fs.existsSync(dir)) return []
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    }
    for (const f of walk(communityDir)) {
      expect(fs.readFileSync(f, 'utf-8')).not.toContain('portfolioQuery')
    }
  })
})

// ── Disclosure (§62/§91) ─────────────────────────────────────────────────────

describe('25B: Portfolio disclosure copy — no financial-advice/tax/guarantee framing', () => {
  it('discloses estimate-not-guaranteed, internal+external sourcing, and exact-model-only scope', () => {
    expect(collectionSrc).toContain('not guaranteed sale proceeds')
    expect(collectionSrc).toContain('CollectNTrades and tracked external marketplace sales')
    expect(collectionSrc).toContain('this exact model only')
  })

  it('discloses Recorded Cost limitations and multi-copy tracking limits', () => {
    expect(collectionSrc).toContain('Recorded Cost uses purchase prices you recorded where the cost can be interpreted safely.')
    expect(collectionSrc).toContain('Multi-copy historical purchase-cost tracking is limited.')
  })

  it('discloses Unrealized Gain/Loss cannot necessarily be realized', () => {
    expect(collectionSrc).toContain('Not an amount you can necessarily realize immediately.')
  })

  it('never uses financial-advice/tax/guarantee/investment language', () => {
    expect(collectionSrc).not.toMatch(/financial advice|guaranteed proceeds|tax basis|cost basis|investment recommendation/i)
  })
})

// ── Scope confirmation (§68-§73/§92) ─────────────────────────────────────────

describe('25B: scope discipline — no lot model, no realized gains, no quantity reconciliation, no off-platform sale', () => {
  it('no AcquisitionLot/CollectionLot model or realized-gain logic exists', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toContain('model AcquisitionLot')
    expect(schema).not.toContain('model CollectionLot')
    expect(stripComments(portfolioQuerySrc)).not.toMatch(/\brealizedGain\b|FIFO|specificIdentification|averageCost/i)
  })

  it('no CollectionItem.quantity decrement was introduced for marketplace sales', () => {
    const sellerSubmissionsSrc = readSrc('src/lib/actions/sellerSubmissions.ts')
    expect(sellerSubmissionsSrc).not.toMatch(/collectionItem\.(update|updateMany)\(/)
  })

  it('no "mark sold off-platform" action exists', () => {
    expect(collectionSrc).not.toMatch(/[Mm]ark.*[Ss]old|soldOffPlatform/)
  })

  it('no new packages/migrations — 52 migrations still present', () => {
    const migrationDirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((f) => /^\d/.test(f))
    expect(migrationDirs.length).toBe(52)
  })
})

// ── Mobile/structure (§55/§90) ───────────────────────────────────────────────

describe('25B: no wide valuation-table dependency — reuses the existing responsive card pattern', () => {
  it('Portfolio summary uses a responsive grid, not a fixed-width table', () => {
    expect(collectionSrc).toContain('grid grid-cols-1 sm:grid-cols-3')
    expect(collectionSrc).not.toContain('overflow-x-auto')
    expect(collectionSrc).not.toMatch(/<table/)
  })

  it('holding rows remain the existing stacked-card list, not a new grid/table component', () => {
    expect(collectionSrc).toContain('space-y-3')
  })
})
