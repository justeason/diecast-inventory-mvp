// 29B: Market Discovery V1 — batch-value ONLY the visible /catalog page,
// using the canonical getValuationsBatch (25B), at one shared asOf, with the
// valuation call isolated from the rest of the page. Structural (source-text)
// tests, matching this codebase's established convention for Server
// Component pages (no React rendering harness anywhere in this suite —
// getCatalogDiscovery's own pagination tests in catalogDiscovery.test.ts
// already prove `take` is always bounded to CATALOG_PAGE_SIZE and never the
// whole table; this file proves the valuation call is wired to that exact
// same page-scoped id list, never a separate/broader query).
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

const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
const pageCode = stripComments(pageSrc)

describe('29B: visible-page-only batching — the critical regression (§2/§4/§46)', () => {
  it('modelIds is declared exactly once, from result.models (the already-paginated page) — never from a separate/unbounded query', () => {
    const declarations = [...pageCode.matchAll(/const modelIds =/g)]
    expect(declarations.length).toBe(1)
    expect(pageSrc).toContain('const modelIds = result.models.map((m) => m.id)')
  })

  it('getValuationsBatch is called with catalogModelIds bound to that exact modelIds variable — the SAME array already used for relationship batching, so page 2 can never receive page 1 (or any off-page) ids', () => {
    expect(pageSrc).toContain('getValuationsBatch({ catalogModelIds: modelIds, asOf })')
    // Both batch calls read the identical `modelIds` reference — proven by
    // there being only one declaration (previous test) feeding both call sites.
    expect(pageSrc).toContain('getCatalogRelationshipState(session.profileId, modelIds)')
  })

  it('getValuationsBatch is called after getCatalogDiscovery resolves — never before pagination is known, never valuing a pre-pagination candidate set', () => {
    const discoveryIdx = pageSrc.indexOf('await getCatalogDiscovery(')
    const batchIdx = pageSrc.indexOf('await getValuationsBatch(')
    expect(discoveryIdx).toBeGreaterThan(-1)
    expect(batchIdx).toBeGreaterThan(discoveryIdx)
  })

  it('getValuationsBatch is called exactly once per page render — no per-card/loop invocation', () => {
    const matches = [...pageCode.matchAll(/getValuationsBatch\(/g)]
    expect(matches.length).toBe(1)
  })
})

describe('29B: one shared asOf for the whole page render (§5)', () => {
  it('asOf is declared once as `new Date()` and passed straight into the batch call — no per-card asOf, no Date.now() scattered elsewhere for valuation', () => {
    const declarations = [...pageCode.matchAll(/const asOf = new Date\(\)/g)]
    expect(declarations.length).toBe(1)
    expect(pageSrc).toContain('getValuationsBatch({ catalogModelIds: modelIds, asOf })')
  })
})

describe('29B: canonical valuation source only — no per-card fanout, no new ask query (§6/§7/§26)', () => {
  it('imports getValuationsBatch from the canonical marketValuation module — never getValuation/getMarketQuote for card enrichment', () => {
    expect(pageSrc).toContain("import { getValuationsBatch, type ValuationResult } from '@/lib/marketValuation'")
    expect(pageCode).not.toMatch(/\bgetValuation\(/)
    expect(pageCode).not.toMatch(/getMarketQuote\(/)
  })

  it('never imports/calls getInternalAskSummary — Lowest Ask/Available Copies stay sourced from the existing page-scoped listing aggregation only', () => {
    expect(pageCode).not.toMatch(/getInternalAskSummary/)
  })

  it('reuses the existing result.availabilityByModel map for supply data — no new query for ask/count', () => {
    expect(pageSrc).toContain('result.availabilityByModel.get(model.id)')
  })
})

describe('29B: error isolation scoped to ONLY the optional valuation enrichment (§8/§27-30)', () => {
  it('the getValuationsBatch call is wrapped in try/catch, with the catch degrading to null rather than rethrowing', () => {
    const idx = pageSrc.indexOf('try {')
    const block = pageSrc.slice(idx, pageSrc.indexOf('}', pageSrc.indexOf('catch', idx)) + 200)
    expect(block).toContain('getValuationsBatch(')
    expect(block).toContain('valuationByModel = null')
    expect(block).not.toMatch(/throw/)
  })

  it('the failure is logged via the canonical structured logger, not a raw console.error/swallowed silently', () => {
    expect(pageSrc).toContain("import { logger } from '@/lib/serverLogger'")
    expect(pageSrc).toContain('logger.error(')
    expect(pageCode).not.toMatch(/console\.(error|log|warn)/)
  })

  it('getCatalogDiscovery, getBuyerSession, and getCatalogRelationshipState are never wrapped in the same try/catch — only valuation enrichment is isolated', () => {
    const tryIdx = pageSrc.indexOf('try {')
    const catchEndIdx = pageSrc.indexOf('valuationByModel = null\n  }', tryIdx) + 'valuationByModel = null\n  }'.length
    const isolatedBlock = pageSrc.slice(tryIdx, catchEndIdx)
    expect(isolatedBlock).not.toContain('getCatalogDiscovery')
    expect(isolatedBlock).not.toContain('getBuyerSession')
    expect(isolatedBlock).not.toContain('getCatalogRelationshipState')
  })
})

describe('29B: Map-based lookup by catalogModelId — never array-index/order equality (§31/§32)', () => {
  it('CatalogModelCard receives marketValuation via a Map.get(model.id) lookup with a null fallback, mirroring the existing relationship-map pattern', () => {
    expect(pageSrc).toContain('marketValuation={valuationByModel?.get(model.id) ?? null}')
  })

  it('valuationByModel is typed as a Map, never an array', () => {
    expect(pageSrc).toContain('let valuationByModel: Map<string, ValuationResult> | null = null')
  })
})

describe('29B: no schema/migration/scope creep in the page itself (§60-67)', () => {
  it('no new Prisma model/table query beyond the existing catalog/listing/relationship/valuation calls', () => {
    expect(pageCode).not.toMatch(/prisma\./)
  })

  it('no new sort/filter control wired to market data — filters/sort/pagination props are unchanged (CatalogSearchBar/Pagination calls untouched)', () => {
    expect(pageSrc).toContain('<CatalogSearchBar q={q} brand={brand} year={year} availableNow={availableNow} brands={result.brands} />')
    expect(pageCode).not.toMatch(/sort=|sortBy|priceMin|priceMax|emvSort/i)
  })
})
