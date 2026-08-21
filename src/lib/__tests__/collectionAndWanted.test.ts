import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')

function src(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

// ── Schema ──────────────────────────────────────────────────────────────────

describe('Schema: CollectionItem.isPublic', () => {
  const schema = src('prisma/schema.prisma')

  it('has isPublic field with default false', () => {
    expect(schema).toContain('isPublic      Boolean   @default(false)')
  })
})

describe('Schema: WantedCatalogModel', () => {
  const schema = src('prisma/schema.prisma')

  it('model exists', () => {
    expect(schema).toContain('model WantedCatalogModel {')
  })

  it('has customerProfileId and catalogModelId', () => {
    expect(schema).toContain('customerProfileId        String')
    expect(schema).toContain('catalogModelId           String')
  })

  it('has unique constraint on (customerProfileId, catalogModelId)', () => {
    expect(schema).toContain('@@unique([customerProfileId, catalogModelId])')
  })

  it('has customerProfileId index', () => {
    expect(schema).toContain('@@index([customerProfileId])')
  })

  it('has maxDesiredPrice as Decimal with precision', () => {
    expect(schema).toMatch(/maxDesiredPrice\s+Decimal\?\s+@db\.Decimal\(10,\s*2\)/)
  })

  it('CustomerProfile has wantedList back-reference', () => {
    expect(schema).toContain('wantedList         WantedCatalogModel[]')
  })

  it('CatalogModel has wantedBy back-reference', () => {
    expect(schema).toContain('wantedBy             WantedCatalogModel[]')
  })
})

// ── Collection actions ───────────────────────────────────────────────────────

describe('collectionItems.ts: isPublic support', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('createCollectionItem reads isPublic from formData', () => {
    expect(src_).toContain("formData.get('isPublic') === 'on'")
  })

  it('createCollectionItem passes isPublic to create', () => {
    expect(src_).toContain('isPublic,')
  })

  it('updateCollectionItem passes isPublic to update', () => {
    const updateIdx = src_.indexOf('export async function updateCollectionItem')
    expect(src_.indexOf('isPublic,', updateIdx)).toBeGreaterThan(updateIdx)
  })
})

describe('collectionItems.ts: duplicate catalog detection', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('checks for existing item with same catalogId before creating', () => {
    expect(src_).toContain('findFirst({')
    expect(src_).toContain('catalogId: resolvedCatalogId')
  })

  it('returns duplicate error, does not auto-increment', () => {
    expect(src_).toContain('You already have this model in your collection')
    expect(src_).not.toContain('quantity: { increment:')
  })
})

describe('collectionItems.ts: quantity bounds', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('enforces upper bound of 999', () => {
    expect(src_).toContain('n <= 999')
  })

  it('enforces lower bound of 1', () => {
    expect(src_).toContain('n >= 1')
  })
})

describe('collectionItems.ts: toggleCollectionItemPublic', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('function exists', () => {
    expect(src_).toContain('export async function toggleCollectionItemPublic')
  })

  it('verifies ownership before toggling', () => {
    const fnIdx = src_.indexOf('export async function toggleCollectionItemPublic')
    const findIdx = src_.indexOf('findFirst', fnIdx)
    const profileIdx = src_.indexOf('profileId: session.profileId', findIdx)
    expect(profileIdx).toBeGreaterThan(findIdx)
  })

  it('does not toggle if session missing', () => {
    const fnIdx = src_.indexOf('export async function toggleCollectionItemPublic')
    expect(src_.indexOf("if (!session) return", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('calls updateTag(community-leaderboards) on toggle', () => {
    const fnIdx = src_.indexOf('export async function toggleCollectionItemPublic')
    expect(src_.indexOf("updateTag('community-leaderboards')", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('calls revalidatePath after toggle', () => {
    const fnIdx = src_.indexOf('export async function toggleCollectionItemPublic')
    expect(src_.indexOf('revalidatePath', fnIdx)).toBeGreaterThan(fnIdx)
  })
})

describe('collectionItems.ts: updateCollectionItem cache invalidation', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('calls updateTag(community-leaderboards) in updateCollectionItem', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    expect(src_.indexOf("updateTag('community-leaderboards')", fnIdx)).toBeGreaterThan(fnIdx)
  })
})

// ── WantedList action ────────────────────────────────────────────────────────

describe('wantedList.ts: addToWantedList — duplicate returns error', () => {
  const src_ = src('src/lib/actions/wantedList.ts')

  it("uses create (not upsert) so duplicates hit P2002", () => {
    expect(src_).toContain('wantedCatalogModel.create')
    expect(src_).not.toContain('wantedCatalogModel.upsert')
  })

  it('catches P2002 and returns duplicate error message', () => {
    expect(src_).toContain("e.code === 'P2002'")
    expect(src_).toContain('This model is already on your wanted list.')
  })

  it('does not silently update existing rows on duplicate', () => {
    expect(src_).not.toContain('update: { maxDesiredPrice')
  })
})

describe('wantedList.ts: addToWantedList', () => {
  const src_ = src('src/lib/actions/wantedList.ts')

  it("is a server action ('use server')", () => {
    expect(src_).toMatch(/^'use server'/)
  })

  it('requires auth', () => {
    const fnIdx = src_.indexOf('export async function addToWantedList')
    expect(src_.indexOf("if (!session)", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('returns error when catalogModelId is missing', () => {
    expect(src_).toContain('Select a catalog model.')
  })

  it('validates catalogModelId exists in DB', () => {
    expect(src_).toContain('prisma.catalogModel.findUnique')
  })

  it('rejects zero maxDesiredPrice', () => {
    expect(src_).toContain('n <= 0')
    expect(src_).toContain('Must be greater than 0.')
  })

  it('rejects negative maxDesiredPrice', () => {
    expect(src_).toContain('n <= 0')
  })

  it('validates control characters in notes', () => {
    expect(src_).toContain('Notes contain invalid characters.')
    expect(src_).toMatch(/\\x00-\\x1F\\x7F/)
  })

  it('validates notes max 500 chars', () => {
    expect(src_).toContain('500')
    expect(src_).toContain('Notes must be 500 characters or fewer.')
  })

  it('calls revalidatePath after add', () => {
    expect(src_).toContain("revalidatePath('/account/wanted')")
  })

  it('does not make auto-purchases', () => {
    expect(src_).not.toContain('orderItem')
    expect(src_).not.toContain('payment')
    expect(src_).not.toContain('buyerEmail')
  })
})

describe('wantedList.ts: updateWantedListEntry', () => {
  const src_ = src('src/lib/actions/wantedList.ts')

  it('function exists', () => {
    expect(src_).toContain('export async function updateWantedListEntry')
  })

  it('requires auth', () => {
    const fnIdx = src_.indexOf('export async function updateWantedListEntry')
    expect(src_.indexOf("if (!session)", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('verifies ownership (id + customerProfileId)', () => {
    const fnIdx = src_.indexOf('export async function updateWantedListEntry')
    const findIdx = src_.indexOf('findFirst', fnIdx)
    const ownerIdx = src_.indexOf('customerProfileId: session.profileId', findIdx)
    expect(ownerIdx).toBeGreaterThan(findIdx)
  })

  it('returns error if entry not found or cross-customer', () => {
    expect(src_).toContain('Entry not found or access denied.')
  })

  it('rejects zero price (must be > 0)', () => {
    expect(src_).toContain('n <= 0')
  })

  it('rejects negative price', () => {
    expect(src_).toContain('n <= 0')
  })

  it('validates control characters in notes', () => {
    expect(src_).toContain('Notes contain invalid characters.')
  })

  it('validates notes max 500 chars', () => {
    expect(src_).toContain('Notes must be 500 characters or fewer.')
  })

  it('does not create during update (no upsert)', () => {
    const fnIdx = src_.indexOf('export async function updateWantedListEntry')
    expect(src_.indexOf('wantedCatalogModel.create', fnIdx)).toBe(-1)
    expect(src_.indexOf('wantedCatalogModel.upsert', fnIdx)).toBe(-1)
  })

  it('redirects to /account/wanted on success', () => {
    const fnIdx = src_.indexOf('export async function updateWantedListEntry')
    expect(src_.indexOf("redirect('/account/wanted')", fnIdx)).toBeGreaterThan(fnIdx)
  })
})

describe('wantedList.ts: removeFromWantedList', () => {
  const src_ = src('src/lib/actions/wantedList.ts')

  it('requires auth', () => {
    const fnIdx = src_.indexOf('export async function removeFromWantedList')
    expect(src_.indexOf("if (!session) return", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('enforces ownership via customerProfileId', () => {
    const fnIdx = src_.indexOf('export async function removeFromWantedList')
    expect(src_.indexOf('customerProfileId: session.profileId', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('uses deleteMany (safe cross-customer filter)', () => {
    const fnIdx = src_.indexOf('export async function removeFromWantedList')
    expect(src_.indexOf('deleteMany', fnIdx)).toBeGreaterThan(fnIdx)
    expect(src_.indexOf('wantedCatalogModel.delete(', fnIdx)).toBe(-1)
  })
})

// ── WantedList query ─────────────────────────────────────────────────────────

describe('wantedListQuery.ts', () => {
  const src_ = src('src/lib/wantedListQuery.ts')

  it('exports getWantedList and WANTED_PAGE_SIZE', () => {
    expect(src_).toContain('export async function getWantedList')
    expect(src_).toContain('export const WANTED_PAGE_SIZE')
  })

  it('exports getAvailableWantedList for DB-level availability filter', () => {
    expect(src_).toContain('export async function getAvailableWantedList')
  })

  it('getAvailableWantedList uses DB relational predicate (no in-memory filter)', () => {
    const fnIdx = src_.indexOf('export async function getAvailableWantedList')
    expect(src_.indexOf("status: 'available'", fnIdx)).toBeGreaterThan(fnIdx)
    expect(src_.indexOf("status: 'active'", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('getAvailableWantedList uses same id-keyset cursor as getWantedList', () => {
    const fnIdx = src_.indexOf('export async function getAvailableWantedList')
    expect(src_.indexOf("id: { gt: cursor }", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('uses keyset pagination on id', () => {
    expect(src_).toContain("id: { gt: cursor }")
  })

  it('serializes maxDesiredPrice to string (Decimal-safe)', () => {
    expect(src_).toContain('.toString()')
  })

  it('fetches PAGE_SIZE + 1 for hasMore detection', () => {
    expect(src_).toContain('WANTED_PAGE_SIZE + 1')
  })
})

// ── WantedList matching ──────────────────────────────────────────────────────

describe('wantedListMatching.ts', () => {
  const src_ = src('src/lib/wantedListMatching.ts')

  it('exports matchWantedList', () => {
    expect(src_).toContain('export async function matchWantedList')
  })

  it('uses batch query with IN (no N+1)', () => {
    expect(src_).toContain('catalogId: { in: catalogModelIds }')
  })

  it('enforces availability predicate: active listing + available item', () => {
    expect(src_).toContain("status: 'active'")
    expect(src_).toContain("status: 'available'")
  })

  it('filters price > 0 (no zero-price or draft listings)', () => {
    expect(src_).toContain('price: { gt: 0 }')
  })

  it('orders by price ASC then id ASC for deterministic lowest-price', () => {
    expect(src_).toContain("{ price: 'asc' }")
    expect(src_).toContain("{ id: 'asc' }")
  })

  it('uses firstListingId === null check (not price comparison) for determinism via DB sort', () => {
    expect(src_).toContain('entry.firstListingId === null')
    expect(src_).not.toContain('listing.price < entry.lowestActivePrice')
  })

  it('returns early with empty map for no ids', () => {
    expect(src_).toContain('catalogModelIds.length === 0')
  })

  it('does not query order or payment data', () => {
    expect(src_).not.toContain('orderItem')
    expect(src_).not.toContain('payment')
    expect(src_).not.toContain('buyerEmail')
  })

  it('excludes reserved/sold/draft listings (status active only)', () => {
    expect(src_).not.toContain("'draft'")
    expect(src_).not.toContain("'sold'")
    expect(src_).not.toContain("'reserved'")
  })
})

// ── Leaderboard isPublic + quantity filter ────────────────────────────────────

describe('communityLeaderboardsQuery.ts: isPublic + quantity filter', () => {
  const src_ = src('src/lib/communityLeaderboardsQuery.ts')

  it('scanCollectionItems filters isPublic: true', () => {
    const fnIdx = src_.indexOf('async function scanCollectionItems')
    expect(src_.indexOf('isPublic: true', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('scanCollectionItems filters quantity > 0 to prevent malformed inflation', () => {
    const fnIdx = src_.indexOf('async function scanCollectionItems')
    expect(src_.indexOf('quantity: { gt: 0 }', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('scanRecentCollectionItems filters isPublic: true', () => {
    const fnIdx = src_.indexOf('async function scanRecentCollectionItems')
    expect(src_.indexOf('isPublic: true', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('getPublicProfile recentRows query filters isPublic: true', () => {
    const fnIdx = src_.indexOf('export async function getPublicProfile')
    expect(src_.indexOf('isPublic: true', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('getPublicProfile aggregate filters isPublic: true (private items excluded from totals)', () => {
    const fnIdx = src_.indexOf('export async function getPublicProfile')
    const aggregateIdx = src_.indexOf('_sum: { quantity', fnIdx)
    const beforeAggregate = src_.slice(fnIdx, aggregateIdx)
    const publicOccurrences = (beforeAggregate.match(/isPublic: true/g) ?? []).length
    expect(publicOccurrences).toBeGreaterThanOrEqual(3)
  })
})

// ── PublicCollectionItem privacy ─────────────────────────────────────────────

describe('communityLeaderboards.ts: PublicCollectionItem excludes private fields', () => {
  const src_ = src('src/lib/communityLeaderboards.ts')

  it('does not include CollectionItem.id in public type', () => {
    const typeIdx = src_.indexOf('export type PublicCollectionItem')
    const closeBrace = src_.indexOf('}', typeIdx)
    const typeBody = src_.slice(typeIdx, closeBrace)
    expect(typeBody).not.toContain('id: string')
  })

  it('does not include addedAt (acquisition date) in public type', () => {
    const typeIdx = src_.indexOf('export type PublicCollectionItem')
    const closeBrace = src_.indexOf('}', typeIdx)
    const typeBody = src_.slice(typeIdx, closeBrace)
    expect(typeBody).not.toContain('addedAt')
  })

  it('does not include notes (private) in public type', () => {
    const typeIdx = src_.indexOf('export type PublicCollectionItem')
    const closeBrace = src_.indexOf('}', typeIdx)
    const typeBody = src_.slice(typeIdx, closeBrace)
    expect(typeBody).not.toContain('notes')
  })
})

describe('communityLeaderboardsQuery.ts: mapping excludes private fields', () => {
  const src_ = src('src/lib/communityLeaderboardsQuery.ts')

  it('recentItems mapping does not include id', () => {
    const mapIdx = src_.indexOf('recentItems: PublicCollectionItem[]')
    const endIdx = src_.indexOf('])', mapIdx)
    const mapBlock = src_.slice(mapIdx, endIdx)
    expect(mapBlock).not.toContain('id: ci.id')
  })

  it('recentItems mapping does not include addedAt', () => {
    const mapIdx = src_.indexOf('recentItems: PublicCollectionItem[]')
    const endIdx = src_.indexOf('])', mapIdx)
    const mapBlock = src_.slice(mapIdx, endIdx)
    expect(mapBlock).not.toContain('addedAt')
  })

  it('recentItems mapping does not include purchaseDate or purchasePrice', () => {
    const mapIdx = src_.indexOf('recentItems: PublicCollectionItem[]')
    const endIdx = src_.indexOf('])', mapIdx)
    const mapBlock = src_.slice(mapIdx, endIdx)
    expect(mapBlock).not.toContain('purchaseDate')
    expect(mapBlock).not.toContain('purchasePrice')
    expect(mapBlock).not.toContain('notes')
  })
})

// ── community/[handle] uses catalogId as key ─────────────────────────────────

describe('community/[handle]/page.tsx: no private data in public render', () => {
  const src_ = src('src/app/(store)/community/[handle]/page.tsx')

  it('uses catalogId (not item.id) as React key', () => {
    expect(src_).toContain('key={item.catalogId}')
    expect(src_).not.toContain('key={item.id}')
  })

  it('does not render addedAt or acquisition date', () => {
    expect(src_).not.toContain('addedAt')
    expect(src_).not.toContain('purchaseDate')
  })
})

// ── Wanted page: DB-level filter ──────────────────────────────────────────────

describe('account/wanted/page.tsx', () => {
  const src_ = src('src/app/(store)/account/wanted/page.tsx')

  it('requires auth (notFound if no session)', () => {
    expect(src_).toContain('notFound()')
  })

  it('uses getAvailableWantedList when filterAvailable=true (DB-level, not in-memory)', () => {
    expect(src_).toContain('getAvailableWantedList')
    expect(src_).not.toContain('.filter(i => availability.get')
  })

  it('imports WantedListAddForm', () => {
    expect(src_).toContain('WantedListAddForm')
  })

  it('imports RemoveFromWantedButton (with confirm)', () => {
    expect(src_).toContain('RemoveFromWantedButton')
  })

  it('links to specific listing (not generic /browse)', () => {
    expect(src_).toContain('avail.firstListingId')
    expect(src_).toContain('/browse/${avail.firstListingId}')
  })

  it('has edit link to /account/wanted/[id]/edit', () => {
    expect(src_).toContain('/account/wanted/${entry.id}/edit')
  })

  it('does not expose maxDesiredPrice or notes on public routes', () => {
    // Page is account-only (notFound if no session)
    expect(src_).toContain('if (!session) notFound()')
  })
})

describe('RemoveFromWantedButton.tsx: explicit confirmation', () => {
  const src_ = src('src/components/store/RemoveFromWantedButton.tsx')

  it('uses window.confirm before submitting', () => {
    expect(src_).toContain('window.confirm')
  })

  it('prevents submit if confirm is declined', () => {
    expect(src_).toContain('e.preventDefault()')
  })
})

// ── Cache invalidation ────────────────────────────────────────────────────────

describe('collectionItems.ts: updateTag for leaderboard cache', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it("imports updateTag from 'next/cache'", () => {
    expect(src_).toContain("import { updateTag } from 'next/cache'")
  })

  it('toggleCollectionItemPublic calls updateTag', () => {
    const fnIdx = src_.indexOf('export async function toggleCollectionItemPublic')
    expect(src_.indexOf("updateTag('community-leaderboards')", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('updateCollectionItem calls updateTag', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    expect(src_.indexOf("updateTag('community-leaderboards')", fnIdx)).toBeGreaterThan(fnIdx)
  })
})

// ── Account navigation ────────────────────────────────────────────────────────

// 16A: these links moved out of layout.tsx's own markup and into the shared
// Account-menu navigation definition (src/lib/customerNav.ts, rendered by
// CustomerHeader.tsx) — still present and reachable, just no longer competing as
// separate top-level links. See customerNav.test.ts for full coverage.
describe('customerNav.ts: Account-menu links (moved from layout.tsx in 16A)', () => {
  const src_ = src('src/lib/customerNav.ts')

  it('has My Collection link', () => {
    expect(src_).toContain("href: '/account/collection'")
  })

  it('has Wanted List link', () => {
    expect(src_).toContain("href: '/account/wanted'")
  })

  it('has Community Profile link', () => {
    expect(src_).toContain("href: '/account/community'")
  })
})

// ── Privacy: no wanted list on public routes ──────────────────────────────────

describe('Privacy: no wanted list data on public routes', () => {
  it('community/page.tsx does not import wantedList', () => {
    const src_ = src('src/app/(store)/community/page.tsx')
    expect(src_).not.toContain('wantedList')
    expect(src_).not.toContain('WantedCatalogModel')
  })

  it('community/[handle]/page.tsx does not import wantedList', () => {
    const src_ = src('src/app/(store)/community/[handle]/page.tsx')
    expect(src_).not.toContain('wantedList')
    expect(src_).not.toContain('WantedCatalogModel')
    expect(src_).not.toContain('maxDesiredPrice')
  })

  it('communityLeaderboardsQuery.ts does not query wantedList', () => {
    const src_ = src('src/lib/communityLeaderboardsQuery.ts')
    expect(src_).not.toContain('wantedCatalogModel')
    expect(src_).not.toContain('maxDesiredPrice')
  })
})

// ── No auto-purchase / reservation ───────────────────────────────────────────

describe('No automatic purchase or reservation', () => {
  it('wantedList.ts creates no orders or listings', () => {
    const src_ = src('src/lib/actions/wantedList.ts')
    expect(src_).not.toContain('order.create')
    expect(src_).not.toContain('listing.update')
    expect(src_).not.toContain('orderItem')
    expect(src_).not.toContain('payment')
  })

  it('wantedListMatching.ts has no mutations', () => {
    const src_ = src('src/lib/wantedListMatching.ts')
    expect(src_).not.toContain('.create')
    expect(src_).not.toContain('.update')
    expect(src_).not.toContain('.delete')
  })
})

// ── Collection page: pagination ───────────────────────────────────────────────

describe('collection/page.tsx: keyset pagination', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('accepts cursor search param', () => {
    expect(src_).toContain('cursor')
  })

  it('uses id: { gt: cursor } for keyset pagination', () => {
    expect(src_).toContain("id: { gt: cursor }")
  })

  it('renders Next page link when nextCursor exists', () => {
    expect(src_).toContain('nextCursor')
    expect(src_).toContain('pageHref(nextCursor)')
  })

  // 16E: pagination links now preserve the active search/filter/sort instead of
  // silently dropping them (Part 47) — pageHref() builds the query string from all
  // of q/condition/type/sort/cursor, not just cursor alone.
  it('pageHref preserves q/condition/type/sort alongside cursor', () => {
    const fnIdx = src_.indexOf('function pageHref')
    const fnSrc = src_.slice(fnIdx, src_.indexOf('\n}', fnIdx))
    expect(fnSrc).toContain('q=')
    expect(fnSrc).toContain('condition=')
    expect(fnSrc).toContain('type=')
    expect(fnSrc).toContain("sort=newest")
    expect(fnSrc).toContain('cursor=')
  })

  it('changing sort flips id asc/desc and the cursor comparator (gt for oldest-first, lt for newest-first)', () => {
    expect(src_).toContain("id: { lt: cursor }")
    expect(src_).toContain("id: { gt: cursor }")
    expect(src_).toContain("orderBy: { id: sortNewest ? 'desc' : 'asc' }")
  })
})

describe('collection/page.tsx: isPublic toggle', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('imports toggleCollectionItemPublic', () => {
    expect(src_).toContain('toggleCollectionItemPublic')
  })

  it('includes isPublic in query select', () => {
    expect(src_).toContain('isPublic:')
  })

  it('renders form with bound toggle action per item', () => {
    expect(src_).toContain('toggleCollectionItemPublic.bind(null, item.id, !item.isPublic)')
  })
})

// ── Leaderboard label ─────────────────────────────────────────────────────────

describe('community/page.tsx: leaderboard labels', () => {
  const src_ = src('src/app/(store)/community/page.tsx')

  it('labels largest collections as based on public items', () => {
    expect(src_).toContain('public collection items')
  })
})

// ── Gap 1: Optimistic concurrency ────────────────────────────────────────────

describe('collectionItems.ts: updateCollectionItem optimistic concurrency', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('uses updateMany (not update) for concurrency-safe writes', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    expect(src_.indexOf('collectionItem.updateMany', fnIdx)).toBeGreaterThan(fnIdx)
    const updateIdx = src_.indexOf('collectionItem.update(', fnIdx)
    expect(updateIdx === -1 || updateIdx > src_.indexOf('collectionItem.updateMany', fnIdx)).toBe(true)
  })

  it('reads expectedUpdatedAt from formData', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    expect(src_.indexOf('expectedUpdatedAt', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('passes updatedAt: expectedUpdatedAt to updateMany where clause', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    expect(src_.indexOf('updatedAt: expectedUpdatedAt', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('returns stale error when count is 0 and row still exists', () => {
    expect(src_).toContain('was changed elsewhere')
  })

  it('returns not-found error when count is 0 and row is gone', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    expect(src_.indexOf('no longer exists', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('re-checks existence after count === 0 to distinguish stale vs deleted', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    const updateManyIdx = src_.indexOf('collectionItem.updateMany', fnIdx)
    const recheckIdx = src_.indexOf('collectionItem.findFirst', updateManyIdx)
    expect(recheckIdx).toBeGreaterThan(updateManyIdx)
  })
})

describe('CollectionItemForm.tsx: expectedUpdatedAt hidden field', () => {
  const src_ = src('src/components/store/CollectionItemForm.tsx')

  it('sends expectedUpdatedAt as hidden field in edit mode', () => {
    expect(src_).toContain('name="expectedUpdatedAt"')
  })

  it('uses item.updatedAt.toISOString() as the value', () => {
    expect(src_).toContain('item.updatedAt.toISOString()')
  })

  it('only renders the hidden field in edit mode (!isCreate)', () => {
    expect(src_).toContain('!isCreate && item')
  })
})

// ── Gap 2: Unavailable wanted-list filter ────────────────────────────────────

describe('wantedListQuery.ts: getUnavailableWantedList', () => {
  const src_ = src('src/lib/wantedListQuery.ts')

  it('exports getUnavailableWantedList', () => {
    expect(src_).toContain('export async function getUnavailableWantedList')
  })

  it('uses NOT predicate for DB-level unavailability (no in-memory filter)', () => {
    const fnIdx = src_.indexOf('export async function getUnavailableWantedList')
    expect(src_.indexOf('NOT:', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('requires price > 0 in availability check', () => {
    const fnIdx = src_.indexOf('export async function getUnavailableWantedList')
    expect(src_.indexOf('price: { gt: 0 }', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('uses same id-keyset cursor as other list functions', () => {
    const fnIdx = src_.indexOf('export async function getUnavailableWantedList')
    expect(src_.indexOf("id: { gt: cursor }", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('fetches PAGE_SIZE + 1 for hasMore detection', () => {
    const fnIdx = src_.indexOf('export async function getUnavailableWantedList')
    expect(src_.indexOf('WANTED_PAGE_SIZE + 1', fnIdx)).toBeGreaterThan(fnIdx)
  })
})

describe('wantedListQuery.ts: getAvailableWantedList uses price > 0', () => {
  const src_ = src('src/lib/wantedListQuery.ts')

  it('filters price > 0 in availability predicate (consistent with matchWantedList)', () => {
    const fnIdx = src_.indexOf('export async function getAvailableWantedList')
    expect(src_.indexOf('price: { gt: 0 }', fnIdx)).toBeGreaterThan(fnIdx)
  })
})

describe('account/wanted/page.tsx: unavailable filter', () => {
  const src_ = src('src/app/(store)/account/wanted/page.tsx')

  it('imports getUnavailableWantedList', () => {
    expect(src_).toContain('getUnavailableWantedList')
  })

  it('routes available=0 to getUnavailableWantedList', () => {
    expect(src_).toContain("available === '0'")
    expect(src_).toContain('getUnavailableWantedList(')
  })

  it('preserves available=0 param in pagination next-page link', () => {
    expect(src_).toContain('available=0')
  })
})

// ── 16D: Wanted & Alerts consolidation ───────────────────────────────────────

describe('account/wanted/page.tsx: 16D unified Wanted & Alerts page', () => {
  const src_ = src('src/app/(store)/account/wanted/page.tsx')

  it('page title/heading is "Wanted & Alerts", not "Wanted List"', () => {
    expect(src_).toContain('Wanted & Alerts')
  })

  it('renders a three-tab view switcher: All Wanted / Available Now / Recent Alerts', () => {
    expect(src_).toContain('All Wanted')
    expect(src_).toContain('Available Now')
    expect(src_).toContain('Recent Alerts')
  })

  it('the available=1 deep link (used by /account "Check Available Matches") still works', () => {
    expect(src_).toContain("'/account/wanted?available=1'")
  })

  it('supports view=alerts without requiring a new route', () => {
    expect(src_).toContain("view === 'alerts'")
    expect(src_).toContain('/account/wanted?view=alerts')
  })

  it('the alerts view reuses buyerAlertsQuery — no second alert-read implementation', () => {
    expect(src_).toMatch(/from '@\/lib\/buyerAlertsQuery'/)
    expect(src_).toContain('getAlertEvents(')
    expect(src_).toContain('resolveAlertPreference(')
    expect(src_).toContain('getUnreadAlertCount(')
  })

  it('reuses the existing MarkAlertReadButton/MarkAllAlertsReadButton/AlertPreferencesForm components — no duplicated mark-read or preference UI', () => {
    expect(src_).toMatch(/from '@\/components\/store\/MarkAlertReadButtons'/)
    expect(src_).toMatch(/from '@\/components\/store\/AlertPreferencesForm'/)
  })

  it('the wanted-count header stat is an exact DB-side count, not derived from a paginated items array', () => {
    expect(src_).toContain('wantedCatalogModel.count(')
  })

  it('alerts view does not call matchWantedList — matching only runs for the wanted-list view', () => {
    const alertsBranchIdx = src_.indexOf('if (showAlerts)')
    const alertsBranchEnd = src_.indexOf('// ── Wanted list view')
    const alertsBranch = src_.slice(alertsBranchIdx, alertsBranchEnd)
    expect(alertsBranch).not.toContain('matchWantedList')
  })

  it('rendering the page performs no mark-read mutation itself (mark-read only via explicit button actions)', () => {
    expect(src_).not.toMatch(/buyerAlertEvent\.(update|updateMany)/)
  })
})

describe('account/alerts/page.tsx: 16D redirect to unified Wanted & Alerts', () => {
  const src_ = src('src/app/(store)/account/alerts/page.tsx')

  it('still gates on session before redirecting (private route)', () => {
    expect(src_).toContain('getBuyerSession')
    expect(src_).toContain('notFound()')
  })

  it('redirects to /account/wanted?view=alerts — the same route, not a new parallel destination', () => {
    expect(src_).toContain('/account/wanted?view=alerts')
    expect(src_).toContain('redirect(')
  })

  it('preserves the old cursor query param (the only param the old page ever supported) through the redirect', () => {
    expect(src_).toContain('searchParams')
    expect(src_).toContain('cursor')
    expect(src_).toMatch(/cursor \? `&cursor=\$\{encodeURIComponent\(cursor\)\}`/)
  })

  it('does not reimplement alert-reading logic itself', () => {
    expect(src_).not.toContain('getAlertEvents')
    expect(src_).not.toMatch(/prisma\./)
  })
})

describe('WantedAlertToggle.tsx: 16D explicit desired-state mutation + accessibility', () => {
  const src_ = src('src/components/store/WantedAlertToggle.tsx')

  it('uses setWantedAlertAction (explicit desired state), not a blind toggle', () => {
    expect(src_).toContain('setWantedAlertAction')
    expect(src_).not.toContain('toggleWantedAlertAction')
  })

  it('binds the explicit negated-current value, never re-derives it server-side', () => {
    expect(src_).toContain('setWantedAlertAction.bind(null, id, field, !enabled)')
  })

  it('exposes switch semantics with a model-scoped accessible label', () => {
    expect(src_).toContain("role=\"switch\"")
    expect(src_).toContain('aria-checked={enabled}')
    expect(src_).toContain('modelName')
  })
})

describe('actions/buyerAlerts.ts: 16D setWantedAlertAction replaces the blind toggle', () => {
  const src_ = src('src/lib/actions/buyerAlerts.ts')

  it('setWantedAlertAction takes an explicit boolean and writes it directly (no read-then-negate)', () => {
    const fnIdx = src_.indexOf('export async function setWantedAlertAction')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnSrc = src_.slice(fnIdx)
    expect(fnSrc).toContain('enabled: boolean')
    expect(fnSrc).not.toContain('findFirst')
  })

  it('scopes the write to id AND customerProfileId in a single updateMany (ownership + mutation atomic)', () => {
    const fnIdx = src_.indexOf('export async function setWantedAlertAction')
    const fnSrc = src_.slice(fnIdx)
    expect(fnSrc).toContain('wantedCatalogModel.updateMany({')
    expect(fnSrc).toContain('where: { id, customerProfileId: session.profileId }')
  })

  it('toggleWantedAlertAction no longer exists', () => {
    expect(src_).not.toContain('export async function toggleWantedAlertAction')
  })
})

describe('16D: alerts-disabled wanted models remain wanted and still match', () => {
  it('the wanted-list view never filters items by availabilityAlertEnabled/priceAlertEnabled — alert preference does not affect Wanted membership or matching', () => {
    const src_ = src('src/app/(store)/account/wanted/page.tsx')
    // The only place these fields appear is passed straight through as WantedAlertToggle
    // props — never used in a .filter()/where predicate that would hide the item itself.
    expect(src_).not.toMatch(/\.filter\([^)]*availabilityAlertEnabled/)
    expect(src_).not.toMatch(/\.filter\([^)]*priceAlertEnabled/)
  })
})

describe('16D: no schema migration was required', () => {
  it('WantedCatalogModel already had availabilityAlertEnabled/priceAlertEnabled before 16D — no new column added', () => {
    const schema = src('prisma/schema.prisma')
    const idx = schema.indexOf('model WantedCatalogModel {')
    const modelSrc = schema.slice(idx, schema.indexOf('\n}', idx))
    expect(modelSrc).toContain('availabilityAlertEnabled Boolean  @default(true)')
    expect(modelSrc).toContain('priceAlertEnabled        Boolean  @default(true)')
  })

  it('the fan-out processor already respects both per-model toggles — 16D did not need to add this', () => {
    const src_ = src('src/lib/buyerAlertsFanoutProcessor.ts')
    expect(src_).toContain('row.availabilityAlertEnabled')
    expect(src_).toContain('row.priceAlertEnabled')
  })
})

// ── Gap 3: Complete public cache invalidation ─────────────────────────────────

describe('collectionItems.ts: createCollectionItem cache invalidation', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('calls updateTag when creating a public item', () => {
    const fnIdx = src_.indexOf('export async function createCollectionItem')
    expect(src_.indexOf("updateTag('community-leaderboards')", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('guards updateTag behind isPublic check on create', () => {
    const fnIdx = src_.indexOf('export async function createCollectionItem')
    const tagIdx = src_.indexOf("updateTag('community-leaderboards')", fnIdx)
    const ifIdx = src_.indexOf('if (isPublic)', fnIdx)
    expect(ifIdx).toBeGreaterThan(fnIdx)
    expect(tagIdx).toBeGreaterThan(ifIdx)
  })
})

describe('collectionItems.ts: updateCollectionItem conditional cache invalidation', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('fetches old isPublic before updateMany', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    const findIdx = src_.indexOf('findFirst', fnIdx)
    const isPublicIdx = src_.indexOf('isPublic: true', findIdx)
    const updateManyIdx = src_.indexOf('updateMany', fnIdx)
    expect(isPublicIdx).toBeGreaterThan(findIdx)
    expect(isPublicIdx).toBeLessThan(updateManyIdx)
  })

  it('guards updateTag with old OR new isPublic check', () => {
    const fnIdx = src_.indexOf('export async function updateCollectionItem')
    const tagIdx = src_.indexOf("updateTag('community-leaderboards')", fnIdx)
    const guardIdx = src_.indexOf('existing.isPublic || isPublic', fnIdx)
    expect(guardIdx).toBeGreaterThan(fnIdx)
    expect(tagIdx).toBeGreaterThan(guardIdx)
  })
})

describe('collectionItems.ts: deleteCollectionItem cache invalidation', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('fetches isPublic before deleting', () => {
    const fnIdx = src_.indexOf('export async function deleteCollectionItem')
    const findIdx = src_.indexOf('findFirst', fnIdx)
    const isPublicIdx = src_.indexOf('isPublic: true', findIdx)
    expect(isPublicIdx).toBeGreaterThan(findIdx)
  })

  it('calls updateTag when deleting a public item', () => {
    const fnIdx = src_.indexOf('export async function deleteCollectionItem')
    expect(src_.indexOf("updateTag('community-leaderboards')", fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('guards updateTag with item.isPublic check on delete', () => {
    const fnIdx = src_.indexOf('export async function deleteCollectionItem')
    const tagIdx = src_.indexOf("updateTag('community-leaderboards')", fnIdx)
    const guardIdx = src_.indexOf('if (item.isPublic)', fnIdx)
    expect(guardIdx).toBeGreaterThan(fnIdx)
    expect(tagIdx).toBeGreaterThan(guardIdx)
  })
})

// ── Gap 4: Delete confirmation ────────────────────────────────────────────────

describe('ConfirmDeleteItemButton.tsx: JS confirm dialog', () => {
  const src_ = src('src/components/store/ConfirmDeleteItemButton.tsx')

  it('is a client component', () => {
    expect(src_).toMatch(/^'use client'/)
  })

  it('uses window.confirm before submitting', () => {
    expect(src_).toContain('window.confirm')
  })

  it('prevents submit if confirm is declined', () => {
    expect(src_).toContain('e.preventDefault()')
  })

  it('binds deleteCollectionItem server action', () => {
    expect(src_).toContain('deleteCollectionItem.bind(null, id)')
  })
})

describe('account/collection/[id]/page.tsx: uses ConfirmDeleteItemButton', () => {
  const src_ = src('src/app/(store)/account/collection/[id]/page.tsx')

  it('imports ConfirmDeleteItemButton', () => {
    expect(src_).toContain('ConfirmDeleteItemButton')
  })

  it('renders ConfirmDeleteItemButton with item.id', () => {
    expect(src_).toContain('<ConfirmDeleteItemButton id={item.id}')
  })

  it('does not contain a bare delete form (no static form submit)', () => {
    expect(src_).not.toContain('action={deleteItemAction}')
  })
})

// ── Stale delete / cross-customer protection ──────────────────────────────────

describe('collectionItems.ts: deleteCollectionItem stale handling', () => {
  const src_ = src('src/lib/actions/collectionItems.ts')

  it('checks deleteMany count (does not silently ignore count=0)', () => {
    const fnIdx = src_.indexOf('export async function deleteCollectionItem')
    expect(src_.indexOf('deleteResult.count === 0', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('skips blob cleanup and updateTag when count=0 (no side effects on stale delete)', () => {
    const fnIdx = src_.indexOf('export async function deleteCollectionItem')
    const countCheckIdx = src_.indexOf('deleteResult.count === 0', fnIdx)
    const updateTagIdx = src_.indexOf("updateTag('community-leaderboards')", fnIdx)
    // updateTag must come after the count=0 early-exit, not before it
    expect(countCheckIdx).toBeGreaterThan(fnIdx)
    expect(updateTagIdx).toBeGreaterThan(countCheckIdx)
  })

  it('scopes deleteMany to { id, profileId: session.profileId } (cross-customer protection)', () => {
    const fnIdx = src_.indexOf('export async function deleteCollectionItem')
    const deleteManyIdx = src_.indexOf('deleteMany', fnIdx)
    const profileIdx = src_.indexOf('profileId: session.profileId', deleteManyIdx)
    expect(profileIdx).toBeGreaterThan(deleteManyIdx)
  })
})

describe('wantedList.ts: removeFromWantedList stale handling', () => {
  const src_ = src('src/lib/actions/wantedList.ts')

  it('checks deleteMany count (does not silently ignore count=0)', () => {
    const fnIdx = src_.indexOf('export async function removeFromWantedList')
    expect(src_.indexOf('result.count === 0', fnIdx)).toBeGreaterThan(fnIdx)
  })

  it('returns early without revalidatePath when count=0 (clean stale result)', () => {
    const fnIdx = src_.indexOf('export async function removeFromWantedList')
    const countCheckIdx = src_.indexOf('result.count === 0', fnIdx)
    const revalidateIdx = src_.indexOf('revalidatePath', fnIdx)
    // revalidatePath must come after the count=0 early return
    expect(countCheckIdx).toBeGreaterThan(fnIdx)
    expect(revalidateIdx).toBeGreaterThan(countCheckIdx)
  })

  it('scopes deleteMany to customerProfileId: session.profileId (cross-customer protection)', () => {
    const fnIdx = src_.indexOf('export async function removeFromWantedList')
    const deleteManyIdx = src_.indexOf('deleteMany', fnIdx)
    const profileIdx = src_.indexOf('customerProfileId: session.profileId', deleteManyIdx)
    expect(profileIdx).toBeGreaterThan(deleteManyIdx)
  })
})

// ── Both remove buttons require confirmation ──────────────────────────────────

describe('Deletion confirmation: both remove buttons use window.confirm', () => {
  it('ConfirmDeleteItemButton uses window.confirm', () => {
    const src_ = src('src/components/store/ConfirmDeleteItemButton.tsx')
    expect(src_).toContain('window.confirm')
  })

  it('RemoveFromWantedButton uses window.confirm', () => {
    const src_ = src('src/components/store/RemoveFromWantedButton.tsx')
    expect(src_).toContain('window.confirm')
  })
})

// ── Public-profile cache scope ────────────────────────────────────────────────

describe('communityLeaderboardsQuery.ts: cache scope', () => {
  const src_ = src('src/lib/communityLeaderboardsQuery.ts')

  it('only getLeaderboardData is wrapped in unstable_cache', () => {
    expect(src_).toContain('export const getLeaderboardData = unstable_cache(')
  })

  it('getPublicProfile is a plain function (not cached — force-dynamic page handles freshness)', () => {
    expect(src_).toContain('export async function getPublicProfile')
    const plainIdx = src_.indexOf('export async function getPublicProfile')
    const cacheIdx = src_.indexOf('unstable_cache', plainIdx)
    expect(cacheIdx).toBe(-1)
  })

  it('community-leaderboards cache tag is used with getLeaderboardData', () => {
    const cacheIdx = src_.indexOf("'community-leaderboards'")
    expect(cacheIdx).toBeGreaterThan(-1)
  })
})

describe('community/[handle]/page.tsx: force-dynamic (no profile cache needed)', () => {
  const src_ = src('src/app/(store)/community/[handle]/page.tsx')

  it('is force-dynamic so getPublicProfile always returns fresh data', () => {
    expect(src_).toContain("export const dynamic = 'force-dynamic'")
  })
})

// ── Vitest excludes worktrees ─────────────────────────────────────────────────

describe('vitest.config.mts: excludes worktrees', () => {
  const src_ = src('vitest.config.mts')

  it('excludes .claude/worktrees from test runs', () => {
    expect(src_).toContain('.claude/worktrees/**')
  })
})

// ── No public wanted list exposure ────────────────────────────────────────────

describe('No public wanted list exposure', () => {
  it('community page does not expose wantedList', () => {
    const src_ = src('src/app/(store)/community/page.tsx')
    expect(src_).not.toContain('wantedList')
    expect(src_).not.toContain('maxDesiredPrice')
  })

  it('community/[handle] page does not expose wanted list or max price', () => {
    const src_ = src('src/app/(store)/community/[handle]/page.tsx')
    expect(src_).not.toContain('maxDesiredPrice')
    expect(src_).not.toContain('wantedList')
  })

  it('leaderboard query does not expose wanted list', () => {
    const src_ = src('src/lib/communityLeaderboardsQuery.ts')
    expect(src_).not.toContain('wantedCatalogModel')
    expect(src_).not.toContain('maxDesiredPrice')
  })
})

// ── No private notes/prices on public routes ──────────────────────────────────

describe('No private notes or purchase prices on public routes', () => {
  it('PublicCollectionItem type excludes purchasePrice', () => {
    const src_ = src('src/lib/communityLeaderboards.ts')
    const typeIdx = src_.indexOf('export type PublicCollectionItem')
    const closeBrace = src_.indexOf('}', typeIdx)
    const typeBody = src_.slice(typeIdx, closeBrace)
    expect(typeBody).not.toContain('purchasePrice')
  })

  it('community/[handle] page does not render purchasePrice or notes', () => {
    const src_ = src('src/app/(store)/community/[handle]/page.tsx')
    expect(src_).not.toContain('purchasePrice')
    expect(src_).not.toContain('item.notes')
  })
})

// ── No automatic purchase/reservation/contact ────────────────────────────────

describe('No automatic purchase, reservation, or contact', () => {
  it('wantedList actions perform no order, listing, or contact mutations', () => {
    const src_ = src('src/lib/actions/wantedList.ts')
    expect(src_).not.toContain('order.create')
    expect(src_).not.toContain('order.update')
    expect(src_).not.toContain('listing.update')
    expect(src_).not.toContain('sendEmail')
    expect(src_).not.toContain('contact')
    expect(src_).not.toContain('reservation')
  })

  it('wantedListMatching performs no mutations', () => {
    const src_ = src('src/lib/wantedListMatching.ts')
    expect(src_).not.toContain('.create')
    expect(src_).not.toContain('.update')
    expect(src_).not.toContain('.delete')
  })

  it('collectionItems actions perform no order or payout mutations', () => {
    const src_ = src('src/lib/actions/collectionItems.ts')
    expect(src_).not.toContain('order.create')
    expect(src_).not.toContain('payout')
    expect(src_).not.toContain('listing.create')
  })
})

// ── 16E: Collection experience simplification ─────────────────────────────────

describe('16E: physical-copy identity — one CollectionItem row per (profile, catalogModel)', () => {
  it('createCollectionItem already rejects a second row for the same catalogId — the domain has no multi-row-per-model scenario to group at read time', () => {
    const src_ = src('src/lib/actions/collectionItems.ts')
    const fnIdx = src_.indexOf('export async function createCollectionItem')
    const fnSrc = src_.slice(fnIdx)
    expect(fnSrc).toContain('collectionItem.findFirst({')
    expect(fnSrc).toContain('You already have this model in your collection')
  })

  it('the list page never sums/aggregates quantity across multiple rows — "You own N" is always the single row\'s own quantity field', () => {
    const src_ = src('src/app/(store)/account/collection/page.tsx')
    expect(src_).not.toMatch(/reduce\(.*quantity/)
    expect(src_).toContain('You own {item.quantity}')
  })
})

describe('16E Final: exact header totals use SUM(quantity), not row count (not page-subset counts either)', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('itemCount comes from a DB-side aggregate SUM(quantity) scoped to the unfiltered baseWhere, never collectionItem.count()', () => {
    expect(src_).toContain('collectionItem.aggregate({ where: baseWhere, _sum: { quantity: true } })')
    expect(src_).toContain('const itemCount = qtyAgg._sum.quantity ?? 0')
  })

  it('entryCount = distinct catalog models (groupBy) + freeform (catalogId=null) row count, not items.length', () => {
    expect(src_).toContain("collectionItem.groupBy({ by: ['catalogId'], where: { ...baseWhere, catalogId: { not: null } } })")
    expect(src_).toContain('collectionItem.count({ where: { ...baseWhere, catalogId: null } })')
    expect(src_).toContain('const entryCount = distinctModelGroups.length + freeformCount')
    expect(src_).not.toMatch(/\{items\.length\}\{hasMore/)
  })

  it('the header label is "entries", not "models" — accurate given freeform rows are counted', () => {
    expect(src_).toContain('entr{entryCount !== 1')
  })

  it('baseWhere/header totals are scoped only by profileId — never by the active search/filter', () => {
    const idx = src_.indexOf('const baseWhere =')
    const line = src_.slice(idx, src_.indexOf('\n', idx))
    expect(line).toContain('profileId: session.profileId')
    expect(line).not.toContain('condition')
    expect(line).not.toContain('cardedOrLoose')
  })

  it('the filtered "matching entries" count is a separate exact row-count query, labeled "entries" (not "items") so it is never confused with the SUM(quantity) total', () => {
    expect(src_).toContain('collectionItem.count({ where: filterWhere })')
    expect(src_).toContain('matching entr{matchingCount !== 1')
    expect(src_).not.toMatch(/\{matchingCount\}\s*matching item/)
  })

  it('no customer-facing "items" label on this page is fed by a bare row count — the only collectionItem.count() calls back freeformCount and matchingCount, both labeled "entries"', () => {
    const countCalls = [...src_.matchAll(/collectionItem\.count\(\{[^}]*\}\)/g)].map((m) => m[0])
    expect(countCalls.length).toBeGreaterThan(0)
    for (const call of countCalls) {
      // every count() call site feeds either freeformCount or matchingCount — never itemCount
      expect(call).not.toMatch(/quantity/)
    }
  })
})

describe('16E: search/filter/sort are DB-backed, cursor pagination stays correct', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('search matches brand/name on both the free-text item and its linked catalog model, case-insensitively', () => {
    const idx = src_.indexOf('const filterWhere')
    const block = src_.slice(idx, src_.indexOf('const [itemCount', idx))
    expect(block).toContain("mode: 'insensitive' as const")
    expect(block).toContain('catalog: { brand:')
    expect(block).toContain('catalog: { name:')
  })

  it('condition/type filters are validated against known enums before use — no arbitrary passthrough', () => {
    expect(src_).toContain('VALID_CONDITIONS.has(rawCondition)')
    expect(src_).toContain('VALID_TYPES.has(rawType)')
  })

  it('the paginated findMany applies filterWhere plus the cursor — filters and pagination compose in one query, not a second in-memory pass', () => {
    const idx = src_.indexOf('prisma.collectionItem.findMany({')
    const block = src_.slice(idx, idx + 400)
    expect(block).toContain('...filterWhere')
  })

  it('search/filter changes reset pagination (GET form has no cursor field, submitting drops any existing cursor)', () => {
    const formIdx = src_.indexOf('method="GET" action="/account/collection"')
    const formEnd = src_.indexOf('</form>', formIdx)
    const formBlock = src_.slice(formIdx, formEnd)
    expect(formBlock).not.toContain('name="cursor"')
  })
})

describe('16E: valuation stays on its own dedicated page — no per-card or per-list-load valuation call', () => {
  it('the Collection list page never imports/calls getCollectionValuation or getCatalogValuations', () => {
    const src_ = src('src/app/(store)/account/collection/page.tsx')
    expect(src_).not.toMatch(/getCollectionValuation|getCatalogValuations|getCatalogValuation\(/)
  })

  it('unknown valuation on the dedicated valuation page is rendered as "—", never $0', () => {
    const src_ = src('src/app/(store)/account/collection/valuation/page.tsx')
    expect(src_).toContain('<span className="text-gray-300">—</span>')
    expect(src_).not.toMatch(/hasVal \? centsToDisplay\(item\.estimatedSubtotal!\) : .*\$0/)
  })

  it('getCollectionValuation batches comparable-sales/active-asks lookups (no per-item valuation query)', () => {
    const src_ = src('src/lib/advancedValuationQuery.ts')
    expect(src_).toContain('One comparable-sales query and one active-asks query')
    expect(src_).toContain('Never fetches one query per model (no N+1)')
  })

  // 16E Final Part 10: audited and confirmed correct — getCollectionValuation
  // already multiplies the per-copy estimate by CollectionItem.quantity, so a row
  // with quantity=3 contributes 3x the per-copy value to the collection total, not
  // 1x. No fix was needed here; this test only guards against a future regression.
  it('estimated/low/high subtotals multiply the per-copy valuation by quantity — a quantity=3 row is NOT valued as a single copy', () => {
    const src_ = src('src/lib/advancedValuationQuery.ts')
    const idx = src_.indexOf('export async function getCollectionValuation')
    const fnSrc = src_.slice(idx)
    expect(fnSrc).toContain('estimatedSubtotal: hasValue ? (val!.estimatedValue! * qty) : null')
    expect(fnSrc).toContain('lowSubtotal:       hasValue && val!.lowEstimate  !== null ? (val!.lowEstimate  * qty) : null')
    expect(fnSrc).toContain('highSubtotal:      hasValue && val!.highEstimate !== null ? (val!.highEstimate * qty) : null')
  })
})

describe('16E Final: pagination and cross-profile isolation cannot affect the exact header totals', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('the SUM(quantity)/entryCount aggregate queries carry no take/cursor — they are never derived from the paginated page', () => {
    const aggIdx = src_.indexOf('collectionItem.aggregate({ where: baseWhere')
    const aggCall = src_.slice(aggIdx, aggIdx + 120)
    expect(aggCall).not.toMatch(/take:|cursor:/)

    const groupByIdx = src_.indexOf("collectionItem.groupBy({ by: ['catalogId'], where: { ...baseWhere")
    const groupByCall = src_.slice(groupByIdx, groupByIdx + 150)
    expect(groupByCall).not.toMatch(/take:|cursor:/)
  })

  it('every collection query (header totals and the paginated list) is scoped by session.profileId — no cross-profile aggregation possible', () => {
    expect(src_).toContain('const baseWhere = { profileId: session.profileId }')
    const filterIdx = src_.indexOf('const filterWhere')
    const filterBlock = src_.slice(filterIdx, filterIdx + 150)
    expect(filterBlock).toContain('profileId: session.profileId')
  })
})

describe('16E: Add Another routes to the existing edit flow — no second creation path', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('Add Another links to the existing /edit route with a quantity anchor, only when a catalog match exists', () => {
    expect(src_).toContain('/account/collection/${item.id}/edit#quantity')
    expect(src_).toContain('{item.catalogId && (')
  })

  it('the quantity field on the edit form has the matching id for the anchor to land on', () => {
    const formSrc = src('src/components/store/CollectionItemForm.tsx')
    expect(formSrc).toContain('id="quantity"')
  })

  it('Add Another performs no mutation of its own — it is a plain Link, not a form/action', () => {
    const idx = src_.indexOf('Add Another')
    const context = src_.slice(idx - 300, idx)
    expect(context).not.toContain('<form')
  })
})

describe('16E: Sell One starts the existing authoritative seller workflow only', () => {
  it('Collection list page links to the existing /sell subroute — no new sell mutation on this page', () => {
    const src_ = src('src/app/(store)/account/collection/page.tsx')
    expect(src_).toContain('/account/collection/${item.id}/sell')
    const idx = src_.indexOf('Sell One')
    const context = src_.slice(idx - 300, idx)
    expect(context).not.toContain('<form')
  })

  it('submitCollectionItemForSale only creates a SellerSubmission — no ItemInstance/agreement/payout, no CollectionItem mutation', () => {
    const src_ = src('src/lib/actions/sellerSubmissions.ts')
    const fnIdx = src_.indexOf('export async function submitCollectionItemForSale')
    const nextFnIdx = src_.indexOf('export async function submitManualSellRequest')
    const fnSrc = src_.slice(fnIdx, nextFnIdx)
    expect(fnSrc).toContain('sellerSubmission.create(')
    expect(fnSrc).not.toContain('itemInstance.create')
    expect(fnSrc).not.toContain('sellerAgreement.create')
    expect(fnSrc).not.toContain('sellerPayout')
    expect(fnSrc).not.toContain('collectionItem.update')
    expect(fnSrc).not.toContain('collectionItem.delete')
  })

  it('submitCollectionItemForSale re-fetches the CollectionItem scoped to the authenticated profile — never trusts browser-supplied model/condition data', () => {
    const src_ = src('src/lib/actions/sellerSubmissions.ts')
    const fnIdx = src_.indexOf('export async function submitCollectionItemForSale')
    const fnSrc = src_.slice(fnIdx, fnIdx + 1200)
    expect(fnSrc).toContain('collectionItem.findFirst({')
    expect(fnSrc).toContain('where: { id: collectionItemId, profileId: session.profileId }')
  })

  it('sell quantity is capped at the collection item\'s own recorded quantity — cannot sell more copies than owned', () => {
    const src_ = src('src/lib/actions/sellerSubmissions.ts')
    expect(src_).toContain('Quantity cannot exceed your collection quantity')
    expect(src_).toContain('n > item.quantity')
  })

  it('a second sell request for the same item while one is already active is rejected, not silently duplicated', () => {
    const src_ = src('src/lib/actions/sellerSubmissions.ts')
    expect(src_).toContain('You already have an active sell request for this item.')
  })
})

describe('16E: View Market reuses the existing /browse destination — no second market page', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('links to /browse using the existing supported brand + q filters, only when a catalog match exists', () => {
    expect(src_).toContain('/browse?brand=${encodeURIComponent(item.catalog.brand)}&q=${encodeURIComponent(item.catalog.name)}')
    expect(src_).toContain('{item.catalog && (')
  })

  it('/browse actually supports brand and q as documented filters', () => {
    const browseSrc = src('src/app/(store)/browse/page.tsx')
    expect(browseSrc).toContain('brand?: string')
    expect(browseSrc).toContain('q?: string')
  })
})

describe('16E: accessibility — model-scoped action labels, no icon-only controls', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('Sell One / Add Another / View Market each carry an aria-label naming the specific model', () => {
    expect(src_).toContain('aria-label={`Sell one ${name}`}')
    expect(src_).toContain('aria-label={`Add another ${name}`}')
    expect(src_).toContain('aria-label={`View market for ${name}`}')
  })

  it('owned-quantity text is real visible text ("You own N"), not a decorative-only badge', () => {
    expect(src_).toContain('You own {item.quantity}')
  })
})

describe('16E: Quick Capture remains a contextual Collection action, not a new nav destination', () => {
  it('the Collection page links to /account/capture as a page-level action button', () => {
    const src_ = src('src/app/(store)/account/collection/page.tsx')
    expect(src_).toContain('href="/account/capture"')
  })

  it('AccountNav / customerNav.ts were not touched — Quick Capture is still not a CUSTOMER_ACCOUNT_LINKS entry', () => {
    const navSrc = src('src/lib/customerNav.ts')
    expect(navSrc).not.toMatch(/label:\s*'Quick Capture'/)
  })
})

describe('16E: empty state is concise, not an empty table', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('shows the preferred concise copy with exactly two primary actions', () => {
    expect(src_).toContain('Your collection is empty.')
    expect(src_).toContain('Add your first item manually or use Quick Capture.')
  })
})

describe('16E: /account overview integration is unaffected', () => {
  it('accountOverviewQuery.ts was not modified by 16E — still no valuation/hydration call for the Collection card', () => {
    const src_ = src('src/lib/accountOverviewQuery.ts')
    expect(src_).not.toMatch(/getCollectionValuation|getCatalogValuation/)
    expect(src_).toContain('collectionItem.count(')
    expect(src_).toContain("collectionItem.groupBy({ by: ['catalogId']")
  })
})

describe('16E: authorization/privacy — collection list is read-only, no PII, own-profile only', () => {
  const src_ = src('src/app/(store)/account/collection/page.tsx')

  it('the list page issues no mutation of its own during render', () => {
    expect(src_).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('every collection query is scoped by session.profileId, never a browser-supplied id', () => {
    expect(src_).toContain('profileId: session.profileId')
    expect(src_).not.toMatch(/profileId:\s*(searchParams|formData|request)/)
  })

  it('no buyer PII field is selected or rendered', () => {
    expect(src_).not.toMatch(/\.email\b|\.phone\b|\.address\b|paymentMethod/)
  })
})
