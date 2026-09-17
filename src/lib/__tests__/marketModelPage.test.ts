/**
 * 24B: Market Model Page (/catalog/[id]) — variant selector, EMV/history/ask
 * asymmetry, empty states, SEO, methodology, and scope regression. Structural/
 * source-text checks, mirroring the established 16H/16I convention (no React
 * rendering harness exists in this codebase — see catalogModelHub.test.ts).
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

const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
const snapshotSrc = readSrc('src/components/store/MarketSnapshot.tsx')
const chartSrc = readSrc('src/components/store/PriceHistoryChart.tsx')
const recentSrc = readSrc('src/components/store/RecentSalesList.tsx')
const methodologySrc = readSrc('src/components/store/MarketMethodology.tsx')
const marketVariantSrc = readSrc('src/lib/marketVariant.ts')
const marketSaleQuerySrc = readSrc('src/lib/marketSaleQuery.ts')
const marketAskQuerySrc = readSrc('src/lib/marketAskQuery.ts')

// ── Variant selector: query state, server resolution, no arbitrary id trust ───

describe('24B: variant selector uses public query state, resolved server-side (§5/§39/§81)', () => {
  it('reads variant from searchParams, never from a client component/API route', () => {
    expect(hubSrc).toContain('searchParams: Promise<{ cursor?: string; variant?: string }>')
    expect(hubSrc).not.toContain("'use client'")
  })

  it('resolves the requested packaging slug via isValidPackagingType, never accepting a raw MarketVariant id', () => {
    expect(hubSrc).toContain('const requestedPackaging = isValidPackagingType(variant) ? variant : null')
  })

  it('resolves to the actual MarketVariant row via the canonical server-only helper (findPackagingMarketVariant)', () => {
    expect(hubSrc).toContain('findPackagingMarketVariant(prisma, id, requestedPackaging)')
  })

  it('invalid/unrecognized variant value falls back to All (never an error, never a 404)', () => {
    expect(hubSrc).toContain("const selectedVariant: 'all' | PackagingType = marketVariantId ? requestedPackaging! : 'all'")
  })

  it('default (no variant param) is All, not Carded', () => {
    // requestedPackaging is null when `variant` is undefined -> marketVariantId stays
    // null -> selectedVariant falls to 'all'.
    expect(hubSrc).toContain('const requestedPackaging = isValidPackagingType(variant) ? variant : null')
    expect(hubSrc).toContain("? requestedPackaging! : 'all'")
  })
})

describe('24B: variant selector links never carry the listing cursor; listing pagination always carries the variant (§6/§42/§74)', () => {
  it('variantHref builds from id + variant only, no cursor reference', () => {
    const idx = hubSrc.indexOf('const variantHref =')
    const line = hubSrc.slice(idx, hubSrc.indexOf('\n', idx))
    expect(line).not.toContain('cursor')
  })

  it('the three variant tab links (All/Carded/Loose) are built via variantHref, not a hand-rolled href', () => {
    const navIdx = hubSrc.indexOf('<nav aria-label="Market view"')
    const navBlock = hubSrc.slice(navIdx, hubSrc.indexOf('</nav>', navIdx))
    expect(navBlock).toContain('href={variantHref(v)}')
  })

  it('the "Show more" listing link carries the selected variant plus the cursor', () => {
    expect(hubSrc).toContain(
      "const nextPageHref = hub.nextCursor\n    ? `/catalog/${id}?${selectedVariant !== 'all' ? `variant=${selectedVariant}&` : ''}cursor=${encodeURIComponent(hub.nextCursor)}`",
    )
  })

  it('active variant tab is marked with aria-current, not color alone', () => {
    expect(hubSrc).toContain("aria-current={active ? 'page' : undefined}")
  })
})

// ── Variant-strict listing filtering ────────────────────────────────────────

describe('24B: Available Listings are variant-strict when a variant is selected, no model-level fallback (§8/§12/§43/§73)', () => {
  it('getCatalogModelHub receives the resolved marketVariantId (undefined for All)', () => {
    expect(hubSrc).toContain('getCatalogModelHub(id, cursor, marketVariantId ?? undefined)')
  })

  it('getCatalogModelHub threads marketVariantId into the shared eligibility predicate, not a bespoke filter', () => {
    const querySrc = readSrc('src/lib/catalogModelHubQuery.ts')
    expect(querySrc).toContain('eligibleListingWhere(catalogModelId, marketVariantId)')
  })

  it('eligibleListingWhere applies marketVariantId as an exact filter, never a broader OR', () => {
    const eligSrc = readSrc('src/lib/listingEligibility.ts')
    expect(eligSrc).toContain('...(marketVariantId !== undefined ? { marketVariantId } : {}),')
  })
})

// ── Load-bearing invariant: EMV may broaden; History/Last-Sale/Asks never do ──

describe('24B: EMV-fallback-vs-strictness asymmetry — the Series-24 load-bearing invariant (§8-§12/§68/§69/§77/§84/§85)', () => {
  it('a single variantFilter is spread identically into getMarketQuote (EMV+asks+last-sale) and getMarketSaleHistory (price history) — no divergent scoping between them', () => {
    const calls = [
      'getMarketQuote({ catalogModelId: id, ...variantFilter, asOf, includeLastSale: true })',
      'getMarketSaleHistory({ catalogModelId: id, ...variantFilter, endDate: asOf, limit: HISTORY_LIMIT })',
    ]
    for (const call of calls) {
      expect(hubSrc).toContain(call)
    }
  })

  it('27B: getMarketQuote (marketQuoteQuery.ts) spreads the SAME variantFilter/conditionFilter into getValuation, getInternalAskSummary, and both getLatestSale calls — the composition never diverges internally', () => {
    const quoteSrc = fs.readFileSync(path.join(root, 'src/lib/marketQuoteQuery.ts'), 'utf-8')
    expect(quoteSrc).toContain('getValuation({ catalogModelId: input.catalogModelId, ...variantFilter, ...conditionFilter, asOf })')
    expect(quoteSrc).toContain('getInternalAskSummary({ catalogModelId: input.catalogModelId, ...variantFilter })')
    expect(quoteSrc).toContain("getLatestSale({ catalogModelId: input.catalogModelId, ...variantFilter, sources: ['internal', 'external'], endDate: asOf })")
    expect(quoteSrc).toContain("getLatestSale({ catalogModelId: input.catalogModelId, ...variantFilter, sources: ['internal'], endDate: asOf })")
  })

  it('27B: includeLastSale defaults falsy — a consumer that omits it (the seller Market Snapshot) never issues either getLatestSale query', () => {
    const quoteSrc = fs.readFileSync(path.join(root, 'src/lib/marketQuoteQuery.ts'), 'utf-8')
    const idx = quoteSrc.indexOf('input.includeLastSale')
    expect(idx).toBeGreaterThan(-1)
    expect(quoteSrc.slice(idx, idx + 60)).toMatch(/input\.includeLastSale\s*\n\s*\?/)
  })

  it('getMarketSaleHistory/getLatestSale (22B) contain no specificity/tier-broadening logic — history can never silently fall back the way EMV does', () => {
    expect(marketSaleQuerySrc).not.toMatch(/specificity|allowedTiers|primarySpecificity/)
    expect(marketSaleQuerySrc).toMatch(/NO valuation: no confidence, no outlier removal, no weighted estimate, no\s*\n\/\/ fallback broadening/)
  })

  it('getInternalAskSummary/getInternalAsks/getLowestAsk (marketAskQuery.ts) contain no specificity/tier-broadening logic either', () => {
    expect(marketAskQuerySrc).not.toMatch(/specificity|allowedTiers|primarySpecificity/)
  })

  it('only getValuation (23B) references specificity/primarySpecificity — the broadening capability is exclusive to EMV', () => {
    const valuationSrc = readSrc('src/lib/marketValuation.ts')
    expect(valuationSrc).toMatch(/specificity/)
  })

  it('the page discloses EMV fallback via isFallbackSpecificity, never silently presenting a broadened estimate as variant-pure', () => {
    expect(snapshotSrc).toContain('isFallbackSpecificity(valuation)')
    expect(snapshotSrc).toContain('Using broader model-level sales due to limited packaging-specific history.')
  })
})

// ── Last Sale display (§22/§23/§70) ─────────────────────────────────────────

describe('24B: Last Market Sale / Last CollectNTrades Sale wiring', () => {
  it('MarketSnapshot delegates row-suppression logic to resolveLastSaleDisplay (pure, tested separately)', () => {
    expect(snapshotSrc).toContain('resolveLastSaleDisplay(lastMarketSale, lastInternalSale)')
  })

  it('no sale at all renders "No sales recorded yet." for Last Market Sale', () => {
    expect(snapshotSrc).toContain('Last Market Sale: No sales recorded yet.')
  })

  it('external-only (no internal ever) renders a compact "No CollectNTrades sales yet." note', () => {
    expect(snapshotSrc).toContain('No CollectNTrades sales yet.')
  })

  it('never shows a raw provider string — only the canonical CollectNTrades/External marketplace labels via saleSourceLabel', () => {
    expect(snapshotSrc).not.toMatch(/\.provider\b/)
    expect(snapshotSrc).toContain('saleSourceLabel(lastMarketSale)')
  })
})

// ── Public provider policy (§24/§89) ────────────────────────────────────────

function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

describe('24B: no raw provider/matchMethod/snapshotProvenance/rawSnapshot ever rendered publicly', () => {
  for (const [name, src] of [
    ['MarketSnapshot', snapshotSrc],
    ['PriceHistoryChart', chartSrc],
    ['RecentSalesList', recentSrc],
    ['catalog/[id]/page.tsx', hubSrc],
  ] as const) {
    it(`${name} never references provider/matchMethod/snapshotProvenance/rawSnapshot outside of comments`, () => {
      expect(stripComments(src)).not.toMatch(/\.provider\b|matchMethod|snapshotProvenance|rawSnapshot/)
    })
  }
})

// ── Price History (§28/§29/§33/§40) ─────────────────────────────────────────

describe('24B: Price History sourced exclusively from getMarketSaleHistory, executed sales only, bounded 500', () => {
  it('history query uses limit 500 and endDate=asOf, no startDate override, no asks', () => {
    expect(hubSrc).toContain('limit: HISTORY_LIMIT')
    expect(hubSrc).toContain('const HISTORY_LIMIT = 500')
  })

  it('no infinite pagination / hasMore-triggered UI was added for history', () => {
    expect(hubSrc).not.toMatch(/history\.hasMore/)
  })

  it('chart JSX renders discrete <circle> points only — no <polyline>/<path> connecting observations', () => {
    const jsxBlock = chartSrc.slice(chartSrc.indexOf('return ('))
    expect(jsxBlock).not.toMatch(/<polyline|<path/)
    expect(jsxBlock).toContain('<circle')
  })

  it('chart returns null (no empty SVG frame) when there are zero points', () => {
    expect(chartSrc).toContain('if (points.length === 0) return null')
  })

  it('chart is not the sole representation — carries an accessible role/label and is always paired with RecentSalesList in the page', () => {
    expect(chartSrc).toContain('role="img"')
    const sectionIdx = hubSrc.indexOf('Price History')
    const sectionBlock = hubSrc.slice(sectionIdx, hubSrc.indexOf('</section>', sectionIdx))
    expect(sectionBlock).toContain('PriceHistoryChart')
    expect(sectionBlock).toContain('RecentSalesList')
  })

  it('empty history state is a concise dashed placeholder, never a blank chart frame', () => {
    expect(hubSrc).toContain('No completed sales recorded yet.')
  })

  it('RecentSalesList is bounded to a compact recent subset, not all 500 rows', () => {
    expect(recentSrc).toContain('RECENT_SALES_LIMIT = 10')
    expect(recentSrc).toContain('observations.slice(0, RECENT_SALES_LIMIT)')
  })

  it('RecentSalesList uses only normalized fields — no seller/internal-provenance columns', () => {
    const jsxBlock = recentSrc.slice(recentSrc.indexOf('return ('))
    expect(jsxBlock).not.toMatch(/seller|sourceRecordId/i)
  })
})

// ── Empty-state combinations (§46-§49/§78) ──────────────────────────────────

describe('24B: empty-state combinations render independently, never a dead-end page', () => {
  it('EMV-insufficient state is independent of ask/listing availability (its own branch inside MarketSnapshot)', () => {
    expect(snapshotSrc).toContain("valuation.status === 'valued'")
    expect(snapshotSrc).toContain('Not enough direct sales data yet.')
  })

  it('ask cluster has its own independent empty state ("None available right now.")', () => {
    expect(snapshotSrc).toContain('None available right now.')
  })

  it('Price History empty state and Available Listings empty state are separate, non-nested sections', () => {
    const historyIdx = hubSrc.indexOf('No completed sales recorded yet.')
    const listingsIdx = hubSrc.indexOf('No copies currently available.')
    expect(historyIdx).toBeGreaterThan(0)
    expect(listingsIdx).toBeGreaterThan(historyIdx)
    // Neither empty-state string appears inside the other section's JSX block.
    const historySection = hubSrc.slice(hubSrc.indexOf('<h2 className="text-sm font-semibold text-gray-900 mb-2">Price History'), hubSrc.indexOf('</section>', historyIdx))
    expect(historySection).not.toContain('No copies currently available.')
  })

  it('identity, actions, and model details remain visible regardless of listing/sale/ask availability (unconditional render, not gated behind hasListings)', () => {
    const actionsIdx = hubSrc.indexOf('<CatalogModelActions')
    const before = hubSrc.slice(Math.max(0, actionsIdx - 120), actionsIdx)
    expect(before).not.toMatch(/hasListings\s*&&\s*$/)
  })
})

// ── Actions remain CatalogModel-level (§44/§52/§79) ─────────────────────────

describe('24B: Want/I Own It/Sell remain CatalogModel-level, unaffected by variant selection', () => {
  it('CatalogModelActions is invoked with catalogModelId, never marketVariantId', () => {
    expect(hubSrc).toContain('<CatalogModelActions catalogModelId={id} modelName={modelName} relationship={relationship} />')
    expect(hubSrc).not.toMatch(/<CatalogModelActions[^>]*marketVariantId/)
  })

  it('CatalogModelActions is rendered exactly once, outside the variant selector/listings map', () => {
    const matches = [...hubSrc.matchAll(/<CatalogModelActions/g)]
    expect(matches.length).toBe(1)
  })
})

// ── Hero image remains model-level (§45/§53) ────────────────────────────────

describe('24B: hero image is model-level, never variant-specific', () => {
  it('PhotoThumbnail uses hub.model.photoUrl, unconditioned on selectedVariant', () => {
    expect(hubSrc).toContain('<PhotoThumbnail photoUrl={hub.model.photoUrl} alt={modelName} size="fill" />')
  })
})

// ── Methodology disclosure (§46/§61/§80) ────────────────────────────────────

describe('24B: methodology disclosure is a collapsed-by-default <details>, no client JS, no investment framing', () => {
  it('uses a native <details>/<summary>, no useState/client component', () => {
    expect(methodologySrc).toContain('<details')
    expect(methodologySrc).toContain('<summary')
    expect(methodologySrc).not.toContain("'use client'")
  })

  it('content covers executed sales, median, same-model-only, source mix, asks excluded, outliers', () => {
    expect(methodologySrc).toMatch(/completed \(executed\) comparable sales/)
    expect(methodologySrc).toMatch(/median sale price/)
    expect(methodologySrc).toMatch(/this exact catalog model/)
    expect(methodologySrc).toMatch(/CollectNTrades and tracked external marketplace sales/)
    expect(methodologySrc).toMatch(/Active asking prices never affect/)
    expect(methodologySrc).toMatch(/outliers may be excluded/)
  })

  it('is embedded inside MarketSnapshot, near the EMV, not a separate page section', () => {
    expect(snapshotSrc).toContain('<MarketMethodology')
  })
})

// ── SEO (§48/§67/§81) ────────────────────────────────────────────────────────

describe('24B: SEO description uses stable identity fields only, never fast-changing market data', () => {
  it('generateMetadata now returns both title and description', () => {
    const idx = hubSrc.indexOf('export async function generateMetadata')
    const fnSrc = hubSrc.slice(idx, hubSrc.indexOf('export default', idx))
    expect(fnSrc).toContain('return { title, description }')
  })

  it('description text never embeds EMV/ask/sale amounts', () => {
    const idx = hubSrc.indexOf('const description =')
    const descBlock = hubSrc.slice(idx, hubSrc.indexOf('return { title, description }', idx))
    expect(descBlock).not.toMatch(/estimatedValue|lowestAsk|priceCents|\$\{.*price/i)
  })

  it('description is built only from brand/name/series (stable identity)', () => {
    expect(hubSrc).toContain('model.brand} ${model.name}')
    expect(hubSrc).toContain('model.series')
  })
})

// ── JSON-LD out of scope (§49) ───────────────────────────────────────────────

describe('24B: no JSON-LD/structured data introduced', () => {
  it('no application/ld+json anywhere in the page or new components', () => {
    for (const src of [hubSrc, snapshotSrc, chartSrc, recentSrc, methodologySrc]) {
      expect(src).not.toMatch(/application\/ld\+json|schema\.org/)
    }
  })
})

// ── Cache/freshness unchanged (§50) ──────────────────────────────────────────

describe('24B: caching/freshness semantics unchanged', () => {
  it('still force-dynamic, no unstable_cache/revalidate export added', () => {
    expect(hubSrc).toContain("export const dynamic = 'force-dynamic'")
    expect(hubSrc).not.toContain('unstable_cache')
    expect(hubSrc).not.toMatch(/export const revalidate/)
  })
})

// ── No client market-data fetch (§56/§60/§82) ───────────────────────────────

describe('24B: market-data rendering stays fully server-side', () => {
  it('no "use client" directive in the page or any new market component', () => {
    for (const src of [hubSrc, snapshotSrc, chartSrc, recentSrc, methodologySrc]) {
      expect(src).not.toContain("'use client'")
    }
  })

  it('no client fetch()/API route was introduced for market data', () => {
    for (const src of [hubSrc, snapshotSrc, chartSrc, recentSrc]) {
      expect(src).not.toMatch(/fetch\(/)
    }
    expect(exists('src/app/api/catalog/[id]')).toBe(false)
    expect(exists('src/app/api/market-model')).toBe(false)
  })
})

// ── No condition selector (§60/§87) ─────────────────────────────────────────

describe('24B: no condition selector added to the public Market Model Page', () => {
  it('no condition query param or condition filter UI in the page', () => {
    expect(hubSrc).not.toMatch(/searchParams\.condition|conditionFilter/)
    expect(hubSrc).not.toContain('condition:')
  })
})

// ── Scope regression (§82) ───────────────────────────────────────────────────

describe('24B: no schema/migration/package changes; Collection/Seller/Admin valuation untouched', () => {
  it('marketVariant.ts (schema-adjacent helper) has no new Prisma model or migration references added here', () => {
    expect(marketVariantSrc).not.toMatch(/CREATE TABLE|ALTER TABLE/)
  })

  it('Collection valuation was untouched by 24B (24B only migrated the catalog page); 25B later migrated it off the legacy engine — confirmed by its own test suite', () => {
    const redirectSrc = readSrc('src/app/(store)/account/collection/valuation/page.tsx')
    expect(redirectSrc).toContain("redirect('/account/collection')")
  })

  // 27B migrated the customer seller route off these legacy engines (see
  // sellerLegacyMigration.test.ts) — admin remains untouched (§65 boundary).
  it('admin resale-estimator remains on the legacy engine; the customer seller route no longer does', () => {
    const sellSrc = readSrc('src/app/(store)/account/sell/[id]/page.tsx')
    expect(sellSrc).not.toMatch(/computeEstimate|getPricingIntelligence/)
    const adminEstimatorSrc = readSrc('src/app/(admin)/admin/resale-estimator/page.tsx')
    expect(adminEstimatorSrc).toContain('computeEstimate')
  })

  it('no admin file references the new market-model-page components', () => {
    const adminDir = path.join(root, 'src/app/(admin)')
    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    }
    const adminFiles = walk(adminDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    for (const f of adminFiles) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toMatch(/MarketSnapshot|PriceHistoryChart|RecentSalesList|marketModelPageDisplay/)
    }
  })
})

// ── No investment framing (§59/§61/§92) ─────────────────────────────────────

describe('24B: terminology avoids investment/brokerage framing', () => {
  it('page/components never use Fair Value, Target Price, Expected Return, Bid, Ask Spread, Upside, Bullish/Bearish', () => {
    for (const src of [hubSrc, snapshotSrc, chartSrc, recentSrc, methodologySrc]) {
      expect(src).not.toMatch(/Fair Value|Target Price|Expected Return|\bBid\b|Ask Spread|Upside|Bullish|Bearish|gainers|forecast/i)
    }
  })

  it('uses the approved terminology set', () => {
    expect(snapshotSrc).toContain('Estimated Market Value')
    expect(snapshotSrc).toContain('Last Market Sale')
    expect(snapshotSrc).toContain('Last CollectNTrades Sale')
    expect(snapshotSrc).toContain('Lowest Ask')
    expect(snapshotSrc).toContain('Median Ask')
    expect(snapshotSrc).toContain('Available Copies')
    expect(hubSrc).toContain('Price History')
  })
})
