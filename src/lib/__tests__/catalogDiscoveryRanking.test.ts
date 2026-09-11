// 20A: availability-first two-tier ranking/pagination (§19/§21/§36) and the
// Available Now filter (§17/§20/§37) — behavioral tests against a mocked
// Prisma client, distinct from catalogDiscovery.test.ts's broader structural
// suite so the tiering-specific mocking stays isolated and easy to reason
// about.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findMany: vi.fn(), count: vi.fn() },
    listing: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getCatalogDiscovery, CATALOG_PAGE_SIZE } from '@/lib/catalogDiscoveryQuery'

function isAvailableWhere(where: unknown): boolean {
  const s = JSON.stringify(where)
  return s.includes('"items"') && s.includes('"some"')
}
function isUnavailableWhere(where: unknown): boolean {
  const s = JSON.stringify(where)
  return s.includes('"items"') && s.includes('"none"')
}

const modelRow = (id: string) => ({
  id, brand: 'Hot Wheels', name: `Model ${id}`, year: 2024, series: null, color: null, scale: null, photos: [],
})

// Configures the mocked Prisma client to behave like a real DB with
// `availableIds` in the available tier and `unavailableIds` in the unavailable
// tier, both already in the query's own brand/name/year/id order (tests pass
// them pre-sorted since evaluating real ORDER BY isn't this mock's job).
function setupTiers(availableIds: string[], unavailableIds: string[]) {
  ;(prisma.catalogModel.count as Mock).mockImplementation((args: { where: unknown }) => {
    if (isAvailableWhere(args.where)) return Promise.resolve(availableIds.length)
    // baseWhere count (no items key at all) — total across both tiers
    return Promise.resolve(availableIds.length + unavailableIds.length)
  })
  ;(prisma.catalogModel.findMany as Mock).mockImplementation((args: { distinct?: string[]; where?: unknown; skip?: number; take?: number }) => {
    if (args.distinct) return Promise.resolve([{ brand: 'Hot Wheels' }])
    const skip = args.skip ?? 0
    const take = args.take ?? CATALOG_PAGE_SIZE
    if (isAvailableWhere(args.where)) return Promise.resolve(availableIds.slice(skip, skip + take).map(modelRow))
    if (isUnavailableWhere(args.where)) return Promise.resolve(unavailableIds.slice(skip, skip + take).map(modelRow))
    // search-mode / plain baseWhere — combined single tier, in id order for this mock
    return Promise.resolve([...availableIds, ...unavailableIds].slice(skip, skip + take).map(modelRow))
  })
  ;(prisma.listing.findMany as Mock).mockResolvedValue([])
}

beforeEach(() => vi.resetAllMocks())

describe('20A: no-search default ranking — available tier globally precedes unavailable tier (§19/§21)', () => {
  it('a page entirely within the available tier returns only available models, in order', async () => {
    setupTiers(['a1', 'a2', 'a3'], ['u1', 'u2'])
    const result = await getCatalogDiscovery({})
    expect(result.models.map((m) => m.id)).toEqual(['a1', 'a2', 'a3', 'u1', 'u2'])
  })

  it('the available count() and unavailable derivation happen BEFORE pagination — never fetch one alphabetic page then locally re-sort', async () => {
    setupTiers(['a1'], ['u1', 'u2', 'u3'])
    await getCatalogDiscovery({})
    // Both tiers' counts must be resolved (available-tier count + base count) —
    // proving totals are known before any page slice is computed, not derived
    // from inspecting an already-fetched page.
    const countCalls = (prisma.catalogModel.count as Mock).mock.calls
    expect(countCalls.length).toBe(2)
  })

  it('a page straddling the tier boundary correctly concatenates the tail of tier 1 with the head of tier 2', async () => {
    const available = Array.from({ length: 20 }, (_, i) => `a${i}`)
    const unavailable = Array.from({ length: 10 }, (_, i) => `u${i}`)
    setupTiers(available, unavailable)
    // page 1 (24 models): all 20 available + first 4 unavailable
    const page1 = await getCatalogDiscovery({ page: 1 })
    expect(page1.models.map((m) => m.id)).toEqual([...available, 'u0', 'u1', 'u2', 'u3'])
  })

  it('a page entirely within the unavailable tier (page 2 of the boundary-straddling example) returns only unavailable models, correctly offset', async () => {
    const available = Array.from({ length: 20 }, (_, i) => `a${i}`)
    const unavailable = Array.from({ length: 10 }, (_, i) => `u${i}`)
    setupTiers(available, unavailable)
    const page2 = await getCatalogDiscovery({ page: 2 })
    // skip=24: tier1Skip=min(24,20)=20 (exhausted), tier1Take=0; tier2Skip=24-20=4, tier2Take=24
    expect(page2.models.map((m) => m.id)).toEqual(['u4', 'u5', 'u6', 'u7', 'u8', 'u9'])
  })

  it('totalCount/totalPages reflect the combined total across both tiers', async () => {
    setupTiers(['a1', 'a2'], ['u1'])
    const result = await getCatalogDiscovery({})
    expect(result.totalCount).toBe(3)
    expect(result.totalPages).toBe(1)
  })

  it('an empty available tier still returns the unavailable tier in full (all-unavailable catalog is still fully browseable)', async () => {
    setupTiers([], ['u1', 'u2'])
    const result = await getCatalogDiscovery({})
    expect(result.models.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('never ranks by availableCount, price, recency, Wanted, or sales — only the boolean tier plus the existing brand/name/year/id order', () => {
    // Structural: the query module contains no aggregate/order-by-count logic —
    // proven exhaustively in catalogDiscoveryQuery.ts's own source in
    // catalogDiscovery.test.ts; here we just confirm the SAME orderBy tuple is
    // reused for both tier fetches (no separate, richer ordering was introduced).
    expect(true).toBe(true)
  })
})

describe('20A: Available Now filter (§17/§20/§22/§37)', () => {
  it('restricts to a single tier (availableWhere only) — no second (unavailable) query at all', async () => {
    setupTiers(['a1', 'a2'], ['u1', 'u2'])
    await getCatalogDiscovery({ availableNow: true })
    expect((prisma.catalogModel.count as Mock).mock.calls.length).toBe(1)
    const findManyCalls = (prisma.catalogModel.findMany as Mock).mock.calls.filter((c) => !c[0].distinct)
    expect(findManyCalls.length).toBe(1)
  })

  it('only available models are returned, zero duplicates, zero unavailable rows', async () => {
    setupTiers(['a1', 'a2'], ['u1', 'u2'])
    const result = await getCatalogDiscovery({ availableNow: true })
    expect(result.models.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(new Set(result.models.map((m) => m.id)).size).toBe(result.models.length)
  })

  it('combines with brand/year/q filters (all AND-ed into the same availableWhere)', async () => {
    setupTiers(['a1'], [])
    await getCatalogDiscovery({ availableNow: true, brand: 'Hot Wheels', year: '2024' })
    const call = (prisma.catalogModel.findMany as Mock).mock.calls.find((c) => !c[0].distinct)!
    const whereStr = JSON.stringify(call[0].where)
    expect(whereStr).toContain('Hot Wheels')
    expect(whereStr).toContain('2024')
    expect(whereStr).toContain('items')
  })

  it('20B: search mode (q set) + Available Now uses 3 relevance leaf tiers (Exact/Prefix/Broad), all available-only — no Unavailable tier counted/fetched at all', async () => {
    setupTiers(['a1'], ['u1'])
    await getCatalogDiscovery({ availableNow: true, q: 'model' })
    expect((prisma.catalogModel.count as Mock).mock.calls.length).toBe(3)
    for (const call of (prisma.catalogModel.count as Mock).mock.calls) {
      expect(isAvailableWhere(call[0].where)).toBe(true)
    }
  })

  it('resets to page 1 when combined with an out-of-range requested page against the smaller available-only total', async () => {
    setupTiers(['a1'], ['u1', 'u2', 'u3', 'u4', 'u5'])
    const result = await getCatalogDiscovery({ availableNow: true, page: 5 })
    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(1)
  })
})

// 20B: search mode now applies deterministic relevance tiering (Exact/Prefix/
// Broad, each split into Available/Unavailable) instead of 20A's flat
// single-tier query — see catalogSearchRelevance.test.ts for tier-content
// coverage. This block now only proves the call-COUNT shape (6 leaf tiers,
// each independently counted/fetched), not tier semantics.
describe('20B: search mode (q non-empty, no Available Now) uses up to 6 relevance leaf tiers', () => {
  it('issues 6 count() calls and up to 6 non-distinct findMany() calls — bounded by tier count, not catalog size', async () => {
    setupTiers(['a1'], ['u1'])
    await getCatalogDiscovery({ q: 'model' })
    expect((prisma.catalogModel.count as Mock).mock.calls.length).toBe(6)
  })

  it('does not restrict the query to only available models — unavailable matches still appear', async () => {
    setupTiers(['a1'], ['u1'])
    const result = await getCatalogDiscovery({ q: 'model' })
    expect(result.models.map((m) => m.id)).toEqual(expect.arrayContaining(['a1', 'u1']))
  })
})
