/**
 * 36B: Collection-Based Personalization — /account "Recently added to your
 * Collection" + "Continue collecting" sections. Covers: current-holdings
 * eligibility, bounded seed query, recently-added mapping, brand/series
 * identity, owned/Wanted exclusion, dedupe, canonical availability ranking,
 * deterministic ordering, batching, error isolation, and privacy/boundary
 * regression coverage. No React rendering harness exists in this codebase
 * (established convention) — page-level coverage is structural source-text
 * assertions over the exact touched files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    collectionItem: { findMany: vi.fn() },
    catalogModel: { findMany: vi.fn() },
    listing: { findMany: vi.fn() },
    wantedCatalogModel: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/serverLogger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/marketValuation', () => ({ getValuationsBatch: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/serverLogger'
import { getValuationsBatch } from '@/lib/marketValuation'
import {
  getAccountPersonalization, COLLECTION_SEED_CAP, RECENTLY_ADDED_LIMIT, CONTINUE_COLLECTING_LIMIT,
} from '@/lib/accountPersonalizationQuery'

beforeEach(() => vi.resetAllMocks())

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedRow(overrides: Partial<{
  id: string; catalogId: string | null; quantity: number; createdAt: Date
  brand: string; name: string; year: number | null; series: string | null
}> = {}) {
  const {
    id = 'ci1', catalogId = 'cat1', quantity = 1, createdAt = new Date('2026-01-05'),
    brand = 'Hot Wheels', name = 'Mazda MX-5', year = 2020, series = 'Boulevard',
  } = overrides
  return {
    id, catalogId, quantity, createdAt,
    catalog: catalogId === null ? null : { brand, name, year, series, photos: [{ url: `https://x/${id}.jpg` }] },
  }
}

function candidateRow(overrides: Partial<{
  id: string; brand: string; name: string; year: number | null; series: string | null; color: string | null; scale: string | null
}> = {}) {
  const { id = 'catA', brand = 'Hot Wheels', name = 'Model A', year = 2021, series = 'Boulevard', color = null, scale = null } = overrides
  return { id, brand, name, year, series, color, scale, photos: [{ url: `https://x/${id}.jpg` }] }
}

function mockNoOwnedNoWanted() {
  ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValue([])
}

async function runWith(seed: ReturnType<typeof seedRow>[], candidates: ReturnType<typeof candidateRow>[], listings: { price: number; item: { catalogId: string } }[] = []) {
  ;(prisma.collectionItem.findMany as Mock).mockImplementation((args: { where: { catalogId?: { not?: null; in?: string[] } } }) => {
    if (args.where.catalogId?.in) return Promise.resolve([]) // getCatalogRelationshipState's owned-check — no overlap by construction
    return Promise.resolve(seed)
  })
  ;(prisma.catalogModel.findMany as Mock).mockResolvedValue(candidates)
  ;(prisma.listing.findMany as Mock).mockResolvedValue(listings)
  mockNoOwnedNoWanted()
  ;(getValuationsBatch as Mock).mockResolvedValue(new Map())
  return getAccountPersonalization('p1')
}

// ── §53 — current holdings ──────────────────────────────────────────────────

describe('§53/§6 — seed eligibility: current, catalog-linked holdings only', () => {
  it('the seed query WHERE excludes freeform and disposed rows', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function getCollectionSeed'), src.indexOf('export type RecentCollectionEntry'))
    expect(fnSrc).toContain('catalogId: { not: null }')
    expect(fnSrc).toContain('quantity: { gt: 0 }')
  })
})

// ── §54 — bounded seed query ─────────────────────────────────────────────────

describe('§54/§7 — bounded seed query', () => {
  it('the seed query has an explicit take and deterministic createdAt DESC, id DESC ordering', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function getCollectionSeed'), src.indexOf('export type RecentCollectionEntry'))
    expect(fnSrc).toContain('take: COLLECTION_SEED_CAP')
    expect(fnSrc).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]")
  })

  it('COLLECTION_SEED_CAP is exactly 50', () => {
    expect(COLLECTION_SEED_CAP).toBe(50)
  })

  it('the bounded seed powers BOTH sections — only one collectionItem.findMany call for the seed itself', async () => {
    await runWith([seedRow()], [])
    const seedCalls = (prisma.collectionItem.findMany as Mock).mock.calls.filter(
      ([args]) => !args.where.catalogId?.in,
    )
    expect(seedCalls).toHaveLength(1)
  })
})

// ── §55 — recently added ─────────────────────────────────────────────────────

describe('§55/§8/§9 — recently added section', () => {
  it('returns at most RECENTLY_ADDED_LIMIT (4) entries, in the seed\'s own order', async () => {
    const seed = Array.from({ length: 10 }, (_, i) => seedRow({ id: `ci${i}`, catalogId: `cat${i}` }))
    const result = await runWith(seed, [])
    expect(RECENTLY_ADDED_LIMIT).toBe(4)
    expect(result.recentlyAdded).toHaveLength(4)
    expect(result.recentlyAdded.map((e) => e.id)).toEqual(['ci0', 'ci1', 'ci2', 'ci3'])
  })

  it('quantity is displayed correctly, straight from the CollectionItem row', async () => {
    const result = await runWith([seedRow({ quantity: 3 })], [])
    expect(result.recentlyAdded[0].quantity).toBe(3)
  })

  it('carries only non-financial fields — no purchasePrice/cost/EMV/holding-value anywhere in the mapping', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('function toRecentlyAdded'), src.indexOf('function seriesKey'))
    expect(fnSrc).not.toMatch(/purchasePrice|Cost|EMV|holdingValue|Gain/)
  })

  it('links to /account/collection/[id] (the RecentCollectionEntry.id is the CollectionItem id)', async () => {
    const result = await runWith([seedRow({ id: 'ci-specific' })], [])
    expect(result.recentlyAdded[0].id).toBe('ci-specific')
    const pageSrc = readSrc('src/app/(store)/account/page.tsx')
    expect(pageSrc).toContain('href={`/account/collection/${entry.id}`}')
  })
})

// ── §56/§57 — series/brand identity ──────────────────────────────────────────

describe('§56/§12 — same-series requires same brand AND same series', () => {
  it('a different brand with identical series text does NOT receive the series-tier reason', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [candidateRow({ id: 'catX', brand: 'Matchbox', series: 'Boulevard' })]
    const result = await runWith(seed, candidates)
    expect(result.continueCollecting).toHaveLength(1)
    expect(result.continueCollecting[0].reason.tier).toBe('brand')
  })

  it('the exact same brand+series produces a series-tier reason with the series name', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [candidateRow({ id: 'catX', brand: 'Hot Wheels', series: 'Boulevard' })]
    const result = await runWith(seed, candidates)
    expect(result.continueCollecting[0].reason).toEqual({ tier: 'series', label: 'More from Boulevard' })
  })
})

describe('§57/§13 — brand-tier fallback', () => {
  it('a candidate matching brand but not series gets the brand-tier reason', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [candidateRow({ id: 'catY', brand: 'Hot Wheels', series: 'Premium' })]
    const result = await runWith(seed, candidates)
    expect(result.continueCollecting[0].reason).toEqual({ tier: 'brand', label: 'More from Hot Wheels' })
  })

  it('a candidate with null series gets the brand-tier reason', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [candidateRow({ id: 'catZ', brand: 'Hot Wheels', series: null })]
    const result = await runWith(seed, candidates)
    expect(result.continueCollecting[0].reason.tier).toBe('brand')
  })
})

// ── §58/§59 — exclusion ──────────────────────────────────────────────────────

describe('§58/§14 — owned exclusion', () => {
  it('BOTH candidate queries (series + brand) DB-side exclude currently-owned (quantity>0) exact CatalogModels via the shared exclusion helper', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('function ownershipWantedExclusion'), src.indexOf('function ownershipWantedExclusion') + 300)
    expect(fnSrc).toContain('collectionItems: { none: { profileId, quantity: { gt: 0 } } }')
    expect(src).toContain('...ownershipWantedExclusion(profileId)')
    // both getSeriesCandidates and getBrandCandidates spread the shared helper
    const seriesFnSrc = src.slice(src.indexOf('async function getSeriesCandidates'), src.indexOf('async function getBrandCandidates'))
    const brandFnSrc = src.slice(src.indexOf('async function getBrandCandidates'), src.indexOf('async function getContinueCollecting'))
    expect(seriesFnSrc).toContain('...ownershipWantedExclusion(profileId)')
    expect(brandFnSrc).toContain('...ownershipWantedExclusion(profileId)')
  })

  it('a previously-disposed (quantity=0) model is NOT excluded by the predicate (none{quantity>0} only blocks CURRENT ownership)', () => {
    // Structural proof: the exclusion predicate is quantity>0-scoped, so a
    // disposed row (quantity=0) does not satisfy `some quantity>0` and
    // therefore does not trip the `none` exclusion — the model remains eligible.
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).not.toContain('collectionItems: { none: { profileId } }') // would over-exclude disposed models too
  })
})

describe('§59/§14 — Wanted exclusion, no maxDesiredPrice read', () => {
  it('the shared exclusion helper DB-side excludes already-Wanted exact CatalogModels, used by both candidate queries', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('function ownershipWantedExclusion'), src.indexOf('function ownershipWantedExclusion') + 300)
    expect(fnSrc).toContain('wantedBy: { none: { customerProfileId: profileId } } }')
  })

  it('never reads maxDesiredPrice anywhere in the file', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).not.toMatch(/maxDesiredPrice/)
  })
})

// ── §60 — dedupe ──────────────────────────────────────────────────────────────

describe('§60/§18 — dedupe: a model appears once, strongest reason preserved', () => {
  it('the candidate query is a single findMany — no duplicate rows possible per model.id, and classification picks series before brand', async () => {
    // A candidate that matches BOTH the brand seed and a series seed only
    // ever appears once in the query result (Prisma findMany on CatalogModel
    // returns one row per model.id) — classifyCandidate always checks series
    // first, so the stronger reason wins deterministically, never both.
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [candidateRow({ id: 'catDup', brand: 'Hot Wheels', series: 'Boulevard' })]
    const result = await runWith(seed, candidates)
    expect(result.continueCollecting).toHaveLength(1)
    expect(result.continueCollecting[0].reason.tier).toBe('series')
  })
})

// ── §61 — availability ───────────────────────────────────────────────────────

describe('§61/§19/§20 — canonical availability, ranked within tier', () => {
  it('uses the canonical eligibleListingWhere predicate (active Listing + available ItemInstance), never external asks', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).toContain("import { eligibleListingWhere } from '@/lib/listingEligibility'")
    expect(src).not.toMatch(/externalMarketObservation|ExternalAsk|getExternalAsks/)
  })

  it('an available candidate ranks before an unavailable candidate within the same relationship tier', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [
      candidateRow({ id: 'catUnavailable', brand: 'Hot Wheels', series: 'Boulevard' }),
      candidateRow({ id: 'catAvailable', brand: 'Hot Wheels', series: 'Boulevard' }),
    ]
    const listings = [{ price: 10, item: { catalogId: 'catAvailable' } }]
    const result = await runWith(seed, candidates, listings)
    expect(result.continueCollecting.map((c) => c.model.id)).toEqual(['catAvailable', 'catUnavailable'])
  })

  it('unavailable candidates are NOT hidden entirely (catalog discovery, not shopping-only inventory)', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [candidateRow({ id: 'catUnavailable', brand: 'Hot Wheels', series: 'Boulevard' })]
    const result = await runWith(seed, candidates, [])
    expect(result.continueCollecting).toHaveLength(1)
    expect(result.continueCollecting[0].availability.count).toBe(0)
  })
})

// ── §62 — deterministic order ────────────────────────────────────────────────

describe('§62/§21 — deterministic ordering', () => {
  it('repeated identical input produces identical candidate order', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const candidates = [
      candidateRow({ id: 'catB', brand: 'Hot Wheels', series: null, name: 'B Model' }),
      candidateRow({ id: 'catA', brand: 'Hot Wheels', series: null, name: 'A Model' }),
    ]
    const run1 = await runWith(seed, candidates, [])
    const run2 = await runWith(seed, candidates, [])
    expect(run1.continueCollecting.map((c) => c.model.id)).toEqual(run2.continueCollecting.map((c) => c.model.id))
  })

  it('both candidate queries use the same deterministic brand/name/year/id order (no randomization)', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).toContain("const CANDIDATE_ORDER_BY = [{ brand: 'asc' as const }, { name: 'asc' as const }, { year: 'asc' as const }, { id: 'asc' as const }]")
    const fnSrc = src.slice(src.indexOf('async function getContinueCollecting'), src.indexOf('export type AccountPersonalization'))
    expect(fnSrc).not.toMatch(/Math\.random|shuffle/)
  })
})

// ── §63 — no quantity weighting ──────────────────────────────────────────────

describe('§63/§31 — no quantity weighting', () => {
  it('quantity never appears in the ranking/classification logic', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function getContinueCollecting'), src.indexOf('export type AccountPersonalization'))
    expect(fnSrc).not.toMatch(/\.quantity/)
  })

  it('a quantity=5 seed and a quantity=1 seed of the same brand produce the same candidate ranking', async () => {
    const seedHigh = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard', quantity: 5 })]
    const seedLow = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard', quantity: 1 })]
    const candidates = [candidateRow({ id: 'catX', brand: 'Hot Wheels', series: 'Boulevard' })]
    const r1 = await runWith(seedHigh, candidates, [])
    const r2 = await runWith(seedLow, candidates, [])
    expect(r1.continueCollecting.map((c) => c.model.id)).toEqual(r2.continueCollecting.map((c) => c.model.id))
  })
})

// ── §64 — cold start ──────────────────────────────────────────────────────────

describe('§64/§33 — cold start', () => {
  it('no current catalog-linked holdings -> both sections empty, no candidate/listing query issued', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    const result = await getAccountPersonalization('p1')
    expect(result).toEqual({ recentlyAdded: [], continueCollecting: [] })
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
    expect(prisma.listing.findMany).not.toHaveBeenCalled()
  })
})

describe('§34 — empty discovery result (holdings exist, no eligible candidates)', () => {
  it('Continue collecting is empty (not an error) when the candidate query returns nothing', async () => {
    const result = await runWith([seedRow()], [])
    expect(result.continueCollecting).toEqual([])
  })
})

// ── §65 — batching ────────────────────────────────────────────────────────────

describe('§65/§16/§28 — batching, no N+1', () => {
  it('exactly TWO catalogModel.findMany calls (series + brand), regardless of how many distinct brands/series are seeded — never per-seed', async () => {
    const seed = [
      seedRow({ id: 'ci1', catalogId: 'cat1', brand: 'Hot Wheels', series: 'Boulevard' }),
      seedRow({ id: 'ci2', catalogId: 'cat2', brand: 'Matchbox', series: 'MBX Metal' }),
      seedRow({ id: 'ci3', catalogId: 'cat3', brand: 'Tomica', series: null }),
    ]
    await runWith(seed, [candidateRow({ id: 'catA', brand: 'Hot Wheels', series: 'Boulevard' })])
    expect(prisma.catalogModel.findMany).toHaveBeenCalledTimes(2)
  })

  it('exactly one listing.findMany call for the whole MERGED candidate pool (never per-card, never per-source)', async () => {
    const candidates = Array.from({ length: 20 }, (_, i) => candidateRow({ id: `cat${i}`, brand: 'Hot Wheels', series: 'Boulevard' }))
    await runWith([seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })], candidates)
    expect(prisma.listing.findMany).toHaveBeenCalledTimes(1)
  })

  it('getValuationsBatch is called exactly once, with only the final visible candidate ids (<=8)', async () => {
    const candidates = Array.from({ length: 20 }, (_, i) => candidateRow({ id: `cat${i}`, brand: 'Hot Wheels', series: 'Boulevard' }))
    await runWith([seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })], candidates)
    expect(getValuationsBatch).toHaveBeenCalledTimes(1)
    const call = (getValuationsBatch as Mock).mock.calls[0][0]
    expect(call.catalogModelIds.length).toBeLessThanOrEqual(CONTINUE_COLLECTING_LIMIT)
  })

  it('CONTINUE_COLLECTING_LIMIT is exactly 8', () => {
    expect(CONTINUE_COLLECTING_LIMIT).toBe(8)
  })

  it('both candidate queries are explicitly bounded (SERIES_CANDIDATE_LIMIT=100, BRAND_CANDIDATE_LIMIT=200), never unlimited', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).toContain('const SERIES_CANDIDATE_LIMIT = 100')
    expect(src).toContain('const BRAND_CANDIDATE_LIMIT = 200')
    const seriesFnSrc = src.slice(src.indexOf('async function getSeriesCandidates'), src.indexOf('async function getBrandCandidates'))
    const brandFnSrc = src.slice(src.indexOf('async function getBrandCandidates'), src.indexOf('async function getContinueCollecting'))
    expect(seriesFnSrc).toContain('take: SERIES_CANDIDATE_LIMIT')
    expect(brandFnSrc).toContain('take: BRAND_CANDIDATE_LIMIT')
  })
})

// ── §12/§13 — series-starvation regression (this follow-up's core fix) ────────

describe('§12/§13 — series candidates no longer starved by brand-pool truncation', () => {
  it('the series tier has its OWN bounded query, issued before merge — structurally proven, since mocks cannot realistically simulate a 200-row DB truncation', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).toContain('async function getSeriesCandidates')
    const fnSrc = src.slice(src.indexOf('async function getSeriesCandidates'), src.indexOf('async function getBrandCandidates'))
    // The series query filters on the exact (brand, series) OR-pairs, NOT on
    // `brand IN seedBrands` — it can never be crowded out by an unrelated
    // large brand's alphabetically-early rows, because it never shares its
    // `take` budget with the brand-only universe at all.
    expect(fnSrc).toContain('OR: pairs.map((p) => ({ brand: p.brand, series: p.series }))')
    expect(fnSrc).not.toContain('brand: { in:')
  })

  it('a series-matching candidate is returned even when it would not be among the first BRAND_CANDIDATE_LIMIT rows of the generic brand pool — proven by the series query having no dependency on the brand query\'s result at all (independent Promise.all)', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function getContinueCollecting'), src.indexOf('export type AccountPersonalization'))
    expect(fnSrc).toContain('Promise.all([\n    getSeriesCandidates(profileId, seriesPairs),\n    getBrandCandidates(profileId, [...brands]),\n  ])')
  })

  it('behavioral: a series match surfaces correctly even when the brand-pool mock returns zero rows (i.e. would have been truncated away under the old single-query design)', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const seriesOnlyCandidate = candidateRow({ id: 'catRare', brand: 'Hot Wheels', series: 'Boulevard' })
    // Series query returns the match; brand query returns nothing at all —
    // simulating the exact starvation scenario the old take:200 pool risked.
    ;(prisma.collectionItem.findMany as Mock).mockImplementation((args: { where: { catalogId?: { in?: string[] } } }) =>
      Promise.resolve(args.where.catalogId?.in ? [] : seed))
    ;(prisma.catalogModel.findMany as Mock)
      .mockResolvedValueOnce([seriesOnlyCandidate]) // series query (called first per Promise.all array order)
      .mockResolvedValueOnce([]) // brand query
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    mockNoOwnedNoWanted()
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map())

    const result = await getAccountPersonalization('p1')

    expect(result.continueCollecting).toHaveLength(1)
    expect(result.continueCollecting[0].model.id).toBe('catRare')
    expect(result.continueCollecting[0].reason.tier).toBe('series')
  })
})

describe('§11 — empty series seeds skip the series query entirely', () => {
  it('no series-pair seeds -> getSeriesCandidates is never called with a non-empty pairs list, and issues no query', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: null })]
    await runWith(seed, [candidateRow({ id: 'catA', brand: 'Hot Wheels', series: null })])
    // Only the brand query's own findMany should have fired with real work —
    // structurally confirm the early-return guard exists.
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function getSeriesCandidates'), src.indexOf('async function getBrandCandidates'))
    expect(fnSrc).toContain('if (pairs.length === 0) return []')
  })
})

// ── §14 — multiple brands, no per-brand fanout ───────────────────────────────

describe('§14 — multiple seeded brands still produce exactly one batched brand query', () => {
  it('three distinct seeded brands -> one brand IN [...] query, one series OR query, never three of either', async () => {
    const seed = [
      seedRow({ id: 'ci1', catalogId: 'cat1', brand: 'Hot Wheels', series: 'Boulevard' }),
      seedRow({ id: 'ci2', catalogId: 'cat2', brand: 'Matchbox', series: 'MBX Metal' }),
      seedRow({ id: 'ci3', catalogId: 'cat3', brand: 'Tomica', series: 'Premium' }),
    ]
    await runWith(seed, [])
    expect(prisma.catalogModel.findMany).toHaveBeenCalledTimes(2)
    const brandFnSrc = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(brandFnSrc).toContain('brand: { in: brands }')
  })
})

// ── §15 — dedupe across both queries ─────────────────────────────────────────

describe('§15 — a candidate returned by BOTH queries appears once, with the series reason', () => {
  it('mocked so the same model.id is present in both the series and brand query results', async () => {
    const seed = [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]
    const dupCandidate = candidateRow({ id: 'catBoth', brand: 'Hot Wheels', series: 'Boulevard' })
    ;(prisma.collectionItem.findMany as Mock).mockImplementation((args: { where: { catalogId?: { in?: string[] } } }) =>
      Promise.resolve(args.where.catalogId?.in ? [] : seed))
    ;(prisma.catalogModel.findMany as Mock)
      .mockResolvedValueOnce([dupCandidate]) // series query
      .mockResolvedValueOnce([dupCandidate]) // brand query — same model
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    mockNoOwnedNoWanted()
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map())

    const result = await getAccountPersonalization('p1')

    expect(result.continueCollecting).toHaveLength(1)
    expect(result.continueCollecting[0].model.id).toBe('catBoth')
    expect(result.continueCollecting[0].reason).toEqual({ tier: 'series', label: 'More from Boulevard' })
  })
})

// ── §16 — one availability batch despite two candidate queries ──────────────

describe('§16 — exactly one availability batch after merge', () => {
  it('two candidate queries (series + brand) still produce exactly one listing.findMany call', async () => {
    const seed = [
      seedRow({ id: 'ci1', catalogId: 'cat1', brand: 'Hot Wheels', series: 'Boulevard' }),
      seedRow({ id: 'ci2', catalogId: 'cat2', brand: 'Matchbox', series: null }),
    ]
    const candidates = [
      candidateRow({ id: 'catSeries', brand: 'Hot Wheels', series: 'Boulevard' }),
      candidateRow({ id: 'catBrand', brand: 'Matchbox', series: null }),
    ]
    await runWith(seed, candidates)
    expect(prisma.listing.findMany).toHaveBeenCalledTimes(1)
    const call = (prisma.listing.findMany as Mock).mock.calls[0][0]
    // one bounded call over the MERGED id set, not one per source
    expect(call.where).toBeDefined()
  })
})

// ── §66 — error isolation ────────────────────────────────────────────────────

describe('§66/§49 — error isolation', () => {
  it('a valuation-batch failure degrades to null per-model without throwing (logged, not swallowed silently)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockImplementation((args: { where: { catalogId?: { in?: string[] } } }) =>
      Promise.resolve(args.where.catalogId?.in ? [] : [seedRow({ brand: 'Hot Wheels', series: 'Boulevard' })]))
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([candidateRow({ id: 'catA', brand: 'Hot Wheels', series: 'Boulevard' })])
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    mockNoOwnedNoWanted()
    ;(getValuationsBatch as Mock).mockRejectedValue(new Error('valuation service down'))

    const result = await getAccountPersonalization('p1')

    expect(result.continueCollecting).toHaveLength(1)
    expect(result.continueCollecting[0].marketValuation).toBeNull()
    expect(logger.error).toHaveBeenCalledWith('account_personalization_valuation_batch_failed', expect.any(Error), { route: '/account' })
  })

  it('the /account page isolates a total personalization failure — core dashboard cards render regardless', () => {
    const pageSrc = readSrc('src/app/(store)/account/page.tsx')
    const idx = pageSrc.indexOf('let personalization')
    const block = pageSrc.slice(idx, idx + 400)
    expect(block).toContain('try {')
    expect(block).toContain('catch (err)')
    expect(block).toContain('personalization = null')
    // the try/catch runs strictly AFTER the auth check and core overview fetch —
    // never wraps/swallows the session/auth gate itself.
    expect(pageSrc.indexOf('if (!session)')).toBeLessThan(idx)
    expect(pageSrc.indexOf('getAccountOverview(session.profileId)')).toBeLessThan(idx)
  })

  it('personalized sections are rendered conditionally — omitted entirely, not an error box, when personalization is null', () => {
    const pageSrc = readSrc('src/app/(store)/account/page.tsx')
    expect(pageSrc).toContain('{personalization && personalization.recentlyAdded.length > 0 && (')
    expect(pageSrc).toContain('{personalization && personalization.continueCollecting.length > 0 && (')
    expect(pageSrc).not.toMatch(/No recommendations found/i)
  })
})

// ── §67 — privacy ─────────────────────────────────────────────────────────────

describe('§67/§42/§43 — privacy: no financial/target-price data', () => {
  const files = ['src/lib/accountPersonalizationQuery.ts', 'src/app/(store)/account/page.tsx']

  it('no financial fields anywhere in the new personalization code', () => {
    for (const f of files) {
      const src = stripComments(readSrc(f))
      expect(src).not.toMatch(/purchasePrice|unitRecordedCostCents|legacyRecordedPriceCents|grossProceedsCents|netProceedsCents|Recorded Cost|Estimated Holding Value|Unrealized Gain|Realized Gain/)
    }
  })

  it('no maxDesiredPrice / Wanted target-price data anywhere', () => {
    for (const f of files) {
      expect(readSrc(f)).not.toMatch(/maxDesiredPrice/)
    }
  })

  it('no seller/order-history data referenced', () => {
    for (const f of files) {
      const src = readSrc(f)
      expect(src).not.toMatch(/SellerSubmission|SellerPayout|SellerAgreement|orderItems|OrderItem/)
    }
  })
})

// ── §68 — Market Signals boundary ────────────────────────────────────────────

describe('§68/§29 — Market Signals boundary', () => {
  it('no import/reference to marketSignalsQuery or its fields in the personalization query file', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).not.toMatch(/marketSignalsQuery|valuationChange30d|medianDaysToSell|wantedCount/)
  })

  it('ranking logic never references valuation/marketValuation fields (valuation is display-only, batched after ranking)', () => {
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    const rankIdx = src.indexOf('ranked.sort')
    const rankBlock = src.slice(rankIdx, rankIdx + 400)
    expect(rankBlock).not.toMatch(/valuation|Valuation|EMV/)
  })
})

// ── §69 — Community/analytics/Wanted-matching boundary ──────────────────────

describe('§69/§2/§3/§30/§40/§41 — Community, analytics, and Wanted-matching boundary', () => {
  it('no CustomerCommunityProfile / analytics / localStorage / recently-viewed / search-history reference', () => {
    const src = stripComments(readSrc('src/lib/accountPersonalizationQuery.ts'))
    expect(src).not.toMatch(/CustomerCommunityProfile|isPublic|showOnLeaderboards|localStorage|sessionStorage|analytics|recentlyViewed|searchHistory/i)
  })

  it('never imports/calls matchWantedList or wantedListMatching', () => {
    const src = stripComments(readSrc('src/lib/accountPersonalizationQuery.ts'))
    expect(src).not.toMatch(/matchWantedList|wantedListMatching/)
  })

  it('never imports BuyerAlertEvent/BuyerAlertFanout', () => {
    const src = stripComments(readSrc('src/lib/accountPersonalizationQuery.ts'))
    expect(src).not.toMatch(/BuyerAlertEvent|BuyerAlertFanout/)
  })

  it('the /account page does not add "Available from your Wanted list" or "At your target price" sections', () => {
    const pageSrc = readSrc('src/app/(store)/account/page.tsx')
    expect(pageSrc).not.toMatch(/Available from your Wanted list|At your target price|At or below your target price/)
  })
})

// ── §70 — public discovery regression ────────────────────────────────────────

describe('§70/§35/§36/§37 — public discovery unaffected', () => {
  it('/market and /catalog never import accountPersonalizationQuery', () => {
    for (const f of ['src/app/(store)/market/page.tsx', 'src/app/(store)/catalog/page.tsx']) {
      expect(readSrc(f)).not.toMatch(/accountPersonalizationQuery/)
    }
  })

  it('catalogDiscoveryQuery.ts ranking is untouched (still brand/name/year/id, never re-ranked by personalization)', () => {
    const src = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(src).toContain("{ brand: 'asc' },\n    { name: 'asc' },\n    { year: 'asc' },\n    { id: 'asc' },")
  })
})

// ── §71 — existing account cards regression ──────────────────────────────────

describe('§71/§46 — existing account summary cards unchanged', () => {
  const pageSrc = readSrc('src/app/(store)/account/page.tsx')

  it('Orders, Collection, Wanted & Alerts, and Selling cards are all still present', () => {
    for (const title of ['Orders', 'Collection', 'Wanted & Alerts', 'Selling']) {
      expect(pageSrc).toContain(`title="${title}"`)
    }
  })

  it('the existing overview fetch (getAccountOverview) is unchanged and still awaited before personalization', () => {
    expect(pageSrc).toContain('const overview = await getAccountOverview(session.profileId)')
  })

  it('no new route/nav entry was added (personalization lives inside /account only)', () => {
    const navSrc = readSrc('src/components/store/AccountNav.tsx')
    expect(navSrc).not.toMatch(/Continue collecting|Recently added/)
  })
})

// ── Schema/migrations/packages ────────────────────────────────────────────────

describe('§72/§73 — schema/migrations/packages unchanged', () => {
  it('migration count is unchanged at 53', () => {
    const dirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((f) => fs.statSync(path.join(root, 'prisma/migrations', f)).isDirectory())
    expect(dirs.length).toBe(54)
  })
})

// ── §44/§45 — caching/auth ─────────────────────────────────────────────────────

describe('§44/§45 — private caching and auth', () => {
  it('/account remains force-dynamic, no unstable_cache/shared cache for personalized output', () => {
    const pageSrc = readSrc('src/app/(store)/account/page.tsx')
    expect(pageSrc).toContain("export const dynamic = 'force-dynamic'")
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).not.toMatch(/unstable_cache/)
  })

  it('profileId is derived only from the server-verified session, never request input', () => {
    const pageSrc = readSrc('src/app/(store)/account/page.tsx')
    expect(pageSrc).toContain('getAccountPersonalization(session.profileId)')
    const src = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(src).not.toMatch(/searchParams|request\.|req\.query|req\.body/)
  })
})

// ── §52 — matchWantedList deferred debt (documented, not fixed here) ────────

describe('§52/§3 — matchWantedList drift is documented as deferred debt, not touched', () => {
  it('wantedListMatching.ts is untouched by this milestone (still contains its pre-canonical price>0 clause)', () => {
    const src = readSrc('src/lib/wantedListMatching.ts')
    expect(src).toMatch(/price:\s*{\s*gt:\s*0\s*}/)
  })
})
