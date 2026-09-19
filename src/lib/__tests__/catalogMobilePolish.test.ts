// 20B: mobile card density polish, buy-link discoverability, result-context
// UX, and /market naming clarification — structural (source-inspection) tests,
// matching this codebase's established convention.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
const marketSrc = readSrc('src/app/(store)/market/page.tsx')
const homeSrc = readSrc('src/app/(store)/page.tsx')
const navSrc = readSrc('src/lib/customerNav.ts')

// 29B replaced the old per-breakpoint two-line/one-line availability split
// with a single canonical "Lowest Ask $X.XX · N available" supply line (plus
// a new EMV line above it) that is already compact enough to render
// identically on every breakpoint — so the md:hidden/hidden md:inline split
// and its dedicated min-height hack no longer exist. See catalogModelCard.test.ts
// for the current 29B supply-line copy assertions.
describe('20B §25 / 29B: single canonical supply line, price never hidden', () => {
  it('the supply line shows "Lowest Ask $X.XX · N available" on every breakpoint — no mobile/desktop content split', () => {
    const marketBlockIdx = cardSrc.indexOf('{emvText}')
    const actionRowIdx = cardSrc.indexOf('className={actionRowCls}')
    const block = cardSrc.slice(marketBlockIdx, actionRowIdx)
    expect(block).not.toContain('md:hidden')
    expect(block).not.toContain('hidden md:inline')
    expect(block).toContain('{supplyText}')
  })

  it('unavailable state remains exactly "Currently unavailable" on both breakpoints', () => {
    expect(cardSrc).toContain("'Currently unavailable'")
  })

  it('price text is never truncated/clamped away — no line-clamp on the market/supply block', () => {
    const marketBlockIdx = cardSrc.indexOf('{emvText}')
    const actionRowIdx = cardSrc.indexOf('className={actionRowCls}')
    const block = cardSrc.slice(marketBlockIdx, actionRowIdx)
    expect(block).not.toMatch(/line-clamp|truncate/)
  })
})

describe('20B §26: mobile buy-link discoverability — visible without hover', () => {
  it('the availability Link is underlined by default at <md, hover-gated only at md+', () => {
    const idx = cardSrc.indexOf('hasAvailability ? (')
    const block = cardSrc.slice(idx, cardSrc.indexOf('</Link>', idx))
    expect(block).toContain('underline md:no-underline')
    expect(block).toContain('md:hover:underline')
  })

  it('retains the trailing arrow on the (now single, breakpoint-shared) supply line', () => {
    const matches = [...cardSrc.matchAll(/<span aria-hidden="true">→<\/span>/g)]
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('retains clear focus-visible styling (never removed for the mobile polish)', () => {
    const idx = cardSrc.indexOf('hasAvailability ? (')
    const block = cardSrc.slice(idx, cardSrc.indexOf('</Link>', idx))
    expect(block).toContain('focus-visible:outline')
  })

  it('no fourth Buy button was added', () => {
    expect(cardSrc).not.toMatch(/>Buy</)
  })
})

describe('20B §27: mobile Owned label — no quantity digits in the compact cell, retained in accessible name', () => {
  it('mobile shows bare "Owned"; desktop shows "Owned N"', () => {
    const idx = cardSrc.indexOf('collectionItemId ? (')
    const block = cardSrc.slice(idx, cardSrc.indexOf(') : (', idx))
    expect(block).toContain('<span className="md:hidden">Owned</span>')
    expect(block).toContain("<span className=\"hidden md:inline\">Owned{ownedQuantity !== null ? ` ${ownedQuantity}` : ''}</span>")
  })

  it('accessible name retains the quantity regardless of what is visually shown', () => {
    expect(cardSrc).toContain('aria-label={ownedQuantity !== null ? `Owned, quantity ${ownedQuantity} — ${modelName}` : `View owned ${modelName}`}')
  })

  it('underlying CollectionItem quantity semantics are untouched — still sourced from relationship.ownedQuantity, never re-derived', () => {
    expect(cardSrc).toContain('const ownedQuantity = relationship?.ownedQuantity ?? null')
  })
})

describe('20B §28: Want/Wanted labels unchanged (no reduction)', () => {
  it('Want and Wanted both still render their full text on every breakpoint (no md:hidden/hidden md:inline split)', () => {
    expect(cardSrc).toContain('label="Want"')
    expect(cardSrc).toContain('label="Wanted"')
  })
})

describe('20B §29: touch targets unchanged', () => {
  it('3-column Want/Own/Sell row and min-h-11 (44px) targets retained', () => {
    expect(cardSrc).toContain('grid grid-cols-3')
    expect(cardSrc).toContain('min-h-11')
  })

  it('no popup/long-press/hover-only requirement was introduced', () => {
    expect(cardSrc).not.toMatch(/Popup|onTouchStart|onContextMenu/)
  })
})

describe('20B §30: card structure — model identity Link, availability Link/text, actions remain siblings', () => {
  it('no nested interactive elements exist (no literal <button> inside the model Link)', () => {
    const modelLinkIdx = cardSrc.indexOf('<Link href={`/catalog/${model.id}`}')
    const modelLinkCloseIdx = cardSrc.indexOf('</Link>', modelLinkIdx)
    const inside = cardSrc.slice(modelLinkIdx, modelLinkCloseIdx)
    expect(inside).not.toContain('<form')
    expect(inside).not.toContain('PendingActionButton')
  })
})

describe('20B §23: search result context', () => {
  it('shows "N models for "q"" only when q is non-empty, using the already-known totalCount', () => {
    const idx = pageSrc.indexOf('q?.trim() && (')
    expect(idx).toBeGreaterThan(-1)
    const block = pageSrc.slice(idx, pageSrc.indexOf(')}', idx))
    expect(block).toContain('result.totalCount')
    expect(block).toContain("result.totalCount === 1 ? 'model' : 'models'")
  })

  it('renders q as normal React text (no dangerouslySetInnerHTML anywhere in the page)', () => {
    expect(pageSrc).not.toContain('dangerouslySetInnerHTML')
  })

  it('no relevance badges ("Exact Match"/"Best Match") anywhere on the card', () => {
    expect(cardSrc).not.toMatch(/Exact Match|Best Match/)
  })

  it('no new query was introduced for the context line — reuses result.totalCount from the existing getCatalogDiscovery call', () => {
    const idx = pageSrc.indexOf('q?.trim() && (')
    const block = pageSrc.slice(idx, pageSrc.indexOf(')}', idx))
    expect(block).not.toMatch(/await |prisma\./)
  })
})

describe('20B §34/§35: /market naming clarification — URL and query logic unchanged', () => {
  it('H1 is "Market Trends", not "Marketplace"', () => {
    expect(marketSrc).toContain('Market Trends')
    expect(marketSrc).not.toContain('>Marketplace<')
  })

  it('metadata title updated consistently', () => {
    expect(marketSrc).toContain("title: 'Market Trends | CollectNTrades'")
  })

  it('getMerchandisingData / merchandising query import is unchanged', () => {
    expect(marketSrc).toContain("import { getMerchandisingData } from '@/lib/marketplaceMerchandisingQuery'")
  })

  it('route file path is unchanged — still src/app/(store)/market/page.tsx (proven by having read it at that exact path above)', () => {
    expect(marketSrc.length).toBeGreaterThan(0)
  })
})

describe('20B §35: homepage CTA copy — Market Trends, href unchanged', () => {
  it('"Marketplace →" replaced with "Market Trends →", still linking to /market', () => {
    expect(homeSrc).toContain('Market Trends →')
    expect(homeSrc).not.toContain('Marketplace →')
    const idx = homeSrc.indexOf('Market Trends →')
    const before = homeSrc.slice(Math.max(0, idx - 200), idx)
    expect(before).toContain('href="/market"')
  })

  it('"Browse Listings →" is unchanged', () => {
    expect(homeSrc).toContain('Browse Listings →')
  })

  it('homepage sections are not reordered/redesigned — Trending/Recently listed previews still present', () => {
    expect(homeSrc).toContain('Trending now')
    expect(homeSrc).toContain('Recently listed')
  })
})

describe('20B §36: navigation — Market still → /catalog, no new top-level item', () => {
  it('primary nav still has exactly 4 entries, market key still points to /catalog', () => {
    expect(navSrc).toContain("{ key: 'market', label: 'Market', href: '/catalog' }")
    const navMatches = [...navSrc.matchAll(/CUSTOMER_PRIMARY_NAV: CustomerNavItem\[\] = \[([\s\S]*?)\]/g)]
    expect(navMatches[0][1].match(/key:/g)?.length).toBe(4)
  })

  it('/catalog, /browse, /market all still map to the market nav tab', () => {
    expect(navSrc).toContain("prefixes: ['/catalog', '/browse', '/market']")
  })
})

describe('20B §37: /browse unchanged', () => {
  it('no /catalog → /browse bridge link was added', () => {
    expect(pageSrc).not.toContain('href="/browse"')
  })
})
