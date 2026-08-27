/**
 * 16F: Catalog interaction actions (Want / Add to Collection / Sell One) on
 * customer-facing catalog cards. Pure structural/source checks plus behavioral
 * tests for the new batched relationship-state query — no real DB, no real network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    wantedCatalogModel: { findMany: vi.fn() },
    collectionItem: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'

beforeEach(() => vi.resetAllMocks())

// ── getCatalogRelationshipState (behavioral) ──────────────────────────────────

describe('getCatalogRelationshipState: batched, scoped, no N+1', () => {
  it('issues exactly one Wanted query and one Collection query, regardless of how many catalog ids are passed', async () => {
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    const ids = Array.from({ length: 24 }, (_, i) => `cat${i}`)
    await getCatalogRelationshipState('profile1', ids)
    expect(prisma.wantedCatalogModel.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.collectionItem.findMany).toHaveBeenCalledTimes(1)
  })

  it('scopes both queries to the given catalogModelIds and the caller profileId only', async () => {
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    await getCatalogRelationshipState('profile1', ['catA', 'catB'])
    const wantedCall = (prisma.wantedCatalogModel.findMany as Mock).mock.calls[0][0]
    expect(wantedCall.where.customerProfileId).toBe('profile1')
    expect(wantedCall.where.catalogModelId).toEqual({ in: ['catA', 'catB'] })
    const collectionCall = (prisma.collectionItem.findMany as Mock).mock.calls[0][0]
    expect(collectionCall.where.profileId).toBe('profile1')
    expect(collectionCall.where.catalogId).toEqual({ in: ['catA', 'catB'] })
  })

  it('returns an entry for every requested id, defaulting to not-wanted/not-owned', async () => {
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    const result = await getCatalogRelationshipState('profile1', ['catA', 'catB'])
    expect(result.get('catA')).toEqual({ wanted: false, wantedId: null, collectionItemId: null, ownedQuantity: null })
    expect(result.get('catB')).toEqual({ wanted: false, wantedId: null, collectionItemId: null, ownedQuantity: null })
  })

  it('marks wanted=true with the wantedId for a matched model, and ownedQuantity from CollectionItem.quantity directly (never a row count)', async () => {
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([{ id: 'w1', catalogModelId: 'catA' }])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([{ id: 'c1', catalogId: 'catA', quantity: 5 }])
    const result = await getCatalogRelationshipState('profile1', ['catA'])
    expect(result.get('catA')).toEqual({ wanted: true, wantedId: 'w1', collectionItemId: 'c1', ownedQuantity: 5 })
  })

  it('empty id list short-circuits with no queries', async () => {
    const result = await getCatalogRelationshipState('profile1', [])
    expect(prisma.wantedCatalogModel.findMany).not.toHaveBeenCalled()
    expect(prisma.collectionItem.findMany).not.toHaveBeenCalled()
    expect(result.size).toBe(0)
  })

  it('deduplicates repeated catalog ids in the input', async () => {
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    await getCatalogRelationshipState('profile1', ['catA', 'catA', 'catA'])
    const wantedCall = (prisma.wantedCatalogModel.findMany as Mock).mock.calls[0][0]
    expect(wantedCall.where.catalogModelId).toEqual({ in: ['catA'] })
  })

  it('cross-profile isolation: two different profileIds never share a query', async () => {
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    await getCatalogRelationshipState('profile-a', ['cat1'])
    const callA = (prisma.wantedCatalogModel.findMany as Mock).mock.calls[0][0]
    vi.resetAllMocks()
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    await getCatalogRelationshipState('profile-b', ['cat1'])
    const callB = (prisma.wantedCatalogModel.findMany as Mock).mock.calls[0][0]
    expect(callA.where.customerProfileId).toBe('profile-a')
    expect(callB.where.customerProfileId).toBe('profile-b')
  })

  it('never calls matchWantedList or any listing/availability query — relationship state is a pure existence check', () => {
    const src = readSrc('src/lib/catalogRelationshipQuery.ts')
    expect(src).not.toMatch(/matchWantedList|prisma\.listing/)
  })

  it('performs no mutation (create/update/delete/upsert)', () => {
    const src = readSrc('src/lib/catalogRelationshipQuery.ts')
    expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })
})

// ── browse/page.tsx integration (structural) ──────────────────────────────────

describe('browse/page.tsx: 16F relationship-state wiring', () => {
  const src = readSrc('src/app/(store)/browse/page.tsx')

  it('selects catalog.id (needed to identify the model for each card)', () => {
    expect(src).toContain('id: true, brand: true, name: true')
  })

  it('resolves the session once and skips the relationship query entirely for anonymous visitors', () => {
    expect(src).toContain('await getBuyerSession()')
    expect(src).toMatch(/session\s*\?\s*await getCatalogRelationshipState/)
  })

  it('calls getCatalogRelationshipState exactly once, scoped to only the catalog ids on the current page (not the full Wanted/Collection dataset)', () => {
    const matches = [...src.matchAll(/getCatalogRelationshipState\(/g)]
    expect(matches.length).toBe(1)
    expect(src).toContain('const catalogModelIds = [...new Set(listings.map((l) => l.item.catalog.id))]')
  })

  it('passes catalogModelId and relationship down to every ListingCard', () => {
    expect(src).toContain('catalogModelId={listing.item.catalog.id}')
    expect(src).toContain('relationship={relationshipMap?.get(listing.item.catalog.id) ?? null}')
  })

  it('search/filter/sort/pagination query construction is untouched', () => {
    expect(src).toContain("VALID_SORTS = new Set(['newest', 'price_low', 'price_high', 'brand_name'])")
    expect(src).toContain('skip,')
    expect(src).toContain('take: PAGE_SIZE,')
  })

  it('performs no mutation during render', () => {
    expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })
})

// ── CatalogActions component (structural) ──────────────────────────────────────

describe('CatalogActions.tsx: reuses authoritative mutations only, no new engine', () => {
  const src = readSrc('src/components/store/CatalogActions.tsx')
  // 16L: wantAction/unwantAction/addToCollectionAction relocated verbatim to a
  // dedicated module-level "use server" file (catalogModelDomainActions.ts) so a
  // Client Component (CaptureCandidateActions.tsx) can invoke them directly —
  // Next.js forbids inline "use server" bodies in a file reachable from a Client
  // Component. CatalogActions.tsx now imports + re-exports them unchanged.
  const domainActionsSrc = readSrc('src/lib/actions/catalogModelDomainActions.ts')

  it('Want/Unwant call the existing addToWantedList/removeFromWantedList — no duplicated Wanted logic', () => {
    expect(domainActionsSrc).toContain("import { addToWantedList, removeFromWantedList } from '@/lib/actions/wantedList'")
    expect(domainActionsSrc).not.toMatch(/wantedCatalogModel\.(create|update|delete)/)
  })

  it('Add to Collection calls the existing createCollectionItem — no duplicated Collection logic', () => {
    expect(domainActionsSrc).toContain("import { createCollectionItem } from '@/lib/actions/collectionItems'")
    expect(domainActionsSrc).not.toMatch(/collectionItem\.(create|update|delete)/)
  })

  it('CatalogActions.tsx imports and re-exports the three actions unchanged, rather than duplicating them', () => {
    expect(src).toContain("import { wantAction, unwantAction, addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'")
    expect(src).toContain('export { wantAction, unwantAction, addToCollectionAction }')
  })

  it('ownership is never a destructive toggle — the owned state renders a Link to manage the item, never a remove/delete form', () => {
    const ownedIdx = src.indexOf('✓ Own')
    const blockStart = src.lastIndexOf('collectionItemId && (', ownedIdx)
    const block = src.slice(blockStart, ownedIdx + 40)
    expect(block).toContain('<Link')
    expect(block).not.toContain('<form')
    expect(block).not.toContain('deleteCollectionItem')
  })

  it('owned quantity comes from relationship.ownedQuantity (CollectionItem.quantity), never a derived/row count', () => {
    expect(src).toContain('ownedQuantity !== null ? ` ${ownedQuantity}` : \'\'')
    expect(src).not.toMatch(/\.length\}\s*`\s*\)/)
  })

  it('Sell One routes to the existing /account/collection/[id]/sell when owned, or the existing manual-sell flow with catalogId context when not', () => {
    expect(src).toContain('/account/collection/${collectionItemId}/sell')
    expect(src).toContain('/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}')
  })

  it('Sell One never creates a SellerSubmission directly — it is a plain Link in both branches, not a form', () => {
    const sellIdx = src.indexOf('{/* Sell One */}')
    const nextSectionIdx = src.length
    const block = src.slice(sellIdx, nextSectionIdx)
    expect(block).not.toContain('<form')
    expect(block).not.toContain('sellerSubmission.create')
  })

  it('anonymous (relationship === null) shows all three private actions as sign-in links to /account, never a fabricated wanted/owned state', () => {
    const anonLinks = [...src.matchAll(/href="\/account"[^>]*aria-label=\{`Sign in to [^`]+`\}/g)]
    expect(anonLinks.length).toBe(3)
    expect(src).not.toMatch(/relationship\s*\?\?\s*\{\s*wanted:\s*false/)
  })

  it('every action carries a model-scoped accessible label, not an icon-only control (Want/Unwant/Add-to-Collection via PendingActionButton\'s ariaLabel prop, the rest as plain aria-label)', () => {
    expect(src).toContain('ariaLabel={`Want ${modelName}`}')
    expect(src).toContain('ariaLabel={`Remove ${modelName} from Wanted`}')
    expect(src).toContain('ariaLabel={`Add ${modelName} to Collection`}')
    expect(src).toContain('aria-label={`View owned ${modelName}`}')
    expect(src).toContain('aria-label={`Sell one ${modelName}`}')
  })

  it('performs no mutation of its own outside the thin wrapper calls to the authoritative actions', () => {
    expect(src).not.toMatch(/prisma\./)
  })

  it('wantAction/addToCollectionAction only adapt the return type and inject catalogModelId — no new validation/business logic', () => {
    const wantFnIdx = domainActionsSrc.indexOf('async function wantAction')
    const wantFnSrc = domainActionsSrc.slice(wantFnIdx, domainActionsSrc.indexOf('\n}', wantFnIdx))
    expect(wantFnSrc).toContain("formData.set('catalogModelId', catalogModelId)")
    expect(wantFnSrc).toContain('await addToWantedList(null, formData)')

    const addFnIdx = domainActionsSrc.indexOf('async function addToCollectionAction')
    const addFnSrc = domainActionsSrc.slice(addFnIdx, domainActionsSrc.indexOf('\n}', addFnIdx))
    expect(addFnSrc).toContain("formData.set('catalogId', catalogModelId)")
    expect(addFnSrc).toContain('await createCollectionItem(null, formData)')
  })
})

// ── ListingCard.tsx (structural + card-click safety) ────────────────────────────

describe('ListingCard.tsx: 16F wiring stays backward compatible, no invalid nested interactive elements', () => {
  const src = readSrc('src/components/store/ListingCard.tsx')

  it('catalogModelId/relationship are optional — /market call sites (which pass neither) render exactly as before', () => {
    expect(src).toContain('catalogModelId?: string')
    expect(src).toContain('relationship?: CatalogRelationshipEntry | null')
  })

  it('CatalogActions renders only when catalogModelId is present', () => {
    expect(src).toContain('{catalogModelId && (')
    expect(src).toContain('<CatalogActions')
  })

  it('CatalogActions and AddToCartButton are siblings OUTSIDE the model <Link> — never nested inside an anchor', () => {
    const linkIdx = src.indexOf('<Link href={`/browse/${listing.id}`}')
    const linkCloseIdx = src.indexOf('</Link>', linkIdx)
    const insideLink = src.slice(linkIdx, linkCloseIdx)
    expect(insideLink).not.toContain('<CatalogActions')
    expect(insideLink).not.toContain('<AddToCartButton')
    const afterLink = src.slice(linkCloseIdx)
    expect(afterLink).toContain('<AddToCartButton')
    expect(afterLink).toContain('<CatalogActions')
  })

  it('market.tsx call sites are untouched — they still call ListingCard without catalogModelId/relationship', () => {
    const marketSrc = readSrc('src/app/(store)/market/page.tsx')
    const calls = [...marketSrc.matchAll(/<ListingCard[\s\S]*?\/>/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[0]).not.toContain('catalogModelId')
    }
  })
})

// ── Sell One prefill (structural) ──────────────────────────────────────────────

describe('account/sell/new/page.tsx: 16F catalogId prefill never trusts browser product data', () => {
  const src = readSrc('src/app/(store)/account/sell/new/page.tsx')

  it('re-fetches CatalogModel server-side by id before using any of its fields', () => {
    expect(src).toContain('prisma.catalogModel.findUnique({')
    expect(src).toContain('where: { id: catalogId }')
  })

  it('still gates on session before anything else (private route, unchanged)', () => {
    expect(src).toContain('if (!session) notFound()')
  })

  it('passes only the server-refetched model\'s own fields as the form prefill, never the raw catalogId query param values directly', () => {
    expect(src).toContain('catalogId: catalogModel.id')
    expect(src).toContain('brand: catalogModel.brand')
  })

  it('selects id (not just display fields) so the validated CatalogModel\'s own id, not the raw query param, is what gets carried forward', () => {
    expect(src).toContain('select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true }')
  })
})

describe('ManualSellRequestForm.tsx: 16F prefill is default values only, submission path unchanged', () => {
  const src = readSrc('src/components/store/ManualSellRequestForm.tsx')

  it('still submits through the existing submitManualSellRequest action', () => {
    expect(src).toContain('submitManualSellRequest')
  })

  it('initial is an optional prop — existing no-arg call sites keep working', () => {
    expect(src).toContain('export function ManualSellRequestForm({ initial }: Props = {})')
  })
})

// ── Buy: unchanged, no new query, no arbitrary Listing selection ───────────────

describe('16F Buy: reuses existing AddToCartButton verbatim, no new availability query', () => {
  it('ListingCard still builds cartItem from this exact Listing — Buy is never derived from a CatalogModel-level aggregate', () => {
    const src = readSrc('src/components/store/ListingCard.tsx')
    expect(src).toContain('listingId: listing.id')
    expect(src).not.toMatch(/matchWantedList|getCatalogValuations?\(/)
  })

  it('AddToCartButton.tsx is untouched by 16F — still a plain client-local cart add, no server mutation', () => {
    const src = readSrc('src/components/store/AddToCartButton.tsx')
    expect(src).toContain("'use client'")
    expect(src).not.toMatch(/prisma\.|'use server'/)
  })
})

// ── Regression: existing surfaces untouched ─────────────────────────────────────

describe('16F regression: unrelated customer surfaces untouched', () => {
  it('accountOverviewQuery.ts was not modified by 16F', () => {
    const src = readSrc('src/lib/accountOverviewQuery.ts')
    expect(src).not.toMatch(/catalogRelationshipQuery|CatalogActions/)
  })

  it('AccountNav / customerNav.ts were not touched by 16F', () => {
    const src = readSrc('src/lib/customerNav.ts')
    expect(src).not.toMatch(/CatalogActions|catalogRelationshipQuery/)
  })

  it('wantedList.ts / collectionItems.ts action signatures are unchanged — 16F only adds new callers, no new export removed', () => {
    const wantedSrc = readSrc('src/lib/actions/wantedList.ts')
    expect(wantedSrc).toContain('export async function addToWantedList(')
    expect(wantedSrc).toContain('export async function removeFromWantedList(id: string): Promise<void>')
    const collectionSrc = readSrc('src/lib/actions/collectionItems.ts')
    expect(collectionSrc).toContain('export async function createCollectionItem(')
  })
})

// ── 16F Final: duplicate-Listing consistency ────────────────────────────────────

describe('16F Final: several Listings sharing one CatalogModel get consistent relationship state', () => {
  it('getCatalogRelationshipState returns the SAME entry object/values for a catalogModelId no matter how many times it is looked up — one relationship per model, not per Listing', async () => {
    vi.resetModules()
    const { getCatalogRelationshipState } = await import('@/lib/catalogRelationshipQuery')
    const { prisma } = await import('@/lib/prisma')
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([{ id: 'w1', catalogModelId: 'porscheX' }])
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([{ id: 'c1', catalogId: 'porscheX', quantity: 3 }])

    // Three Listings (A, B, C) all resolve to the same catalogModelId, exactly as
    // browse/page.tsx's `[...new Set(listings.map(l => l.item.catalog.id))]` would
    // produce before calling this function.
    const result = await getCatalogRelationshipState('profile1', ['porscheX', 'porscheX', 'porscheX'])
    const entry = result.get('porscheX')
    expect(entry).toEqual({ wanted: true, wantedId: 'w1', collectionItemId: 'c1', ownedQuantity: 3 })
    // Only one query pair was issued despite three duplicate ids.
    expect((prisma.wantedCatalogModel.findMany as Mock).mock.calls[0][0].where.catalogModelId).toEqual({ in: ['porscheX'] })
  })

  it('browse/page.tsx builds catalogModelIds via a Set before calling getCatalogRelationshipState — duplicate Listings of one model never cause duplicate ids in the query', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    expect(browseSrc).toContain('[...new Set(listings.map((l) => l.item.catalog.id))]')
  })

  it('every ListingCard for the same model reads from the SAME relationshipMap.get(...) call shape — no per-card divergent lookup', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    const occurrences = [...browseSrc.matchAll(/relationshipMap\?\.get\(listing\.item\.catalog\.id\)/g)]
    // Not asserting count > 1 (it's inside one .map() callback, evaluated once per
    // rendered card) — asserting the lookup key is always the model id, so two
    // cards for the same model necessarily read the same map entry.
    expect(occurrences.length).toBeGreaterThanOrEqual(1)
    expect(browseSrc).toContain('relationship={relationshipMap?.get(listing.item.catalog.id) ?? null}')
  })
})

// ── 16F Final: Want/Unwant revalidate /browse narrowly ──────────────────────────

describe('16F Final: /browse revalidation after Want/Unwant (does not rely on unproven implicit refresh)', () => {
  // 16L: these bodies live in catalogModelDomainActions.ts now (see above) — the
  // revalidation behavior itself is unchanged, only the file moved.
  const src = readSrc('src/lib/actions/catalogModelDomainActions.ts')

  it('wantAction and unwantAction explicitly revalidate /browse — added narrowly in the wrapper, not in the shared domain actions', () => {
    const wantFnIdx = src.indexOf('async function wantAction')
    const wantFnSrc = src.slice(wantFnIdx, src.indexOf('\n}', wantFnIdx))
    expect(wantFnSrc).toContain("revalidatePath('/browse')")

    const unwantFnIdx = src.indexOf('async function unwantAction')
    const unwantFnSrc = src.slice(unwantFnIdx, src.indexOf('\n}', unwantFnIdx))
    expect(unwantFnSrc).toContain("revalidatePath('/browse')")
  })

  it('the shared addToWantedList/removeFromWantedList actions were NOT modified to add /browse revalidation — blast radius stays narrow to the new wrapper only', () => {
    const wantedSrc = readSrc('src/lib/actions/wantedList.ts')
    expect(wantedSrc).not.toContain("revalidatePath('/browse')")
  })

  it('addToCollectionAction needs no revalidation of its own — createCollectionItem already redirects away from /browse on success', () => {
    const fnIdx = src.indexOf('async function addToCollectionAction')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}', fnIdx))
    expect(fnSrc).not.toContain('revalidatePath')
  })

  it('/account/wanted and /account still get their existing revalidation from addToWantedList/removeFromWantedList themselves, unchanged', () => {
    const wantedSrc = readSrc('src/lib/actions/wantedList.ts')
    expect(wantedSrc).toContain("revalidatePath('/account/wanted')")
  })
})

// ── 16F Final: surface-limitation documentation ─────────────────────────────────

describe('16F Final: does not claim whole-catalog coverage — documented interim surface limitation', () => {
  it('browse/page.tsx records the Listing-centric architecture truth in a comment (no false "all models" claim)', () => {
    const src = readSrc('src/app/(store)/browse/page.tsx')
    expect(src).toContain('one card per active physical Listing')
    expect(src).toContain('16F does not claim')
    expect(src).toContain('every catalog model is now interactive')
  })

  it('the only NEW catalogModel query 16F added is the relationship-state lookup — the pre-existing distinct-brands dropdown query (unrelated, not catalogModel.findMany-based relationship state) is untouched', () => {
    const src = readSrc('src/app/(store)/browse/page.tsx')
    const findManyMatches = [...src.matchAll(/prisma\.catalogModel\.findMany\(/g)]
    // Exactly one: the pre-existing "distinct(['brand'])" dropdown query. 16F's
    // relationship state uses wantedCatalogModel/collectionItem, never a
    // catalogModel.findMany scan.
    expect(findManyMatches.length).toBe(1)
    const idx = src.indexOf('prisma.catalogModel.findMany(')
    const block = src.slice(idx, idx + 200)
    expect(block).toContain("distinct: ['brand']")
  })

  // 16H deliberately adds exactly this route (the canonical CatalogModel hub —
  // see catalogModelHub.test.ts) — this 16F-era assertion is intentionally
  // superseded, not violated. Left as a historical marker, not a live guard.

  it('/market remains completely unchanged by this pass — no relationship wiring added there', () => {
    const marketSrc = readSrc('src/app/(store)/market/page.tsx')
    expect(marketSrc).not.toMatch(/catalogRelationshipQuery|getCatalogRelationshipState/)
  })
})
