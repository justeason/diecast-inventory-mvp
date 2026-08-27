/**
 * 16H: CatalogModel customer hub (/catalog/[id]) — the first customer-facing route
 * keyed by CatalogModel.id rather than Listing.id. Structural/source checks plus
 * behavioral tests for the new query layer. No real DB, no real network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findUnique: vi.fn() },
    listing: { count: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getCatalogModelHub, LISTING_PAGE_SIZE } from '@/lib/catalogModelHubQuery'

beforeEach(() => vi.resetAllMocks())

const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
const hubCode = stripComments(hubSrc)
const queryModuleSrc = readSrc('src/lib/catalogModelHubQuery.ts')
const actionsRowSrc = readSrc('src/components/store/CatalogModelActions.tsx')
const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
const collectionSrc = readSrc('src/app/(store)/account/collection/page.tsx')
const wantedSrc = readSrc('src/app/(store)/account/wanted/page.tsx')
const listingCardSrc = readSrc('src/components/store/ListingCard.tsx')
const catalogActionsSrc = readSrc('src/components/store/CatalogActions.tsx')

// ── Route architecture (Part A/B) ───────────────────────────────────────────────

describe('16H: canonical route, and /browse/[id] semantics confirmed', () => {
  it('the canonical CatalogModel hub route exists at /catalog/[id]', () => {
    expect(exists('src/app/(store)/catalog/[id]/page.tsx')).toBe(true)
  })

  it('/browse/[id] is keyed by Listing.id (a physical item detail page), not CatalogModel.id — confirmed by its own prisma.listing.findUnique lookup', () => {
    const src = readSrc('src/app/(store)/browse/[id]/page.tsx')
    expect(src).toContain('prisma.listing.findUnique')
    expect(src).not.toContain('prisma.catalogModel.findUnique')
  })

  it('no second/alias CatalogModel route was created', () => {
    expect(exists('src/app/(store)/model')).toBe(false)
    expect(exists('src/app/(store)/models')).toBe(false)
  })
})

// ── getCatalogModelHub (behavioral) ─────────────────────────────────────────────

describe('getCatalogModelHub: model identity, zero-listing support, exact totals', () => {
  it('returns null (never throws) for an unknown CatalogModel id — page.tsx maps this to notFound()', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(null)
    const result = await getCatalogModelHub('does-not-exist')
    expect(result).toBeNull()
    expect(prisma.listing.count).not.toHaveBeenCalled() // no wasted Listing query for a model that doesn't exist
  })

  it('a model with zero eligible Listings still resolves fully — identity, exact zero count, null lowest price, empty list', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({
      id: 'cat1', brand: 'Hot Wheels', name: 'Porsche 911 GT3', year: 2024, series: 'Motorsport', color: 'White', scale: '1:64', photos: [],
    })
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.aggregate as Mock).mockResolvedValue({ _min: { price: null } })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await getCatalogModelHub('cat1')
    expect(result).not.toBeNull()
    expect(result!.model.brand).toBe('Hot Wheels')
    expect(result!.listingCount).toBe(0)
    expect(result!.lowestPrice).toBeNull()
    expect(result!.listings).toEqual([])
    expect(result!.nextCursor).toBeNull()
  })

  it('the eligible-Listing predicate matches /browse\'s own base predicate exactly: status active + item.status available, scoped to this model', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1', brand: 'B', name: 'N', year: null, series: null, color: null, scale: null, photos: [] })
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.aggregate as Mock).mockResolvedValue({ _min: { price: null } })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    await getCatalogModelHub('cat1')

    const countCall = (prisma.listing.count as Mock).mock.calls[0][0]
    expect(countCall.where).toEqual({ status: 'active', item: { status: 'available', catalogId: 'cat1' } })
  })

  it('listingCount is an exact dedicated count() — never items.length from the bounded findMany', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1', brand: 'B', name: 'N', year: null, series: null, color: null, scale: null, photos: [] })
    ;(prisma.listing.count as Mock).mockResolvedValue(137) // far more than one page
    ;(prisma.listing.aggregate as Mock).mockResolvedValue({ _min: { price: 5 } })
    ;(prisma.listing.findMany as Mock).mockResolvedValue(
      Array.from({ length: LISTING_PAGE_SIZE + 1 }, (_, i) => ({ id: `L${i}`, title: 't', price: 5 + i, item: { sku: 's', cardedOrLoose: 'loose', condition: 'mint', catalog: { id: 'cat1', brand: 'B', name: 'N', year: null, series: null, color: null }, photos: [] } })),
    )

    const result = await getCatalogModelHub('cat1')
    expect(result!.listingCount).toBe(137)
    expect(result!.listings.length).toBe(LISTING_PAGE_SIZE) // bounded page, but the COUNT is still exact
    expect(result!.nextCursor).not.toBeNull()
  })

  it('lowestPrice comes from a dedicated min-price aggregate — never inferred by re-sorting the bounded/paginated list', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1', brand: 'B', name: 'N', year: null, series: null, color: null, scale: null, photos: [] })
    ;(prisma.listing.count as Mock).mockResolvedValue(1)
    ;(prisma.listing.aggregate as Mock).mockResolvedValue({ _min: { price: 4.5 } })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await getCatalogModelHub('cat1')
    expect(result!.lowestPrice).toBe(4.5)
    const aggCall = (prisma.listing.aggregate as Mock).mock.calls[0][0]
    expect(aggCall._min).toEqual({ price: true })
  })

  it('cursor pagination uses the established id-keyset pattern (skip:1, cursor:{id})', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1', brand: 'B', name: 'N', year: null, series: null, color: null, scale: null, photos: [] })
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.aggregate as Mock).mockResolvedValue({ _min: { price: null } })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    await getCatalogModelHub('cat1', 'L23')

    const findManyCall = (prisma.listing.findMany as Mock).mock.calls[0][0]
    expect(findManyCall.skip).toBe(1)
    expect(findManyCall.cursor).toEqual({ id: 'L23' })
    expect(findManyCall.take).toBe(LISTING_PAGE_SIZE + 1)
  })

  it('performs no mutation (create/update/delete/upsert)', () => {
    expect(queryModuleSrc).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('never calls matchWantedList or a relationship/valuation query — this module is Listing-eligibility only', () => {
    expect(queryModuleSrc).not.toMatch(/matchWantedList|getCatalogRelationshipState|getCatalogValuation/)
  })
})

// ── Page structure (Part AD, AH, AR, AS) ────────────────────────────────────────

describe('16H: hub page structure, 404, read-only render, privacy', () => {
  it('calls notFound() when getCatalogModelHub returns null', () => {
    expect(hubCode).toContain('if (!hub) notFound()')
  })

  it('performs no mutation during render', () => {
    expect(hubCode).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('no buyer/seller PII field is selected or rendered', () => {
    expect(hubSrc).not.toMatch(/\.email\b|\.phone\b|\.address\b|paymentMethod|paymentReference/)
    expect(queryModuleSrc).not.toMatch(/\.email\b|\.phone\b|\.address\b/)
  })

  it('has exactly one h1 with the model name, and a heading for the Listings section', () => {
    expect(hubSrc.match(/<h1/g)?.length).toBe(1)
    expect(hubSrc).toContain('Available Copies')
  })
})

// ── Model identity (Part D) ──────────────────────────────────────────────────────

describe('16H: model identity is authoritative CatalogModel data, never query-string trust', () => {
  it('generateMetadata re-fetches CatalogModel server-side by the route param id', () => {
    expect(hubSrc).toContain('prisma.catalogModel.findUnique({')
    expect(hubSrc).toContain('where: { id },')
  })

  it('identity fields (brand/name/year/series/color/scale) come from hub.model, never from searchParams', () => {
    expect(hubCode).toContain('hub.model.brand')
    expect(hubCode).toContain('hub.model.name')
    expect(hubCode).not.toMatch(/searchParams\.(brand|name|year|series|color|scale)/)
  })

  it('unknown optional fields are conditionally omitted, never rendered as fake defaults', () => {
    expect(hubSrc).toContain('{hub.model.series &&')
  })

  it('the raw CatalogModel id is used only as a route param/href target, never displayed as customer-facing label text', () => {
    expect(hubCode).not.toMatch(/>{hub\.model\.id}</)
    expect(hubCode).not.toMatch(/>{id}</)
  })
})

// ── Relationship actions reuse (Part E, F, G, AN) ───────────────────────────────

describe('16H: CatalogModelActions reuses the exact 16F/16G authoritative actions — no second engine', () => {
  it('imports wantAction/unwantAction/addToCollectionAction from CatalogActions.tsx rather than reimplementing them', () => {
    expect(actionsRowSrc).toContain("import { wantAction, unwantAction, addToCollectionAction } from './CatalogActions'")
  })

  it('those three actions are exported from CatalogActions.tsx — bodies live in a dedicated module-level "use server" file (catalogModelDomainActions.ts, 16L, required so a Client Component can invoke them directly), re-exported unchanged, never duplicated', () => {
    expect(catalogActionsSrc).toContain("export { wantAction, unwantAction, addToCollectionAction }")
    const domainActionsSrc = readSrc('src/lib/actions/catalogModelDomainActions.ts')
    expect(domainActionsSrc).toContain('export async function wantAction')
    expect(domainActionsSrc).toContain('export async function unwantAction')
    expect(domainActionsSrc).toContain('export async function addToCollectionAction')
  })

  it('CatalogModelActions has no Prisma import and no matchWantedList — it is presentation only', () => {
    expect(actionsRowSrc).not.toMatch(/from '@\/lib\/prisma'|matchWantedList/)
  })

  it('does not use the 16G popup/tray — always-visible row, per Part AN (a full page has room, unlike a dense grid card)', () => {
    expect(actionsRowSrc).not.toContain('CatalogActionsPopup')
    expect(actionsRowSrc).not.toContain('hidden md:flex')
  })

  it('ownership is never a destructive toggle — the owned state renders a Link to Collection detail, never a delete form', () => {
    const idx = actionsRowSrc.indexOf('✓ Own')
    const blockStart = actionsRowSrc.lastIndexOf('collectionItemId ? (', idx)
    const block = actionsRowSrc.slice(blockStart, idx + 40)
    expect(block).toContain('<Link')
    expect(block).not.toContain('<form')
    expect(block).not.toContain('deleteCollectionItem')
  })

  it('owned quantity comes from relationship.ownedQuantity (CollectionItem.quantity), never a row count', () => {
    expect(actionsRowSrc).toContain('ownedQuantity !== null ? ` ${ownedQuantity}` : \'\'')
  })

  it('Sell One routes to /account/collection/[id]/sell when owned, or /account/sell/new?catalogId=... when not — same as 16F', () => {
    expect(actionsRowSrc).toContain('/account/collection/${collectionItemId}/sell')
    expect(actionsRowSrc).toContain('/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}')
  })

  it('every action carries a model-scoped accessible label', () => {
    expect(actionsRowSrc).toContain('ariaLabel={`Want ${modelName}`}')
    expect(actionsRowSrc).toContain('ariaLabel={`Remove ${modelName} from Wanted`}')
    expect(actionsRowSrc).toContain('ariaLabel={`Add ${modelName} to Collection`}')
    expect(actionsRowSrc).toContain('aria-label={`View owned ${modelName}`}')
    expect(actionsRowSrc).toContain('aria-label={`Sell one ${modelName}`}')
  })
})

// ── Want works with zero Listings (Part F/6) ────────────────────────────────────

describe('16H: Want/Collection/Sell all work even when hub.listings is empty', () => {
  it('CatalogModelActions is rendered unconditionally, not gated behind hasListings/hub.listings.length', () => {
    const idx = hubSrc.indexOf('<CatalogModelActions')
    const before = hubSrc.slice(Math.max(0, idx - 120), idx)
    expect(before).not.toMatch(/hasListings\s*&&\s*$/)
    expect(before).not.toMatch(/listings\.length\s*>\s*0\s*&&\s*$/)
  })

  it('no matchWantedList call anywhere in the hub page or its query module — Wanted state is a plain existence check', () => {
    expect(hubCode).not.toMatch(/matchWantedList/)
    expect(queryModuleSrc).not.toMatch(/matchWantedList/)
  })
})

// ── Eligible Listings / Buy / no auto-selection (Part I, J, K, AK) ──────────────

describe('16H: Available Listings — real physical choices, Buy stays Listing-specific', () => {
  // 16I Part B deliberately replaces the ListingCard-reuse presentation with a
  // dedicated CatalogListingOption component (one physical-copy comparison row) —
  // see catalogListingOption.test.ts for full coverage of that architecture. The
  // "no forked Buy implementation" / "no auto-selection" invariants this block
  // used to assert against ListingCard now live there against CatalogListingOption.
  it('no arbitrary cheapest-Listing auto-selection — the hub never picks one Listing out of the array to feature/cart', () => {
    expect(hubCode).not.toMatch(/listings\[0\]/)
    expect(hubCode).not.toMatch(/\.sort\(/)
  })

  it('CatalogModel price is never used as a cart item — cartItem construction lives only inside CatalogListingOption, keyed by each Listing\'s own id/price', () => {
    expect(hubSrc).not.toContain('cartItem')
  })
})

// ── No-listings truthful empty state (Part L) ───────────────────────────────────

describe('16H: truthful zero-Listing empty state', () => {
  it('shows "No copies currently available." without implying inventory exists', () => {
    expect(hubSrc).toContain('No copies currently available.')
  })

  it('does not overpromise notification behavior beyond existing alert semantics', () => {
    expect(hubSrc).not.toMatch(/we'll notify you/i)
  })

  it('the "Want this model" nudge only shows when authenticated and not already wanted', () => {
    expect(hubSrc).toContain('{session && !relationship?.wanted && (')
  })
})

// ── Valuation (Part N, O) ────────────────────────────────────────────────────────

describe('16H: valuation is truthful, single model-level call, never $0 for unknown', () => {
  it('calls getCatalogValuation exactly once (14C, already batched — no per-Listing valuation)', () => {
    const matches = [...hubSrc.matchAll(/getCatalogValuation\(/g)]
    expect(matches.length).toBe(1)
  })

  it('unknown/insufficient valuation renders a truthful label, never a fabricated $0', () => {
    expect(hubSrc).toContain("'Not enough sales data yet'")
    expect(hubSrc).not.toMatch(/estimatedValue\s*\?\?\s*0/)
  })

  it('uses the exact existing centsToDisplay-equivalent cents-based formatting (integer cents / 100, .toFixed(2)) — no JS float accumulation', () => {
    expect(hubSrc).toContain('function centsToDisplay(cents: number): string')
    expect(hubSrc).toContain('(cents / 100).toFixed(2)')
  })

  it('confidence label reuses the existing AdvancedConfidence type/terminology, not invented wording', () => {
    expect(hubSrc).toContain("import type { AdvancedConfidence } from '@/lib/advancedValuation'")
  })
})

describe('16H: market history / community context deliberately omitted (no infra exists)', () => {
  it('no external-market-research or community-aggregate calls were added to the hub', () => {
    expect(hubSrc).not.toMatch(/getExternalMarketSummar|communityLeaderboards/)
  })

  it('no per-model public "N people want/own this" aggregate was introduced', () => {
    expect(hubSrc).not.toMatch(/people want this|people own this|collectors own/i)
  })
})

// ── Linkage (Part U, V, W) ───────────────────────────────────────────────────────

describe('16H: existing customer surfaces link to the canonical hub', () => {
  it('ListingCard adds a "View Model" link to /catalog/[catalogModelId], only when catalogModelId is present — Buy is unaffected', () => {
    expect(listingCardSrc).toContain('href={`/catalog/${catalogModelId}`}')
    expect(listingCardSrc).toContain('View Model')
  })

  it('/browse itself was not restructured from Listing-centric to model-centric — still one card per Listing', () => {
    expect(browseSrc).toContain('prisma.listing.findMany({')
  })

  it('Collection\'s "View Market" now links to the canonical hub using the item\'s own catalogId, replacing the old /browse?brand=&q= guess', () => {
    expect(collectionSrc).toContain('href={`/catalog/${item.catalogId}`}')
    expect(collectionSrc).not.toContain('/browse?brand=')
  })

  it('freeform (catalogId=null) CollectionItems still get no View Market link — no fabricated CatalogModel identity', () => {
    expect(collectionSrc).toContain('{item.catalogId && (')
  })

  it('Wanted model identity now links to the canonical hub', () => {
    expect(wantedSrc).toContain('href={`/catalog/${entry.catalog.id}`}')
  })

  it('the canonical /account/wanted page itself was not removed or replaced', () => {
    expect(exists('src/app/(store)/account/wanted/page.tsx')).toBe(true)
  })
})

// ── Anonymous / authenticated relationship query (Part Z, AA, AB) ──────────────

describe('16H: anonymous is public with no private query; authenticated relationship is one narrow lookup', () => {
  it('the hub never gates rendering behind a session check — no notFound()/redirect for anonymous visitors', () => {
    expect(hubCode).not.toMatch(/if \(!session\)\s*(notFound|redirect)/)
  })

  it('getCatalogRelationshipState is only called when session exists, and only for this one model id', () => {
    expect(hubCode).toMatch(/session\s*\?\s*await getCatalogRelationshipState\(session\.profileId,\s*\[id\]\)\s*:\s*null/)
  })

  it('reuses the exact 16F relationship query — no second Wanted/Collection engine', () => {
    expect(hubSrc).toContain("import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'")
  })
})

// ── Revalidation (Part AI) ───────────────────────────────────────────────────────

describe('16H: Want/Unwant revalidate the hub path narrowly, without broadening shared domain actions', () => {
  // 16L: bodies live in catalogModelDomainActions.ts now — same behavior, moved file.
  const domainActionsSrc = readSrc('src/lib/actions/catalogModelDomainActions.ts')

  it('wantAction/unwantAction now revalidate both /browse and this specific model\'s hub path', () => {
    const wantFnIdx = domainActionsSrc.indexOf('export async function wantAction')
    const wantFnSrc = domainActionsSrc.slice(wantFnIdx, domainActionsSrc.indexOf('\n}', wantFnIdx))
    expect(wantFnSrc).toContain("revalidatePath('/browse')")
    expect(wantFnSrc).toContain('revalidatePath(`/catalog/${catalogModelId}`)')

    const unwantFnIdx = domainActionsSrc.indexOf('export async function unwantAction')
    const unwantFnSrc = domainActionsSrc.slice(unwantFnIdx, domainActionsSrc.indexOf('\n}', unwantFnIdx))
    expect(unwantFnSrc).toContain("revalidatePath('/browse')")
    expect(unwantFnSrc).toContain('revalidatePath(`/catalog/${catalogModelId}`)')
  })

  it('unwantAction now takes catalogModelId as an explicit param (needed to build the hub path) — the shared removeFromWantedList itself is unchanged', () => {
    expect(domainActionsSrc).toContain('export async function unwantAction(catalogModelId: string, wantedId: string): Promise<void>')
    const wantedListSrc = readSrc('src/lib/actions/wantedList.ts')
    expect(wantedListSrc).toContain('export async function removeFromWantedList(id: string): Promise<void>')
  })

  it('/account/wanted and /account still get their own existing revalidation, unchanged', () => {
    const wantedListSrc = readSrc('src/lib/actions/wantedList.ts')
    expect(wantedListSrc).toContain("revalidatePath('/account/wanted')")
  })
})

// ── Performance (Part S, AL, BA) ─────────────────────────────────────────────────

describe('16H: query architecture — bounded, model-scoped, no N+1', () => {
  it('getCatalogModelHub issues exactly 3 queries: one model lookup + one count + one aggregate + one bounded findMany, all in parallel where independent', () => {
    expect(queryModuleSrc).toContain('await Promise.all([')
    const promiseAllIdx = queryModuleSrc.indexOf('await Promise.all([')
    const block = queryModuleSrc.slice(promiseAllIdx, queryModuleSrc.indexOf('])', promiseAllIdx))
    expect(block).toContain('prisma.listing.count(')
    expect(block).toContain('prisma.listing.aggregate(')
    expect(block).toContain('prisma.listing.findMany(')
  })

  it('no full Wanted/Collection scan, no per-Listing relationship or valuation query, in either the page or the query module', () => {
    for (const src of [hubCode, queryModuleSrc]) {
      expect(src).not.toMatch(/wantedCatalogModel\.findMany\(\{\s*\}\)|collectionItem\.findMany\(\{\s*\}\)/)
    }
  })

  it('the hub page calls the relationship query and the valuation query each exactly once, never inside the Listings map/loop', () => {
    const listingsMapIdx = hubSrc.indexOf('hub.listings.map(')
    const afterMap = hubSrc.slice(listingsMapIdx, hubSrc.indexOf('})', listingsMapIdx))
    expect(afterMap).not.toMatch(/getCatalogRelationshipState|getCatalogValuation/)
  })
})

// ── Accessibility (Part AQ) ───────────────────────────────────────────────────────

describe('16H: accessibility', () => {
  it('images use meaningful alt text derived from the model name, not empty/decorative alone for the primary photo', () => {
    expect(hubSrc).toContain('alt={modelName}')
  })

  it('no color-only availability state — the empty state and listing count are always text', () => {
    expect(hubSrc).toContain('No copies currently available.')
    expect(hubSrc).toContain('available')
  })

  it('back navigation uses a real semantic link', () => {
    expect(hubSrc).toContain('<Link href="/browse"')
  })
})

// ── Regression (Part BD) ─────────────────────────────────────────────────────────

describe('16H: regression — nothing else moved', () => {
  it('/browse, /market, and account routes still exist', () => {
    expect(exists('src/app/(store)/browse/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/market/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/collection/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/wanted/page.tsx')).toBe(true)
  })

  it('/market\'s ListingCard call sites still pass neither catalogModelId nor relationship — untouched by 16H', () => {
    const marketSrc = readSrc('src/app/(store)/market/page.tsx')
    const calls = [...marketSrc.matchAll(/<ListingCard[\s\S]*?\/>/g)]
    for (const call of calls) {
      expect(call[0]).not.toContain('catalogModelId')
      expect(call[0]).not.toContain('relationship')
    }
  })

  it('no admin file references the new hub route or query module', () => {
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
      expect(content).not.toMatch(/catalogModelHubQuery|CatalogModelActions/)
    }
  })
})
