/**
 * 16I: catalog listing selection UX — CatalogListingOption (one physical copy
 * per row on /catalog/[id]) plus the hub page's Available Copies section.
 * Structural/source-regex checks, mirroring the 16H test convention.
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

const optionSrc = readSrc('src/components/store/CatalogListingOption.tsx')
const optionCode = stripComments(optionSrc)
const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
const queryModuleSrc = readSrc('src/lib/catalogModelHubQuery.ts')
const listingCardSrc = readSrc('src/components/store/ListingCard.tsx')
const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
const marketSrc = readSrc('src/app/(store)/market/page.tsx')
const storeHomeSrc = readSrc('src/app/(store)/page.tsx')
const addToCartSrc = readSrc('src/components/store/AddToCartButton.tsx')
const cartSrc = readSrc('src/lib/cart.ts')

// ── Component architecture (Part B, C) ──────────────────────────────────────────

describe('16I: dedicated presentation component for one physical copy', () => {
  it('CatalogListingOption exists as a new file distinct from ListingCard', () => {
    expect(exists('src/components/store/CatalogListingOption.tsx')).toBe(true)
  })

  it('the hub page renders CatalogListingOption, not ListingCard', () => {
    expect(hubSrc).toContain('CatalogListingOption')
    expect(hubSrc).not.toContain('ListingCard')
  })

  it('reuses AddToCartButton verbatim — no second Buy implementation', () => {
    expect(optionSrc).toContain("import { AddToCartButton } from './AddToCartButton'")
    expect(optionSrc).not.toMatch(/addCatalogModelToCart|buyModel|selectCheapestListing/)
  })

  it('CartItem shape matches the existing cart domain type exactly (listingId, title, price, sku, condition, cardedOrLoose, photoUrl)', () => {
    expect(optionSrc).toContain("import type { CartItem } from '@/lib/cart'")
    expect(optionSrc).toContain('listingId: listing.id')
    expect(optionSrc).toContain('price: listing.price')
  })

  it('has no Prisma import — presentation only, no second query engine', () => {
    expect(optionSrc).not.toContain("from '@/lib/prisma'")
  })
})

// ── Part D/J/AM: one option per physical Listing, no auto-selection ────────────

describe('16I: one option per Listing, no auto-selection, no client selection state', () => {
  it('maps every hub.listings entry to its own CatalogListingOption keyed by listing.id', () => {
    expect(hubSrc).toMatch(/hub\.listings\.map\(\(listing, index\) => \(/)
    expect(hubSrc).toContain('key={listing.id}')
  })

  it('no cheapest-Listing auto-selection anywhere in the hub or the option component', () => {
    for (const src of [hubSrc, optionSrc]) {
      expect(src).not.toMatch(/listings\[0\]/)
      expect(src).not.toMatch(/\.sort\(/)
    }
  })

  it('no client-side "selected listing" state (no useState/useReducer for selection, no ?selectedListing= URL param)', () => {
    expect(hubSrc).not.toMatch(/useState|useReducer/)
    expect(hubSrc).not.toContain('selectedListing')
  })

  it('every option carries its own AddToCartButton — no single global Buy button wrapping the whole list', () => {
    const matches = [...optionSrc.matchAll(/<AddToCartButton/g)]
    expect(matches.length).toBe(1) // one per component instance; the list itself maps N instances
    expect(hubSrc).not.toMatch(/<AddToCartButton/)
  })
})

// ── Part E/F/G: comparable fields, no repeated model identity, exact price ─────

describe('16I: comparison fields are Listing-specific, exact price, no repeated model identity', () => {
  it('shows exact Listing price via existing dollar-float formatting, no cents conversion, no valuation-derived price', () => {
    expect(optionSrc).toContain('listing.price.toFixed(2)')
    expect(optionSrc).not.toMatch(/estimatedValue|valuation/i)
  })

  it('shows condition and packaging using existing item fields', () => {
    expect(optionSrc).toContain('item.condition')
    expect(optionSrc).toContain('item.cardedOrLoose')
  })

  it('does not repeat brand/name/year/series/color/scale per row (model identity shown once at the hub header)', () => {
    expect(optionSrc).not.toMatch(/\.brand\b|\.series\b|\.scale\b/)
  })

  it('does not expose seller-private or internal fields', () => {
    expect(optionSrc).not.toMatch(/purchasePrice|payout|storageLocation|sellerEmail|sellerAgreement|conditionNotes|adminNotes|riskFlag/i)
  })
})

// ── Part H/I/V: authoritative summary, no fake recommendation ──────────────────

describe('16I: available-copies summary stays authoritative and honest', () => {
  it('summary line still uses hub.listingCount and hub.lowestPrice from the same 16H query — no page-length recount', () => {
    expect(hubSrc).toContain('hub.listingCount')
    expect(hubSrc).toContain('hub.lowestPrice')
    expect(hubSrc).not.toMatch(/hub\.listings\.length\}\s*(available|copies|results)/)
  })

  it('never labels the lowest price "Best deal", "Best choice", or "Recommended"', () => {
    for (const src of [hubSrc, optionSrc]) {
      expect(src).not.toMatch(/Best deal|Best choice|Recommended/i)
    }
  })

  it('no discount/deal-score/undervalued computation exists', () => {
    for (const src of [hubSrc, optionSrc]) {
      expect(src).not.toMatch(/discount|dealScore|undervalued/i)
    }
  })
})

// ── Part K/L: View Copy + Buy per option ────────────────────────────────────────

describe('16I: View Copy and Buy are per-option, targeting the exact Listing route/id', () => {
  it('View Copy links to the existing /browse/[listingId] route, not a new route', () => {
    expect(optionSrc).toContain('href={`/browse/${listing.id}`}')
  })

  it('does not replace or fork /browse/[id]', () => {
    expect(exists('src/app/(store)/browse/[id]/page.tsx')).toBe(true)
  })

  it('View Copy has a meaningful accessible name distinguishing the copy, without exposing the raw Listing id as visible text', () => {
    expect(optionSrc).toContain('aria-label={`View copy details')
    expect(optionSrc).not.toMatch(/>{listing\.id}</)
  })
})

// ── Part M/N: eligibility predicate & stale-availability authority ─────────────

describe('16I: preserves the exact 16H eligibility predicate; no client-derived availability logic', () => {
  it('CatalogListingOption contains no status/availability predicate of its own', () => {
    expect(optionSrc).not.toMatch(/status\s*===\s*['"]active['"]/)
    expect(optionSrc).not.toMatch(/where:/)
  })

  it('the eligible-Listing query predicate in catalogModelHubQuery.ts is unchanged from 16H', () => {
    expect(queryModuleSrc).toContain("status: 'active' as const")
    expect(queryModuleSrc).toContain("item: { status: 'available' as const, catalogId: catalogModelId }")
  })

  it('AddToCartButton (unmodified) remains the sole cart-mutation authority — no client reservation/availability truth added', () => {
    expect(addToCartSrc).toContain("import { useCart } from '@/lib/use-cart'")
    expect(optionSrc).not.toMatch(/reservation|isAvailable\s*=/)
  })
})

// ── Part O: model relationship actions appear once ─────────────────────────────

describe('16I: relationship actions (Want/Collection/Sell) are not repeated per copy', () => {
  it('CatalogListingOption never imports or renders CatalogModelActions/wantAction/unwantAction/addToCollectionAction', () => {
    expect(optionCode).not.toMatch(/CatalogModelActions|wantAction|unwantAction|addToCollectionAction/)
  })

  it('CatalogModelActions is rendered exactly once on the hub page, outside the Listing map', () => {
    const matches = [...hubSrc.matchAll(/<CatalogModelActions/g)]
    expect(matches.length).toBe(1)
    const idx = hubSrc.indexOf('<CatalogModelActions')
    const mapIdx = hubSrc.indexOf('hub.listings.map(')
    expect(idx).toBeLessThan(mapIdx)
  })
})

// ── Part P: image policy ─────────────────────────────────────────────────────────

describe('16I: image policy — item-specific photo only, no CollectionItem/admin photo leakage', () => {
  it('uses only listing.item.photos (the same public item photo the query already selects), never a CollectionItem or admin intake photo', () => {
    expect(optionSrc).toContain('item.photos[0]')
    expect(optionSrc).not.toMatch(/CollectionItem|intakeDraft|IntakeDraft/i)
  })

  it('reuses the existing PhotoThumbnail component, no new image-loading logic', () => {
    expect(optionSrc).toContain("import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'")
  })
})

// ── Part U/AF/AG: pagination, query shape, privacy ──────────────────────────────

describe('16I: no query changes beyond 16H — pagination, select shape, and privacy preserved', () => {
  it('catalogModelHubQuery.ts pagination logic (keyset cursor, LISTING_PAGE_SIZE) is byte-identical to 16H', () => {
    expect(queryModuleSrc).toContain('export const LISTING_PAGE_SIZE = 24')
    expect(queryModuleSrc).toContain("orderBy: { id: 'asc' }")
    expect(queryModuleSrc).toContain('skip: 1, cursor: { id: cursor }')
  })

  it('the Listing select shape is unchanged — no new fields added for the compact chooser', () => {
    expect(queryModuleSrc).toContain('sku: true,\n            cardedOrLoose: true,\n            condition: true,')
  })

  it('no SellerProfile/CollectionItem/SellerSubmission/financial fields were hydrated', () => {
    expect(queryModuleSrc).not.toMatch(/sellerProfile|SellerProfile|purchasePrice|listPrice/)
  })

  it('no per-row Prisma query exists in the option component or the hub page render path', () => {
    expect(optionSrc).not.toMatch(/prisma\./)
    const mapBlock = hubSrc.slice(hubSrc.indexOf('hub.listings.map('), hubSrc.indexOf('</ul>'))
    expect(mapBlock).not.toMatch(/await |prisma\./)
  })
})

// ── Part W/X/Y: no sorting/filtering/valuation-per-row scope creep ─────────────

describe('16I: no sorting engine, no filtering, no per-Listing valuation', () => {
  it('no sort-by-price/condition UI or query param was added', () => {
    expect(hubSrc).not.toMatch(/sortBy|sort=|orderBy=/)
  })

  it('no condition/packaging/price-range filter UI or query param was added', () => {
    expect(hubSrc).not.toMatch(/conditionFilter|priceRange|packagingFilter/)
  })

  it('valuation remains a single model-level section, not duplicated inside CatalogListingOption', () => {
    expect(optionSrc).not.toMatch(/getCatalogValuation|AdvancedConfidence/)
    const valuationMatches = [...hubSrc.matchAll(/getCatalogValuation\(/g)]
    expect(valuationMatches.length).toBe(1)
  })
})

// ── Part S: accessibility ────────────────────────────────────────────────────────

describe('16I: accessible semantic structure', () => {
  it('Available Copies section uses aria-labelledby pointing at its own heading id', () => {
    expect(hubSrc).toContain('aria-labelledby="available-copies-heading"')
    expect(hubSrc).toContain('id="available-copies-heading"')
    expect(hubSrc).toContain('Available Copies')
  })

  it('listings render inside a semantic <ul>/<li> list', () => {
    expect(hubSrc).toMatch(/<ul[^>]*>/)
    expect(hubSrc).toContain('<li key={listing.id}>')
  })

  it('View Copy link and Add-to-Cart button are siblings, not nested inside one another', () => {
    const linkIdx = optionSrc.indexOf('<Link')
    const linkCloseIdx = optionSrc.indexOf('</Link>', linkIdx)
    const addToCartIdx = optionSrc.indexOf('<AddToCartButton')
    expect(addToCartIdx).toBeGreaterThan(linkCloseIdx)
  })

  it('interactive elements carry focus-visible styling', () => {
    expect(optionSrc).toContain('focus-visible:outline')
  })

  it('condition/packaging differences are represented as text, not color alone', () => {
    expect(optionSrc).toContain('{conditionLabel}')
    expect(optionSrc).toContain('{packagingLabel}')
  })
})

// ── Part T: identical-looking copies never deduplicated ────────────────────────

describe('16I: visually identical Listings are never merged/deduplicated', () => {
  it('the list key is listing.id (unique per physical Listing), not a derived attribute string', () => {
    expect(hubSrc).toContain('key={listing.id}')
    expect(hubSrc).not.toMatch(/key=\{`\$\{listing\.price\}/)
  })

  it('each option computes its own independent cartItem/copyLabel from its own listing prop — no cross-row memoization or grouping', () => {
    expect(optionSrc).not.toMatch(/groupBy|Map<|new Set\(/)
  })
})

// ── Part AI: customer terminology ───────────────────────────────────────────────

describe('16I: customer-facing wording avoids internal/technical terms', () => {
  it('uses "Available Copies" / "copy" / "View Copy" language', () => {
    expect(hubSrc).toContain('Available Copies')
    expect(optionSrc).toContain('View Copy')
  })

  it('does not surface technical terms as visible text (Listing record, Listing ID, ItemInstance, Inventory entity, variant)', () => {
    for (const src of [hubSrc, optionSrc]) {
      expect(src).not.toMatch(/>Listing record<|>Listing ID<|>ItemInstance<|>Inventory entity<|>[Vv]ariant[s]?</)
    }
  })
})

// ── Regression (Part AE, AX) ──────────────────────────────────────────────────────

describe('16I: regression — ListingCard, /browse, /market untouched; cart domain untouched', () => {
  it('ListingCard.tsx still exists and still renders CatalogActions for its own callers', () => {
    expect(exists('src/components/store/ListingCard.tsx')).toBe(true)
    expect(listingCardSrc).toContain('CatalogActions')
  })

  it('/browse and /market still import and use ListingCard, unaffected by the new hub presentation', () => {
    expect(browseSrc).toContain('ListingCard')
    expect(marketSrc).toContain('ListingCard')
    expect(storeHomeSrc).toContain('ListingCard')
  })

  it('cart.ts and use-cart.ts were not modified — same addToCart dedupe-by-listingId logic', () => {
    expect(cartSrc).toContain('cart.some((i) => i.listingId === item.listingId)')
  })

  it('AddToCartButton.tsx source is unchanged from the 16H baseline (dedupe/pending-via-isInCart behavior preserved)', () => {
    expect(addToCartSrc).toContain('const inCart = isInCart(item.listingId)')
    expect(addToCartSrc).toContain("{inCart ? 'In Cart' : 'Add to Cart'}")
  })

  it('no new Prisma model/migration was introduced for 16I', () => {
    expect(exists('prisma/migrations')).toBe(true)
    // catalogModelHubQuery.ts remains the sole query module for this route
    expect(exists('src/lib/catalogListingOptionQuery.ts')).toBe(false)
  })

  it('no admin file references CatalogListingOption', () => {
    const adminDir = path.join(root, 'src/app/(admin)')
    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    }
    const adminFiles = walk(adminDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    for (const f of adminFiles) {
      expect(fs.readFileSync(f, 'utf-8')).not.toMatch(/CatalogListingOption/)
    }
  })
})

// ── Zero / one / multiple Listing behavior (Part AP, AQ, AR) ───────────────────

describe('16I: zero-Listing behavior unchanged from 16H', () => {
  it('empty state renders "No copies currently available." with no listing-option shell and no fake disabled Buy', () => {
    expect(hubSrc).toContain('No copies currently available.')
    expect(hubSrc).not.toMatch(/disabled.*Add to Cart|Add to Cart.*disabled/)
  })

  it('the <ul> of options only renders inside the hasListings branch', () => {
    const listBlockStart = hubSrc.indexOf('{hasListings ? (')
    const listBlockEnd = hubSrc.indexOf(') : (', listBlockStart)
    const listBlock = hubSrc.slice(listBlockStart, listBlockEnd)
    expect(listBlock).toContain('<ul')
    expect(listBlock).toContain('CatalogListingOption')
  })
})

describe('16I: one-Listing and multiple-Listing rendering', () => {
  it('the map has no index-based early return/limit — every eligible Listing on the page gets its own option', () => {
    expect(hubSrc).not.toMatch(/index === 0|\.slice\(0,\s*1\)/)
  })

  it('CatalogListingOption receives index for accessible per-copy distinction, not for filtering', () => {
    expect(hubSrc).toContain('index={index}')
  })
})
