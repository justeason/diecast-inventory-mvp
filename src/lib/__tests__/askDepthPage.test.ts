// 28B: Ask Depth & Supply Transparency — Market Model Page wiring, placement,
// UI copy, and non-regression across discovery/market/browse/seller/checkout.
// Structural (source-inspection) tests, matching this codebase's established
// convention (no React rendering harness — see marketModelPage.test.ts).
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
const askDepthSrc = readSrc('src/components/store/AskDepth.tsx')
const askQuerySrc = readSrc('src/lib/marketAskQuery.ts')
const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
const catalogPageSrc = readSrc('src/app/(store)/catalog/page.tsx')

describe('28B: page placement — after Price History, immediately before Available Listings (§17)', () => {
  it('AskDepth appears exactly once, after the Price History section and before the Available Listings section', () => {
    const priceHistoryCloseIdx = hubSrc.indexOf('</section>', hubSrc.indexOf('>Price History<'))
    const askDepthIdx = hubSrc.indexOf('<AskDepth')
    const availableListingsIdx = hubSrc.indexOf('id="available-listings"')
    expect(priceHistoryCloseIdx).toBeGreaterThan(-1)
    expect(askDepthIdx).toBeGreaterThan(priceHistoryCloseIdx)
    expect(availableListingsIdx).toBeGreaterThan(askDepthIdx)

    const matches = [...hubSrc.matchAll(/<AskDepth/g)]
    expect(matches.length).toBe(1)
  })

  it('not placed between Market Activity and Price History', () => {
    const marketActivityIdx = hubSrc.indexOf('<MarketActivity')
    const priceHistoryIdx = hubSrc.indexOf('>Price History<')
    const askDepthIdx = hubSrc.indexOf('<AskDepth')
    expect(askDepthIdx).toBeGreaterThan(priceHistoryIdx)
    expect(askDepthIdx).toBeGreaterThan(marketActivityIdx)
  })

  it('Available Listings section still exists, unreplaced, after AskDepth', () => {
    const availableListingsIdx = hubSrc.indexOf('Available Copies')
    expect(hubSrc).toContain('id="available-listings"')
    expect(availableListingsIdx).toBeGreaterThan(hubSrc.indexOf('<AskDepth'))
  })
})

describe('28B: query wiring — current supply only, no asOf coupling, no truncation (§13/§14/§36/§40/§41)', () => {
  it('getInternalAskDepth is called with catalogModelId + variantFilter only — no asOf argument threaded in', () => {
    expect(hubSrc).toContain('getInternalAskDepth({ catalogModelId: id, ...variantFilter })')
  })

  it('runs in the same Promise.all batch as Market Quote/history — not a serial extra round trip', () => {
    const idx = hubSrc.indexOf('const [session, quote, history, askDepth] = await Promise.all([')
    expect(idx).toBeGreaterThan(-1)
  })

  it('getInternalAskDepth uses a DB groupBy aggregate, never getInternalAsks (bounded/take-limited) as its source', () => {
    const idx = askQuerySrc.indexOf('export async function getInternalAskDepth')
    const block = askQuerySrc.slice(idx, askQuerySrc.indexOf('\n}', idx))
    expect(block).toContain('prisma.listing.groupBy(')
    expect(block).not.toContain('getInternalAsks(')
    expect(block).not.toMatch(/take:|skip:/)
  })
})

describe('28B: eligibility reuse — no second/weaker predicate (§3)', () => {
  it('getInternalAskDepth calls the exported buildInternalAskWhere — the same predicate getInternalAsks/getInternalAskSummary use', () => {
    const idx = askQuerySrc.indexOf('export async function getInternalAskDepth')
    const block = askQuerySrc.slice(idx, askQuerySrc.indexOf('\n}', idx))
    expect(block).toContain('buildInternalAskWhere(filter)')
  })

  it('buildInternalAskWhere is exported exactly once as the single canonical predicate', () => {
    const matches = [...askQuerySrc.matchAll(/export function buildInternalAskWhere/g)]
    expect(matches.length).toBe(1)
  })
})

describe('28B: source — internal only, no external asks (§5)', () => {
  it('getInternalAskDepth never queries externalMarketObservation', () => {
    const idx = askQuerySrc.indexOf('export async function getInternalAskDepth')
    const block = askQuerySrc.slice(idx, askQuerySrc.indexOf('\n}', idx))
    expect(block).not.toContain('externalMarketObservation')
  })
})

describe('28B: customer copy — exact labels, correct grammar (§18/§19)', () => {
  it('section heading is "Current Ask Depth"', () => {
    expect(askDepthSrc).toContain('Current Ask Depth')
    expect(askDepthSrc).not.toMatch(/Order Book/i)
  })

  it('column headers are "Asking Price" and "Available"', () => {
    expect(askDepthSrc).toContain('Asking Price')
    expect(askDepthSrc).toContain('>Available<')
  })

  it('uses "copy" for 1, "copies" for N — correct grammar, no bare count', () => {
    expect(askDepthSrc).toContain("level.availableCopies === 1 ? 'copy' : 'copies'")
  })

  it('empty state is the exact concise sentence, never an empty table', () => {
    expect(askDepthSrc).toContain('No copies currently available.')
    const idx = askDepthSrc.indexOf('levels.length === 0')
    const block = askDepthSrc.slice(idx, askDepthSrc.indexOf(') : ('))
    expect(block).not.toContain('<table')
  })
})

describe('28B: no bid-side language or placeholders anywhere in the new files (§18/§25/§26/§27/§28)', () => {
  const files = [hubSrc, askDepthSrc, askQuerySrc]

  it('no Highest Buy Offer / Best Bid / bid placeholder / spread / midpoint', () => {
    for (const src of files) {
      expect(stripComments(src)).not.toMatch(
        /Highest Buy Offer|Best Bid|Bid unavailable|No bids|Ask-Bid Spread|\bSpread\b|Midpoint|CounterOffer/i,
      )
    }
  })

  it('never queries WantedCatalogModel.maxDesiredPrice as a bid/interest price', () => {
    for (const src of files) {
      expect(src).not.toMatch(/maxDesiredPrice|Highest Wanted Price|Buyer Interest Price|Potential Bid/i)
    }
  })

  it('never exposes SellerAgreement.agreedBuyoutAmount publicly', () => {
    for (const src of files) {
      expect(src).not.toMatch(/agreedBuyoutAmount/)
    }
  })

  it('no new production BuyOffer/Bid schema-adjacent identifiers', () => {
    for (const src of files) {
      expect(stripComments(src)).not.toMatch(/\bBuyOffer\b|\bclass Bid\b|negotiation/i)
    }
  })
})

describe('28B: privacy — depth rows carry only price/count (§20/§21)', () => {
  it('AskDepth component only reads level.priceCents/level.availableCopies — no seller/consignment field', () => {
    expect(stripComments(askDepthSrc)).not.toMatch(/seller|consignor|profile|agreement/i)
  })
})

describe('28B: rows are non-interactive — informational only (§23)', () => {
  it('no <button>/<form>/onClick in AskDepth — rows never execute a purchase', () => {
    expect(askDepthSrc).not.toMatch(/<button|<form|onClick/)
  })
})

describe('28B: accessibility — semantic table with real headers (§45)', () => {
  it('uses <table>/<thead>/<th scope="col"> when levels are non-empty', () => {
    expect(askDepthSrc).toContain('<table')
    expect(askDepthSrc).toContain('<thead')
    expect(askDepthSrc).toContain('scope="col"')
  })
})

describe('28B: Market Quote / Market Signals boundaries untouched (§15/§16)', () => {
  it('marketQuoteQuery.ts is untouched — no askDepth/depth field added to MarketQuote', () => {
    const quoteSrc = readSrc('src/lib/marketQuoteQuery.ts')
    expect(quoteSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
  })

  it('marketSignalsQuery.ts and MarketActivity.tsx are untouched by ask depth', () => {
    const signalsSrc = readSrc('src/lib/marketSignalsQuery.ts')
    const activitySrc = readSrc('src/components/store/MarketActivity.tsx')
    expect(signalsSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
    expect(activitySrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
  })
})

describe('28B: EMV/Range/Price History untouched (§29)', () => {
  it('marketValuation.ts and marketValuationMath.ts never reference ask depth', () => {
    const valuationSrc = readSrc('src/lib/marketValuation.ts')
    const mathSrc = readSrc('src/lib/marketValuationMath.ts')
    expect(valuationSrc).not.toMatch(/askDepth|AskDepthLevel/)
    expect(mathSrc).not.toMatch(/askDepth|AskDepthLevel/)
  })
})

describe('28B: discovery cards, /market, /browse, seller flow, checkout unchanged (§48-§52/§74-§78)', () => {
  it('CatalogModelCard.tsx and /catalog/page.tsx never reference ask depth — no third card line, no new grid query', () => {
    expect(cardSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
    expect(catalogPageSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
  })

  it('/market merchandising files never reference ask depth', () => {
    const marketPageSrc = readSrc('src/app/(store)/market/page.tsx')
    const merchSrc = readSrc('src/lib/marketplaceMerchandising.ts')
    expect(marketPageSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
    expect(merchSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
  })

  it('/browse route never references ask depth', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    expect(browseSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
  })

  it('seller sell-flow files never reference ask depth', () => {
    const sellSrc = readSrc('src/app/(store)/account/sell/[id]/page.tsx')
    expect(sellSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
  })

  it('orders.ts (checkout) is untouched by 28B — reservation hotfix remains the only recent change there', () => {
    const ordersSrc = readSrc('src/lib/actions/orders.ts')
    expect(ordersSrc).not.toMatch(/askDepth|AskDepthLevel|getInternalAskDepth/)
    // The reservation hotfix's guard is still intact.
    expect(ordersSrc).toContain('tx.itemInstance.updateMany({')
    expect(ordersSrc).toContain("throw new ListingUnavailableError()")
  })
})

describe('28B: scope discipline — no schema/migration/package footprint (§57/§58/§80)', () => {
  it('no CREATE TABLE/ALTER TABLE/raw SQL in any 28B file', () => {
    for (const src of [askQuerySrc, askDepthSrc, hubSrc]) {
      expect(src).not.toMatch(/CREATE TABLE|ALTER TABLE|\$executeRaw/)
    }
  })
})
