/**
 * 16J: public CatalogModel discovery (/catalog). Behavioral tests for the query
 * layer (mocked Prisma) plus structural/source-regex checks for the page/
 * components, mirroring the 16H/16I test convention.
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
    catalogModel: { findMany: vi.fn(), count: vi.fn() },
    listing: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getCatalogDiscovery, CATALOG_PAGE_SIZE } from '@/lib/catalogDiscoveryQuery'
import { eligibleListingWhere } from '@/lib/listingEligibility'

function mockPage(modelRows: unknown[], brandRows: { brand: string }[] = [{ brand: 'Hot Wheels' }]) {
  ;(prisma.catalogModel.findMany as Mock).mockImplementation((args: { distinct?: string[] }) => {
    if (args.distinct) return Promise.resolve(brandRows)
    return Promise.resolve(modelRows)
  })
}

// Evaluates a Prisma-shaped where clause (AND/OR/contains/equality leaves only —
// the exact shape getCatalogDiscovery produces) against a plain object, so
// multi-token AND/OR semantics can be proven without a real database.
type FakeModel = { brand: string; name: string; series: string | null; year: number | null; color: string | null; scale: string | null }
type WhereNode = { AND?: WhereNode[]; OR?: WhereNode[] } & Record<string, unknown>
function evalWhere(where: WhereNode, model: FakeModel): boolean {
  if (where.AND) return where.AND.every((c) => evalWhere(c, model))
  if (where.OR) return where.OR.some((c) => evalWhere(c, model))
  const [field, cond] = Object.entries(where)[0] as [keyof FakeModel, unknown]
  const value = model[field]
  if (cond && typeof cond === 'object' && 'contains' in (cond as Record<string, unknown>)) {
    if (value === null || value === undefined) return false
    return String(value).toLowerCase().includes(String((cond as { contains: string }).contains).toLowerCase())
  }
  return value === cond
}

const modelRow = (over: Partial<{ id: string; brand: string; name: string; year: number | null; series: string | null; color: string | null; scale: string | null }> = {}) => ({
  id: 'cat1', brand: 'Hot Wheels', name: 'Porsche 911', year: 2024, series: null, color: null, scale: null, photos: [],
  ...over,
})

beforeEach(() => vi.resetAllMocks())

// ── Part A findings, encoded as behavioral proof ────────────────────────────────

describe('16J: eligibility predicate — no CatalogModel status/public field exists', () => {
  it('CatalogModel schema has no active/inactive/deleted/suppressed/public field (only identity fields)', () => {
    const schema = readSrc('prisma/schema.prisma')
    const modelBlock = schema.slice(schema.indexOf('model CatalogModel {'), schema.indexOf('model CatalogModelMergeAudit'))
    expect(modelBlock).not.toMatch(/status|isPublic|isActive|deletedAt|suppressed/i)
  })

  it('duplicate merges delete the losing row outright (mergeCatalogModels) — no soft-delete/suppression flag to filter on', () => {
    const catalogActions = readSrc('src/lib/actions/catalog.ts')
    expect(catalogActions).toContain('tx.catalogModel.delete({ where: { id: dupeId } })')
  })

  it('unreviewed candidates (CatalogSuggestion) live in a separate table, never mixed into CatalogModel', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toContain('model CatalogSuggestion {')
    // CatalogSuggestion has its own review status; it is not a CatalogModel row.
    const suggestionBlock = schema.slice(schema.indexOf('model CatalogSuggestion {'), schema.indexOf('model CatalogSuggestion {') + 700)
    expect(suggestionBlock).toContain('approvedCatalogId')
  })

  it('getCatalogDiscovery applies no status/isPublic filter to CatalogModel — every row is the discoverable set', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    await getCatalogDiscovery({})

    const countWhere = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    expect(countWhere).toEqual({})
  })
})

// ── Part D: zero-listing discoverability (defining test) ───────────────────────

describe('16J: zero-Listing CatalogModel is discoverable (Part D defining behavior)', () => {
  it('a model with zero eligible Listings appears in results with count:0, lowestPrice:null', async () => {
    mockPage([modelRow({ id: 'catB', brand: 'Matchbox', name: 'Zero Copies' })])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(1)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await getCatalogDiscovery({})

    expect(result.models).toHaveLength(1)
    expect(result.models[0].id).toBe('catB')
    expect(result.availabilityByModel.get('catB')).toEqual({ count: 0, lowestPrice: null })
  })
})

// ── Part AY: available model, exact eligible-set counting ──────────────────────

describe('16J: availability counts/prices only the exact eligible Listing set', () => {
  it('reduces count and min price from listing.findMany rows, scoped by item.catalogId', async () => {
    mockPage([modelRow({ id: 'catA' })])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(1)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      { price: 9, item: { catalogId: 'catA' } },
      { price: 7.5, item: { catalogId: 'catA' } },
      { price: 10, item: { catalogId: 'catA' } },
    ])

    const result = await getCatalogDiscovery({})

    expect(result.availabilityByModel.get('catA')).toEqual({ count: 3, lowestPrice: 7.5 })
  })

  it('passes the exact 16H/16J-shared eligibility predicate (status active, item available) scoped to the page model ids — this is what excludes sold/inactive/unavailable rows at the DB level', async () => {
    mockPage([modelRow({ id: 'catA' }), modelRow({ id: 'catB' })])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(2)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    await getCatalogDiscovery({})

    const call = (prisma.listing.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual(eligibleListingWhere(['catA', 'catB']))
  })

  it('a model with no matching rows in the eligible-Listing result keeps count:0, not undefined', async () => {
    mockPage([modelRow({ id: 'catA' }), modelRow({ id: 'catB' })])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(2)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([{ price: 5, item: { catalogId: 'catA' } }])

    const result = await getCatalogDiscovery({})
    expect(result.availabilityByModel.get('catB')).toEqual({ count: 0, lowestPrice: null })
  })
})

// ── Part O/AZ: no N+1 ────────────────────────────────────────────────────────────

describe('16J: no N+1 — one page-scoped availability query regardless of page size', () => {
  it('calls prisma.listing.findMany exactly once for a full 24-model page', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => modelRow({ id: `cat${i}` }))
    mockPage(rows)
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(24)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    await getCatalogDiscovery({})

    expect((prisma.listing.findMany as Mock).mock.calls.length).toBe(1)
  })

  it('issues zero Listing queries when the page has zero models', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({})

    expect(prisma.listing.findMany).not.toHaveBeenCalled()
  })

  it('the availability query selects only price and item.catalogId — no seller/financial/location fields', async () => {
    mockPage([modelRow()])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(1)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    await getCatalogDiscovery({})

    const call = (prisma.listing.findMany as Mock).mock.calls[0][0]
    expect(call.select).toEqual({ price: true, item: { select: { catalogId: true } } })
  })
})

// ── Part F/G/BA: search ──────────────────────────────────────────────────────────

describe('16J: search — case-insensitive text match across identity fields only', () => {
  it('q searches brand/name/series/color/scale with insensitive mode', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ q: 'mazda' })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    const orClauses = where.AND[0].OR
    expect(orClauses).toContainEqual({ brand: { contains: 'mazda', mode: 'insensitive' } })
    expect(orClauses).toContainEqual({ name: { contains: 'mazda', mode: 'insensitive' } })
    expect(orClauses).toContainEqual({ series: { contains: 'mazda', mode: 'insensitive' } })
    expect(orClauses).toContainEqual({ color: { contains: 'mazda', mode: 'insensitive' } })
    expect(orClauses).toContainEqual({ scale: { contains: 'mazda', mode: 'insensitive' } })
  })

  it('never searches internal/admin fields (notes)', async () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(querySrc).not.toMatch(/notes:/)
  })

  it('a clean 4-digit q also matches year exactly', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ q: '2022' })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    const orClauses = where.AND[0].OR
    expect(orClauses).toContainEqual({ year: 2022 })
  })

  it('a non-4-digit numeric-looking q does not add a year clause', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ q: '22' })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    const orClauses = where.AND[0].OR
    expect(orClauses.some((c: Record<string, unknown>) => 'year' in c)).toBe(false)
  })

  it('empty/whitespace q adds no text predicate', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ q: '   ' })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    expect(where).toEqual({})
  })

  it('q is capped at 100 characters', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ q: 'x'.repeat(500) })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    const clause = where.AND[0].OR[0] as { brand: { contains: string } }
    expect(clause.brand.contains.length).toBe(100)
  })
})

// ── 16J-verify: multi-token search — AND across tokens, OR across fields ────────

describe('16J-verify: cross-field multi-token search semantics', () => {
  const mazdaModel: FakeModel = { brand: 'Hot Wheels', name: "'16 Mazda MX-5 Miata", series: 'HW Modified', year: 2022, color: null, scale: null }
  const unrelatedModel: FakeModel = { brand: 'Matchbox', name: 'Ford Focus', series: null, year: 2019, color: null, scale: null }

  async function whereFor(q: string) {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)
    await getCatalogDiscovery({ q })
    return (prisma.catalogModel.count as Mock).mock.calls.at(-1)![0].where as WhereNode
  }

  it('single-token q="mazda" matches via name alone', async () => {
    const where = await whereFor('mazda')
    expect(evalWhere(where, mazdaModel)).toBe(true)
    expect(evalWhere(where, unrelatedModel)).toBe(false)
  })

  it('phrase contained in one field — q="hot wheels" matches via brand alone (tokenized as two AND-ed tokens, both satisfied by the same field)', async () => {
    const where = await whereFor('hot wheels')
    expect(evalWhere(where, mazdaModel)).toBe(true)
  })

  it('q="hot wheels mazda" — tokens span brand ("hot", "wheels") + name ("mazda") — matches', async () => {
    const where = await whereFor('hot wheels mazda')
    expect(evalWhere(where, mazdaModel)).toBe(true)
    expect(evalWhere(where, unrelatedModel)).toBe(false)
  })

  it('q="mazda mx-5" — both tokens match within name — matches', async () => {
    const where = await whereFor('mazda mx-5')
    expect(evalWhere(where, mazdaModel)).toBe(true)
  })

  it('q="hot wheels" spanning brand + series-adjacent model still matches when a token only appears in series', async () => {
    const where = await whereFor('modified mazda')
    // "modified" only appears in series, "mazda" only in name — proves tokens can
    // span brand/name/series in any combination, not just brand+name.
    expect(evalWhere(where, mazdaModel)).toBe(true)
  })

  it('whitespace normalization — "  mazda   " produces the identical predicate to "mazda"', async () => {
    const whereA = await whereFor('  mazda   ')
    const whereB = await whereFor('mazda')
    expect(whereA).toEqual(whereB)
  })

  it('a token absent from every field causes no match (AND semantics, not OR-of-tokens)', async () => {
    const where = await whereFor('mazda toyota')
    expect(evalWhere(where, mazdaModel)).toBe(false)
  })

  it('token count is capped at MAX_SEARCH_TOKENS (8) — a long query does not balloon into unbounded nested predicates', async () => {
    const manyWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
    const where = await whereFor(manyWords)
    expect(where.AND).toHaveLength(8)
  })

  it('malformed/short numeric tokens never become year=0 or an unintended year match', async () => {
    const where = await whereFor('a1 22 mazda')
    // "a1" and "22" are not clean 4-digit years — neither should produce a year clause
    const yearClauses = where.AND!.flatMap((c) => (c.OR ?? []).filter((f) => 'year' in f))
    expect(yearClauses).toHaveLength(0)
  })

  it('a genuine 4-digit token still matches by year OR by text, exactly as the single-token case did', async () => {
    const where = await whereFor('mazda 2022')
    expect(evalWhere(where, mazdaModel)).toBe(true)
    const yearToken = mazdaModel.year
    expect(evalWhere(where, { ...unrelatedModel, year: yearToken, name: 'Something else' })).toBe(false) // still needs "mazda" token too
  })
})

// ── 16J-verify: search + explicit filter combination (AND) ──────────────────────

describe('16J-verify: q combines with brand/year filters using AND semantics', () => {
  const mazdaModel: FakeModel = { brand: 'Hot Wheels', name: "'16 Mazda MX-5 Miata", series: null, year: 2022, color: null, scale: null }

  async function whereFor(params: { q?: string; brand?: string; year?: string }) {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)
    await getCatalogDiscovery(params)
    return (prisma.catalogModel.count as Mock).mock.calls.at(-1)![0].where as WhereNode
  }

  it('q=mazda&brand=Hot Wheels → matches', async () => {
    const where = await whereFor({ q: 'mazda', brand: 'Hot Wheels' })
    expect(evalWhere(where, mazdaModel)).toBe(true)
  })

  it('q=mazda&brand=Matchbox → does not match (brand filter is an exact AND-ed condition, independent of q)', async () => {
    const where = await whereFor({ q: 'mazda', brand: 'Matchbox' })
    expect(evalWhere(where, mazdaModel)).toBe(false)
  })

  it('q="hot wheels mazda"&year=2022 → matches once tokenized search is applied', async () => {
    const where = await whereFor({ q: 'hot wheels mazda', year: '2022' })
    expect(evalWhere(where, mazdaModel)).toBe(true)
  })

  it('q="hot wheels mazda"&year=2019 (nonmatching explicit filter) → does not match', async () => {
    const where = await whereFor({ q: 'hot wheels mazda', year: '2019' })
    expect(evalWhere(where, mazdaModel)).toBe(false)
  })
})

// ── 16J-verify: zero-listing model remains searchable ────────────────────────────

describe('16J-verify: a matching zero-Listing model still appears under multi-token search', () => {
  it('search results are CatalogModel-driven — no Listing-existence condition is added to the model query', async () => {
    mockPage([modelRow({ id: 'catZ', brand: 'Hot Wheels', name: "'16 Mazda MX-5 Miata" })])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(1)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await getCatalogDiscovery({ q: 'hot wheels mazda' })

    expect(result.models.map((m) => m.id)).toContain('catZ')
    expect(result.availabilityByModel.get('catZ')).toEqual({ count: 0, lowestPrice: null })

    const modelQueryCall = (prisma.catalogModel.count as Mock).mock.calls[0][0]
    expect(JSON.stringify(modelQueryCall.where)).not.toMatch(/listing|item/i)
  })
})

// ── 16J-verify: pagination preserves normalized search state ────────────────────

describe('16J-verify: search submission resets page; pagination preserves normalized q/brand/year', () => {
  it('CatalogSearchBar has no hidden/default "page" field — every new search naturally starts at page 1', () => {
    const barSrc = readSrc('src/components/store/CatalogSearchBar.tsx')
    expect(barSrc).not.toContain('name="page"')
  })

  it('the page component builds pagination params from the normalized (trimmed) q/brand/year, not raw searchParams', () => {
    const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(pageSrc).toContain('paginationParams.q = q.trim()')
    expect(pageSrc).toContain('paginationParams.brand = brand.trim()')
    expect(pageSrc).toContain('paginationParams.year = year.trim()')
  })

  it('getCatalogDiscovery normalization does not mutate any stored CatalogModel field — no update/write call exists', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(querySrc).not.toMatch(/\.(update|updateMany|create|delete|upsert)\(/)
  })
})

// ── Part H/BB: filters ───────────────────────────────────────────────────────────

describe('16J: structured filters — brand and year only', () => {
  it('brand filter is an exact match', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ brand: 'Hot Wheels' })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    expect(where.AND).toContainEqual({ brand: 'Hot Wheels' })
  })

  it('year filter is an exact match, only for clean 4-digit input', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ year: '2022' })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    expect(where.AND).toContainEqual({ year: 2022 })
  })

  it('malformed year (non-4-digit, letters) is ignored, never coerced to 0', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ year: 'abcd' })
    let where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    expect(where).toEqual({})

    await getCatalogDiscovery({ year: '99' })
    where = (prisma.catalogModel.count as Mock).mock.calls[1][0].where
    expect(where).toEqual({})
  })

  it('q + brand + year combine as AND', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({ q: 'mazda', brand: 'Hot Wheels', year: '2022' })

    const where = (prisma.catalogModel.count as Mock).mock.calls[0][0].where
    expect(where.AND).toContainEqual({ brand: 'Hot Wheels' })
    expect(where.AND).toContainEqual({ year: 2022 })
    expect(where.AND.some((c: Record<string, unknown>) => 'OR' in c)).toBe(true)
  })

  it('no price/condition/carded-loose filter exists — those are Listing attributes, not CatalogModel identity', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    const barSrc = readSrc('src/components/store/CatalogSearchBar.tsx')
    for (const src of [querySrc, barSrc]) {
      expect(src).not.toMatch(/minPrice|maxPrice|\bcondition\b|cardedOrLoose/)
    }
  })

  it('Series and Scale are not structured dropdown filters (cardinality unverifiable / spec-flagged risk) — still reachable via q', () => {
    const barSrc = readSrc('src/components/store/CatalogSearchBar.tsx')
    expect(barSrc).not.toContain('name="series"')
    expect(barSrc).not.toContain('name="scale"')
  })
})

// ── Part J/K/AP: pagination ──────────────────────────────────────────────────────

describe('16J: bounded, deterministic, filter-preserving pagination', () => {
  it('page size is 24, matching established project convention', () => {
    expect(CATALOG_PAGE_SIZE).toBe(24)
  })

  it('orderBy is deterministic: brand, name, year, id (tie-broken by id)', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    await getCatalogDiscovery({})

    const call = (prisma.catalogModel.findMany as Mock).mock.calls.find((c) => !c[0].distinct)!
    expect(call[0].orderBy).toEqual([{ brand: 'asc' }, { name: 'asc' }, { year: 'asc' }, { id: 'asc' }])
  })

  it('never fetches the whole table — take is always CATALOG_PAGE_SIZE', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(500)

    await getCatalogDiscovery({ page: 3 })

    const call = (prisma.catalogModel.findMany as Mock).mock.calls.find((c) => !c[0].distinct)!
    expect(call[0].take).toBe(24)
    expect(call[0].skip).toBe(48)
  })

  it('requestedPage beyond totalPages is clamped, not an empty/error page', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(10) // 1 page at size 24

    const result = await getCatalogDiscovery({ page: 99 })

    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(1)
  })

  it('page 0 or negative is clamped to 1', async () => {
    mockPage([])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(0)

    const result = await getCatalogDiscovery({ page: -5 })
    expect(result.page).toBe(1)
  })

  it('the page component preserves q/brand/year in pagination links, and resets on a new search (Pagination component omits page param when absent, form always starts fresh)', () => {
    const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(pageSrc).toContain("if (q?.trim()) paginationParams.q = q.trim()")
    expect(pageSrc).toContain("if (brand?.trim()) paginationParams.brand = brand.trim()")
    expect(pageSrc).toContain("if (year?.trim()) paginationParams.year = year.trim()")
  })

  it('no unbounded findMany (no take: 10000-style call) anywhere in the query module', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(querySrc).not.toMatch(/take:\s*10000|take:\s*Infinity/)
  })
})

// ── Part L/M/U/BC: result component entity boundary ─────────────────────────────

describe('16J: CatalogModelCard — one CatalogModel per result, not a Listing/purchase target', () => {
  const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
  const cardCode = stripComments(cardSrc)

  it('exists as a new file, distinct from ListingCard', () => {
    expect(exists('src/components/store/CatalogModelCard.tsx')).toBe(true)
  })

  it('does not import or reuse ListingCard', () => {
    expect(cardCode).not.toContain('ListingCard')
  })

  it('has no AddToCartButton — result cards are never a Buy target', () => {
    expect(cardSrc).not.toContain('AddToCartButton')
    expect(cardSrc).not.toContain('CartItem')
  })

  it('primary link targets /catalog/[model.id]', () => {
    expect(cardSrc).toContain('href={`/catalog/${model.id}`}')
  })

  it('does not link to /browse, a Listing id, or admin catalog', () => {
    expect(cardSrc).not.toMatch(/\/browse\/|\/admin\/catalog/)
  })

  it('has no Prisma import and no query — pure presentation', () => {
    expect(cardSrc).not.toContain("from '@/lib/prisma'")
  })

  it('does not auto-select or reference a "cheapest" Listing as its identity', () => {
    expect(cardSrc).not.toMatch(/cheapest|listings\[0\]/i)
  })
})

// ── Part R: no relationship state on results (documented decision) ─────────────

describe('16J: no Want/Own/Sell on search results (Part R baseline, not extended)', () => {
  it('CatalogModelCard has no Want/Collection/Sell actions', () => {
    const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
    expect(cardSrc).not.toMatch(/wantAction|unwantAction|addToCollectionAction|CatalogModelActions|CatalogActions/)
  })

  it('getCatalogDiscovery/page.tsx never calls getCatalogRelationshipState — no private per-visitor query on discovery', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(querySrc).not.toMatch(/getCatalogRelationshipState|getBuyerSession/)
    expect(pageSrc).not.toMatch(/getCatalogRelationshipState|getBuyerSession/)
  })
})

// ── Part V/BD: availability label semantics ─────────────────────────────────────

describe('16J: availability label semantics (0 / 1 / N, never $0)', () => {
  const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')

  it('0 → "No copies currently available"', () => {
    expect(cardSrc).toContain("'No copies currently available'")
  })

  it('1 → singular "copy", N → plural "copies"', () => {
    expect(cardSrc).toContain("availability.count === 1 ? 'copy' : 'copies'")
  })

  it('price label only renders when lowestPrice is non-null, never a fabricated $0', () => {
    expect(cardSrc).toContain('availability.lowestPrice !== null')
    expect(cardSrc).not.toMatch(/lowestPrice\s*\?\?\s*0/)
  })

  it('no discount/deal-score/average/valuation-comparison logic exists', () => {
    for (const src of [cardSrc, readSrc('src/lib/catalogDiscoveryQuery.ts')]) {
      expect(src).not.toMatch(/discount|dealScore|average|valuation/i)
    }
  })
})

// ── Part X: image fallback ───────────────────────────────────────────────────────

describe('16J: image behavior — CatalogModel photo only, existing placeholder fallback', () => {
  it('uses model.photoUrl via the existing PhotoThumbnail component', () => {
    const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
    expect(cardSrc).toContain("import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'")
    expect(cardSrc).toContain('photoUrl={model.photoUrl}')
  })

  it('photoUrl comes from CatalogModel.photos (the existing 16H model-photo relation), not a Listing/CollectionItem/admin image', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(querySrc).toContain('photos: { take: 1, orderBy: { sortOrder: \'asc\' }, select: { url: true } }')
    expect(querySrc).not.toMatch(/CollectionItem|intakeDraft|IntakeDraft/i)
  })

  it('no extra per-model Listing query exists merely to source a fallback image', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    const listingCalls = [...querySrc.matchAll(/prisma\.listing\./g)]
    expect(listingCalls.length).toBe(1) // the single availability query, nothing image-related
  })
})

// ── Part Y/Z: empty state and default view ──────────────────────────────────────

describe('16J: empty search and default (no-query) view', () => {
  const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')

  it('shows "No models found." with no customer-facing catalog-creation offer', () => {
    expect(pageSrc).toContain('No models found.')
    expect(pageSrc).not.toMatch(/[Cc]reate this (catalog )?model/)
  })

  it('empty state offers clearing filters only when filters were active', () => {
    expect(pageSrc).toContain('hasActiveFilters &&')
  })

  it('default /catalog (no query params) still renders a bounded first page — no requirement to type before seeing results', async () => {
    mockPage([modelRow()])
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(1)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await getCatalogDiscovery({})
    expect(result.models.length).toBe(1)
  })
})

// ── Part AB/AC: contextual linkage ───────────────────────────────────────────────

describe('16J: contextual linkage between /browse, /catalog, and /catalog/[id]', () => {
  it('/browse has a contextual "Explore all models" link to /catalog', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    expect(browseSrc).toContain('href="/catalog"')
    expect(browseSrc).toContain('Explore all models')
  })

  it('/browse heading itself is unchanged ("Browse Listings")', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    expect(browseSrc).toContain('Browse Listings')
  })

  it('/catalog/[id] has a "Back to Catalog" link to /catalog, in addition to the existing Browse link', () => {
    const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
    expect(hubSrc).toContain('href="/catalog"')
    expect(hubSrc).toContain('Back to Catalog')
    expect(hubSrc).toContain('<Link href="/browse"')
  })
})

// ── Part AD: no new primary nav item ─────────────────────────────────────────────

describe('16J: no new primary nav item', () => {
  it('customerNav.ts primary nav is unchanged (still exactly Shop/Sell/Community/Order Status)', () => {
    const navSrc = readSrc('src/lib/customerNav.ts')
    expect(navSrc).toContain("{ key: 'shop', label: 'Shop', href: '/browse' }")
    expect(navSrc).not.toMatch(/label: 'Catalog'/)
    const navMatches = [...navSrc.matchAll(/CUSTOMER_PRIMARY_NAV: CustomerNavItem\[\] = \[([\s\S]*?)\]/g)]
    expect(navMatches[0][1].match(/key:/g)?.length).toBe(4)
  })
})

// ── Part AE: terminology ─────────────────────────────────────────────────────────

describe('16J: customer language avoids the internal term "CatalogModel"', () => {
  it('visible UI text never renders the literal string "CatalogModel"', () => {
    const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
    const barSrc = readSrc('src/components/store/CatalogSearchBar.tsx')
    for (const src of [pageSrc, cardSrc, barSrc]) {
      expect(src).not.toMatch(/>CatalogModel</)
    }
  })

  it('page uses "Model Catalog" / "Explore" customer-facing language', () => {
    const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(pageSrc).toContain('Model Catalog')
  })
})

// ── Part AF/AG: Collection/Wanted linkage regression ────────────────────────────

describe('16J: 16H Collection/Wanted linkage to /catalog/[id] is unchanged', () => {
  it('Collection "View Market" still links to /catalog/${item.catalogId}', () => {
    const collectionSrc = readSrc('src/app/(store)/account/collection/page.tsx')
    expect(collectionSrc).toContain('href={`/catalog/${item.catalogId}`}')
  })

  it('Wanted model identity still links to /catalog/${entry.catalog.id}', () => {
    const wantedSrc = readSrc('src/app/(store)/account/wanted/page.tsx')
    expect(wantedSrc).toContain('href={`/catalog/${entry.catalog.id}`}')
  })
})

// ── Part BF/BG/T: anonymous & authenticated behavior ────────────────────────────

describe('16J: anonymous and authenticated discovery use the identical public query', () => {
  it('/catalog page.tsx never imports getBuyerSession — no session branching on discovery', () => {
    const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(pageSrc).not.toContain('getBuyerSession')
  })

  it('getCatalogDiscovery has no session/profileId parameter', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(querySrc).not.toMatch(/profileId/)
  })
})

// ── Part AV: privacy ──────────────────────────────────────────────────────────────

describe('16J: no private/seller/admin field is exposed by discovery', () => {
  it('the discovery query type and select shape expose no seller/financial/internal fields', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(querySrc).not.toMatch(/purchasePrice|listPrice|sellerAgreement|sellerPortfolio|payout|storageLocation|adminNote/i)
  })

  it('CatalogModelCard renders no seller/buyer identity', () => {
    const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
    expect(cardSrc).not.toMatch(/email|seller|buyer|customerProfile/i)
  })
})

// ── Part BI: /browse regression ───────────────────────────────────────────────────

describe('16J: /browse remains Listing-centric — no query expansion to CatalogModel table as a card source', () => {
  it('/browse still queries prisma.listing.findMany as its card source', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    expect(browseSrc).toContain('prisma.listing.findMany({')
  })

  it('/browse still renders ListingCard, not CatalogModelCard', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    expect(browseSrc).toContain('ListingCard')
    expect(browseSrc).not.toContain('CatalogModelCard')
  })
})

// ── Part BJ: 16H/16I preserved on the hub ────────────────────────────────────────

describe('16J: 16H/16I hub behavior preserved', () => {
  it('/catalog/[id] still uses CatalogListingOption (16I), not ListingCard or CatalogModelCard', () => {
    const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
    expect(hubSrc).toContain('CatalogListingOption')
    expect(hubSrc).not.toContain('ListingCard')
    expect(hubSrc).not.toContain('CatalogModelCard')
  })

  it('/catalog/[id] still has zero-listing empty state and CatalogModelActions', () => {
    const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
    expect(hubSrc).toContain('No copies currently available.')
    expect(hubSrc).toContain('<CatalogModelActions')
  })
})

// ── Part BK: no schema/migration changes ─────────────────────────────────────────

describe('16J: zero schema/migration changes', () => {
  it('CatalogModel model definition is unchanged (no new fields)', () => {
    const schema = readSrc('prisma/schema.prisma')
    const modelBlock = schema.slice(schema.indexOf('model CatalogModel {'), schema.indexOf('model CatalogModelMergeAudit'))
    expect(modelBlock).toContain('@@index([brand])')
    expect(modelBlock).toContain('@@index([name])')
    // no third index was added
    expect((modelBlock.match(/@@index/g) ?? []).length).toBe(2)
  })
})

// ── Accessibility (Part AT) ───────────────────────────────────────────────────────

describe('16J: accessibility', () => {
  const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
  const pageCode = stripComments(pageSrc)
  const barSrc = readSrc('src/components/store/CatalogSearchBar.tsx')
  const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')

  it('exactly one h1', () => {
    expect(pageCode.match(/<h1/g)?.length).toBe(1)
  })

  it('search input has an associated label', () => {
    expect(barSrc).toContain('htmlFor="catalog-q"')
    expect(barSrc).toContain('id="catalog-q"')
  })

  it('brand/year filter inputs have associated labels', () => {
    expect(barSrc).toContain('htmlFor="catalog-brand"')
    expect(barSrc).toContain('htmlFor="catalog-year"')
  })

  it('results are wrapped in a labelled section', () => {
    expect(pageSrc).toContain('aria-labelledby="catalog-results-heading"')
  })

  it('each result card is a single semantic link, not nested interactive elements', () => {
    const linkOpenCount = (cardSrc.match(/<Link\b/g) ?? []).length
    const buttonCount = (cardSrc.match(/<button\b/g) ?? []).length
    expect(linkOpenCount).toBe(1)
    expect(buttonCount).toBe(0)
  })

  it('the card image has meaningful alt text (model name)', () => {
    expect(cardSrc).toContain('alt={modelName}')
  })

  it('availability is rendered as text, not color-only', () => {
    expect(cardSrc).toContain('{availabilityLabel}')
  })

  it('pagination links have clear directional labels (reused shared Pagination component)', () => {
    expect(pageSrc).toContain('<Pagination')
    const paginationSrc = readSrc('src/components/shared/Pagination.tsx')
    expect(paginationSrc).toContain('← Previous')
    expect(paginationSrc).toContain('Next →')
  })
})

// ── Read-only render (Part AU) ────────────────────────────────────────────────────

describe('16J: discovery performs no mutation', () => {
  it('no create/update/delete/upsert anywhere in the query module or page', () => {
    const querySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    const pageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    for (const src of [querySrc, pageSrc]) {
      expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
    }
  })
})

// ── Admin untouched ────────────────────────────────────────────────────────────────

describe('16J: admin behavior untouched', () => {
  it('no admin file references catalogDiscoveryQuery/CatalogModelCard/CatalogSearchBar', () => {
    const adminDir = path.join(root, 'src/app/(admin)')
    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    }
    const adminFiles = walk(adminDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    for (const f of adminFiles) {
      expect(fs.readFileSync(f, 'utf-8')).not.toMatch(/catalogDiscoveryQuery|CatalogModelCard|CatalogSearchBar/)
    }
  })

  it('/api/catalog/search route.ts is unchanged — still serves searchCatalogModels for its existing (combobox/autocomplete) callers', () => {
    const routeSrc = readSrc('src/app/api/catalog/search/route.ts')
    expect(routeSrc).toContain('searchCatalogModels')
    expect(routeSrc).not.toContain('getCatalogDiscovery')
  })
})
