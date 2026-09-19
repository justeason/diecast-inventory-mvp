// 30B: Market Activity wiring on the Market Model Page — layout placement,
// error isolation, shared asOf, methodology extension, discovery-card and
// /market non-regression, legacy-engine boundary, and no forbidden
// investment/prediction/momentum language. Structural (source-inspection)
// tests, matching this codebase's established convention (no React rendering
// harness — see marketModelPage.test.ts).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
const activitySrc = readSrc('src/components/store/MarketActivity.tsx')
const methodologySrc = readSrc('src/components/store/MarketMethodology.tsx')
const signalsSrc = readSrc('src/lib/marketSignalsQuery.ts')
const daysToSellSrc = readSrc('src/lib/marketDaysToSellQuery.ts')
const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
const catalogPageSrc = readSrc('src/app/(store)/catalog/page.tsx')

describe('30B: Market Activity placement — after Market Snapshot, before Price History (§41/§80)', () => {
  it('appears exactly once, between <MarketSnapshot and the Price History heading', () => {
    const snapshotIdx = hubSrc.indexOf('<MarketSnapshot')
    const activityIdx = hubSrc.indexOf('<MarketActivity')
    const priceHistoryIdx = hubSrc.indexOf('>Price History<')
    expect(snapshotIdx).toBeGreaterThan(-1)
    expect(activityIdx).toBeGreaterThan(snapshotIdx)
    expect(priceHistoryIdx).toBeGreaterThan(activityIdx)

    const matches = [...hubSrc.matchAll(/<MarketActivity/g)]
    expect(matches.length).toBe(1)
  })

  it('MarketActivity is its own section, not merged into MarketSnapshot (§41)', () => {
    const snapshotSrc = readSrc('src/components/store/MarketSnapshot.tsx')
    expect(snapshotSrc).not.toContain('MarketActivity')
    expect(snapshotSrc).not.toMatch(/valuationChange30d|sales30d|medianDaysToSell|wantedCount/)
  })
})

describe('30B: error isolation — signals failure never blanks identity/Snapshot/History/Listings (§48/§77)', () => {
  it('getMarketSignals is wrapped in try/catch, degrading to null, logged via the canonical structured logger', () => {
    const idx = hubSrc.indexOf('let signals: MarketSignals | null = null')
    const block = hubSrc.slice(idx, hubSrc.indexOf('const modelName', idx))
    expect(block).toContain('try {')
    expect(block).toContain('await getMarketSignals(')
    expect(block).toContain('catch (err)')
    expect(block).toContain('logger.error(')
    expect(block).toContain('signals = null')
    expect(block).not.toMatch(/\bthrow\b/)
  })

  it('imports the canonical serverLogger, never a raw console.error', () => {
    expect(hubSrc).toContain("import { logger } from '@/lib/serverLogger'")
    expect(stripComments(hubSrc)).not.toMatch(/console\.(error|warn|log)/)
  })

  it('getMarketQuote/getMarketSaleHistory/getBuyerSession are never inside the signals try/catch — only the optional signals call is isolated', () => {
    const tryIdx = hubSrc.indexOf('try {', hubSrc.indexOf('let signals'))
    const catchCloseIdx = hubSrc.indexOf('signals = null\n  }', tryIdx) + 'signals = null\n  }'.length
    const isolatedBlock = hubSrc.slice(tryIdx, catchCloseIdx)
    expect(isolatedBlock).not.toContain('getMarketQuote')
    expect(isolatedBlock).not.toContain('getMarketSaleHistory')
    expect(isolatedBlock).not.toContain('getBuyerSession')
    expect(isolatedBlock).not.toContain('getCatalogModelHub')
  })

  it('MarketActivity only renders when signals is truthy — a null result omits the section rather than crashing or rendering a broken block', () => {
    expect(hubSrc).toContain('{signals && <MarketActivity signals={signals} />}')
  })
})

describe('30B: shared asOf — Market Quote and Market Signals use the identical request-level asOf (§9/§51/§78)', () => {
  it('a single `const asOf = new Date()` feeds both getMarketQuote and getMarketSignals — no second new Date() at the composition boundary', () => {
    const asOfDeclarations = [...hubSrc.matchAll(/const asOf = new Date\(\)/g)]
    expect(asOfDeclarations.length).toBe(1)
    expect(hubSrc).toContain('getMarketQuote({ catalogModelId: id, ...variantFilter, asOf, includeLastSale: true })')
    expect(hubSrc).toContain('getMarketSignals({ catalogModelId: id, ...variantFilter, asOf, currentValuation: valuation })')
  })

  it('getMarketSignals reuses the current valuation from getMarketQuote rather than recomputing it (§50)', () => {
    expect(hubSrc).toContain('const { valuation, askSummary, lastMarketSale, lastInternalSale } = quote')
    expect(hubSrc).toContain('currentValuation: valuation')
  })

  it('marketSignalsQuery.ts computes priorAsOf/window starts from the passed-in asOf only — no internal new Date() default', () => {
    expect(signalsSrc).not.toMatch(/asOf\s*\?\?\s*new Date\(\)/)
    expect(signalsSrc).toContain('const priorAsOf = new Date(asOf.getTime() - THIRTY_DAYS_MS)')
  })
})

describe('30B: variant parity — 30D change compares like-with-like (§7/§71)', () => {
  it('the same variantFilter spread into getMarketQuote/getMarketSaleHistory is also spread into getMarketSignals — no separate/divergent variant resolution for signals', () => {
    const calls = [
      'getMarketQuote({ catalogModelId: id, ...variantFilter, asOf, includeLastSale: true })',
      'getMarketSaleHistory({ catalogModelId: id, ...variantFilter, endDate: asOf, limit: HISTORY_LIMIT })',
      'getMarketSignals({ catalogModelId: id, ...variantFilter, asOf, currentValuation: valuation })',
    ]
    for (const call of calls) expect(hubSrc).toContain(call)
  })
})

describe('30B: no condition signals — Market Model Page has no condition selector (§8)', () => {
  it('marketSignalsQuery.ts never references a condition filter', () => {
    expect(signalsSrc).not.toMatch(/condition/i)
  })
})

describe('30B: Market Activity content — compact rows, exact labels, honest zero/unavailable states (§17/§20-24/§31/§34/§42)', () => {
  it('exact customer labels: "30D Est. Value Change", "Tracked Sales, Last 30 Days" (never "Sales, Last 30 Days"), "Median Days to Sell"', () => {
    expect(activitySrc).toContain('30D Est. Value Change')
    expect(activitySrc).toContain('Tracked Sales, Last 30 Days')
    expect(activitySrc).not.toMatch(/>Sales, Last 30 Days</)
    expect(activitySrc).toContain('Median Days to Sell')
  })

  it('Wanted row uses "Wanted by N Collectors" and is gated on wantedCount > 0 — never renders "0 collectors want this"', () => {
    expect(activitySrc).toContain('{wantedCount > 0 && (')
    expect(activitySrc).toContain('Wanted by {wantedCount}')
    expect(activitySrc).not.toMatch(/0 collectors/)
  })

  it('0 tracked sales renders the real number, never mislabeled "insufficient data"', () => {
    const idx = activitySrc.indexOf('Tracked Sales, Last 30 Days')
    const block = activitySrc.slice(idx, idx + 200)
    expect(block).not.toMatch(/insufficient/i)
    expect(block).toContain('sales30d.total')
  })

  it('days-to-sell insufficient state reads "Not enough CollectNTrades sales", never a global/model-family fallback', () => {
    expect(activitySrc).toContain('Not enough CollectNTrades sales')
  })

  it('30D change unavailable state never RENDERS the raw enum/status string — comparisons against it are fine, interpolating it into text is not', () => {
    const idx = activitySrc.indexOf("valuationChange30d.status === 'available'")
    const block = activitySrc.slice(idx, activitySrc.indexOf('</p>', idx))
    expect(block).not.toMatch(/\{valuationChange30d\.status\}/)
    expect(block).toContain('Unavailable')
  })

  it('no third market metric line beyond the four documented rows — no Momentum/Stability/Confidence row', () => {
    const code = stripComments(activitySrc)
    expect(code).not.toMatch(/Momentum|Stability|Stable|Mixed|Variable/i)
    // Confidence stays exclusively on Market Snapshot — never duplicated here (§16).
    expect(code).not.toMatch(/confidence/i)
  })

  it('no color-coded ticker styling — plain text, no text-red/text-green classes on the change value', () => {
    expect(activitySrc).not.toMatch(/text-red-|text-green-/)
  })

  it('no table/grid density — stacked <p> rows only, no <table>', () => {
    expect(activitySrc).not.toContain('<table')
  })
})

describe('30B: methodology extension — source disclosure per signal (§38/§45/§81)', () => {
  it('MarketMethodology gains an activity variant without changing the default valuation variant (MarketSnapshot call site untouched)', () => {
    const snapshotSrc = readSrc('src/components/store/MarketSnapshot.tsx')
    expect(snapshotSrc).toContain('<MarketMethodology />')
    expect(activitySrc).toContain('<MarketMethodology variant="activity" />')
  })

  it('activity methodology discloses the correct source scope per signal', () => {
    expect(methodologySrc).toMatch(/30D Est\. Value Change compares.*canonical estimated market value/)
    expect(methodologySrc).toMatch(/Tracked Sales includes CollectNTrades sales and tracked external marketplace sales/)
    expect(methodologySrc).toMatch(/Median Days to Sell uses CollectNTrades sales only/)
    expect(methodologySrc).toMatch(/Wanted reflects current CollectNTrades collector interest, not market demand or a price signal/)
  })

  it('still a native <details>/<summary>, no client JS added', () => {
    expect(methodologySrc).toContain('<details')
    expect(methodologySrc).not.toContain("'use client'")
  })
})

describe('30B: legacy sale predicate reuse — no second weaker definition (§26/§27/§63)', () => {
  it('marketDaysToSellQuery.ts imports and reuses buildInternalWhere from marketSaleQuery.ts, rather than redefining eligibility', () => {
    expect(daysToSellSrc).toContain("import { buildInternalWhere } from './marketSaleQuery'")
    expect(daysToSellSrc).not.toMatch(/paymentStatus:\s*'paid'/) // reused via buildInternalWhere, not re-literaled here
  })

  it('buildInternalWhere is exported from marketSaleQuery.ts (the single canonical definition)', () => {
    const saleQuerySrc = readSrc('src/lib/marketSaleQuery.ts')
    expect(saleQuerySrc).toContain('export function buildInternalWhere')
  })
})

describe('30B: legacy engines untouched (§26/§74/§83)', () => {
  it('resaleEstimator.ts, advancedValuation.ts, pricingIntelligence.ts, marketplaceMerchandising.ts, autoListingExecution.ts never reference the new 30B modules', () => {
    const legacyFiles = [
      'src/lib/resaleEstimator.ts',
      'src/lib/advancedValuation.ts',
      'src/lib/pricingIntelligence.ts',
      'src/lib/marketplaceMerchandising.ts',
      'src/lib/autoListingExecution.ts',
    ]
    for (const f of legacyFiles) {
      const src = readSrc(f)
      expect(src).not.toMatch(/marketSignalsQuery|marketDaysToSellQuery|MarketActivity/)
    }
  })
})

describe('30B: /market unchanged — no migration, no terminology alignment (§3/§55)', () => {
  it('market/page.tsx, marketplaceMerchandising.ts, marketplaceMerchandisingQuery.ts never reference the new 30B modules', () => {
    const marketFiles = [
      'src/app/(store)/market/page.tsx',
      'src/lib/marketplaceMerchandising.ts',
      'src/lib/marketplaceMerchandisingQuery.ts',
    ]
    for (const f of marketFiles) {
      const src = readSrc(f)
      expect(src).not.toMatch(/marketSignalsQuery|marketDaysToSellQuery|MarketActivity|getMarketSignals|getMedianDaysToSell/)
    }
  })
})

describe('30B: discovery cards unchanged — no third market line, no new card query (§53/§54/§79)', () => {
  it('CatalogModelCard.tsx never references any 30B signal field/module', () => {
    expect(cardSrc).not.toMatch(/valuationChange30d|sales30d|medianDaysToSell|wantedCount|30D|marketSignalsQuery/)
  })

  it('CatalogModelCard.tsx still renders exactly its 29B two-line market contract (emvText + supplyText, no third line)', () => {
    expect(cardSrc).toContain('{emvText}')
    expect(cardSrc).toContain('{supplyText}')
  })

  it('/catalog/page.tsx never imports marketSignalsQuery/marketDaysToSellQuery — no new card-level query', () => {
    expect(catalogPageSrc).not.toMatch(/marketSignalsQuery|marketDaysToSellQuery|getMarketSignals|getMedianDaysToSell/)
  })
})

describe('30B: no forbidden language anywhere in the new/touched files (§17/§60-62/§82)', () => {
  const files = [hubSrc, activitySrc, methodologySrc, signalsSrc, daysToSellSrc]

  it('no investment/prediction/recommendation vocabulary', () => {
    for (const src of files) {
      expect(stripComments(src)).not.toMatch(
        /investment return|your return|\bGain\b|\bPerformance\b|\bUpside\b|\bAppreciation\b|\bROI\b|bullish|bearish|buy signal|sell signal|undervalued|overvalued|forecast|expected (next|future)|likely to (rise|fall)|price target|good time to (buy|sell)|hot opportunity/i,
      )
    }
  })

  it('no Momentum/Stability composite scoring', () => {
    for (const src of files) {
      expect(stripComments(src)).not.toMatch(/Momentum|0-100|Strong Buy/i)
    }
  })

  it('no Liquidity customer label', () => {
    expect(activitySrc).not.toMatch(/[Ll]iquidity/)
  })

  it('no Fair Listing Indicator (Below/Within/Above Typical Range) — separate series boundary (§57)', () => {
    for (const src of files) {
      expect(src).not.toMatch(/Below Typical Range|Within Market Range|Above Typical Range/)
    }
  })

  it('no bid/ask/instant-sell mechanics introduced (§58)', () => {
    for (const src of files) {
      expect(stripComments(src)).not.toMatch(/\bbid\b|instant sell|\bspread\b|best ask/i)
    }
  })
})

describe('30B: schema/scope discipline (§37/§38/§59/§85/§86)', () => {
  it('no new Prisma model/migration reference in any 30B file — Wanted/supply are read directly from existing tables', () => {
    for (const src of [signalsSrc, daysToSellSrc, activitySrc]) {
      expect(src).not.toMatch(/CREATE TABLE|ALTER TABLE|prisma\.\$executeRaw/)
    }
  })

  it('no supply-trend or Wanted-history fabrication — no 30-day-change field for supply or Wanted', () => {
    expect(signalsSrc).not.toMatch(/supplyChange|wantedChange|newWants30d|wantedTrend/i)
  })

  it('no Portfolio History introduced', () => {
    for (const src of files_for_portfolio()) {
      expect(src).not.toMatch(/PortfolioHistory|portfolioHistory/)
    }
  })

  function files_for_portfolio() {
    return [hubSrc, activitySrc, signalsSrc, daysToSellSrc]
  }
})
