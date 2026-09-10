// 16J: DB boundary for public CatalogModel discovery (/catalog). CatalogModel has
// no active/inactive/deleted/suppressed/public field (inspected: brand, name,
// series?, year?, color?, scale?, notes — nothing else). Duplicate merges DELETE
// the losing row outright (see mergeCatalogModels in actions/catalog.ts), and
// CatalogSuggestion (unreviewed candidates) is a separate table entirely — so
// every CatalogModel row that exists is already the narrowest defensible "public"
// set. No new eligibility field was invented for this.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { eligibleListingWhere, eligibleItemInstanceWhere } from './listingEligibility'

export const CATALOG_PAGE_SIZE = 24
const MAX_QUERY_LENGTH = 100
// Bounds the number of AND-ed OR-blocks a query can produce (each token contributes
// one OR-across-fields block) — a long query string cannot balloon into hundreds of
// nested Prisma predicates.
const MAX_SEARCH_TOKENS = 8

export type CatalogDiscoveryModel = {
  id: string
  brand: string
  name: string
  year: number | null
  series: string | null
  color: string | null
  scale: string | null
  photoUrl: string | null
}

export type CatalogModelAvailability = {
  // Exact — reduced from a single page-scoped Listing query, never estimated.
  count: number
  lowestPrice: number | null
}

export type CatalogDiscoveryResult = {
  models: CatalogDiscoveryModel[]
  availabilityByModel: Map<string, CatalogModelAvailability>
  totalCount: number
  page: number
  totalPages: number
  brands: string[]
}

function parseYear(raw: string | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^\d{4}$/.test(trimmed)) return null
  return parseInt(trimmed, 10)
}

// Splits an already-trimmed query into whitespace-separated tokens, so a phrase
// whose words span different CatalogModel fields (e.g. "hot wheels mazda" — brand
// "Hot Wheels" + name "Mazda MX-5") can still match. Each token is required (AND);
// within a token, any field may match (OR). No fuzzy/trigram/ranking — plain
// case-insensitive `contains` per token, same as the prior whole-string behavior.
function tokenizeQuery(q: string): string[] {
  return q.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS)
}

const MODEL_SELECT = {
  id: true, brand: true, name: true, year: true, series: true, color: true, scale: true,
  photos: { take: 1, orderBy: { sortOrder: 'asc' as const }, select: { url: true } },
} satisfies Prisma.CatalogModelSelect

type ModelRow = Prisma.CatalogModelGetPayload<{ select: typeof MODEL_SELECT }>

export async function getCatalogDiscovery(params: {
  q?: string
  brand?: string
  year?: string
  page?: number
  // 20A: CatalogModel has >=1 eligible Listing. Restricts to a single tier
  // (no unavailable rows at all) — never combined with the two-tier ranking
  // below, since there is nothing left to rank into a second tier.
  availableNow?: boolean
}): Promise<CatalogDiscoveryResult> {
  const q = (params.q ?? '').trim().slice(0, MAX_QUERY_LENGTH)
  const brand = (params.brand ?? '').trim()
  const yearNum = parseYear(params.year)
  const availableNow = params.availableNow === true
  const requestedPage = Math.max(1, params.page ?? 1)

  const conditions: Prisma.CatalogModelWhereInput[] = []
  if (brand) conditions.push({ brand })
  if (yearNum !== null) conditions.push({ year: yearNum })
  if (q) {
    // AND across tokens, OR across fields within a token — lets a multi-word query
    // match a model whose words are spread across brand/name/series/etc.
    for (const token of tokenizeQuery(q)) {
      const orClauses: Prisma.CatalogModelWhereInput[] = [
        { brand: { contains: token, mode: 'insensitive' } },
        { name: { contains: token, mode: 'insensitive' } },
        { series: { contains: token, mode: 'insensitive' } },
        { color: { contains: token, mode: 'insensitive' } },
        { scale: { contains: token, mode: 'insensitive' } },
      ]
      const tokenYear = parseYear(token)
      if (tokenYear !== null) orClauses.push({ year: tokenYear })
      conditions.push({ OR: orClauses })
    }
  }
  const baseWhere: Prisma.CatalogModelWhereInput = conditions.length ? { AND: conditions } : {}

  // 20A: CatalogModel-level EXISTS/NOT-EXISTS via a `some`/`none` relation
  // filter — no raw SQL, no fetching of Listing rows to decide tier membership.
  const availableWhere: Prisma.CatalogModelWhereInput = {
    AND: [baseWhere, { items: { some: eligibleItemInstanceWhere() } }],
  }
  const unavailableWhere: Prisma.CatalogModelWhereInput = {
    AND: [baseWhere, { items: { none: eligibleItemInstanceWhere() } }],
  }

  // brand/name/year/id: deterministic, tie-broken by id — stable across pages even
  // if two rows share brand+name+year. Reused, unmodified, inside EVERY tier below —
  // 20A only ever prepends a boolean availability tier ahead of this order, never
  // replaces it (see §37: within-tier order must stay identical to pre-20A).
  const orderBy: Prisma.CatalogModelOrderByWithRelationInput[] = [
    { brand: 'asc' },
    { name: 'asc' },
    { year: 'asc' },
    { id: 'asc' },
  ]

  const brandRowsPromise = prisma.catalogModel.findMany({
    distinct: ['brand'], select: { brand: true }, orderBy: { brand: 'asc' },
  })

  let modelRows: ModelRow[]
  let totalCount: number
  let page: number

  if (availableNow) {
    // 20A §22: Available Now forces a single tier — normal skip/take pagination
    // over availableWhere only, no second (unavailable) query at all.
    const [count, brandRows] = await Promise.all([
      prisma.catalogModel.count({ where: availableWhere }),
      brandRowsPromise,
    ])
    totalCount = count
    page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / CATALOG_PAGE_SIZE)))
    modelRows = await prisma.catalogModel.findMany({
      where: availableWhere, orderBy, skip: (page - 1) * CATALOG_PAGE_SIZE, take: CATALOG_PAGE_SIZE, select: MODEL_SELECT,
    })
    return finishResult(modelRows, totalCount, page, brandRows.map((r) => r.brand))
  }

  if (q) {
    // 20A §20/§23: search mode keeps the existing single-tier pagination/order
    // unchanged — availability is never ranked ahead of search relevance here.
    // Relevance tiering itself is explicitly 20B scope, not implemented now.
    const [count, brandRows] = await Promise.all([
      prisma.catalogModel.count({ where: baseWhere }),
      brandRowsPromise,
    ])
    totalCount = count
    page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / CATALOG_PAGE_SIZE)))
    modelRows = await prisma.catalogModel.findMany({
      where: baseWhere, orderBy, skip: (page - 1) * CATALOG_PAGE_SIZE, take: CATALOG_PAGE_SIZE, select: MODEL_SELECT,
    })
    return finishResult(modelRows, totalCount, page, brandRows.map((r) => r.brand))
  }

  // 20A §19/§21: default no-search, no-filter-forcing mode — TWO-TIER
  // availability-first pagination, computed BEFORE pagination (never "fetch one
  // alphabetic page then locally re-sort by availability", which would not be
  // globally availability-first). Availability is boolean-only: within each
  // tier the order is the exact same brand/name/year/id tuple as every other
  // mode — never re-ranked by count/price/recency/Wanted/sales.
  const [totalAvailable, totalAll, brandRows] = await Promise.all([
    prisma.catalogModel.count({ where: availableWhere }),
    prisma.catalogModel.count({ where: baseWhere }),
    brandRowsPromise,
  ])
  totalCount = totalAll
  page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / CATALOG_PAGE_SIZE)))
  const skip = (page - 1) * CATALOG_PAGE_SIZE

  // Translate the single global [skip, skip+take) window into a slice of tier 1
  // (available) followed by a slice of tier 2 (unavailable) — the page may fall
  // entirely within one tier, or straddle the boundary between them.
  const tier1Skip = Math.min(skip, totalAvailable)
  const tier1Take = Math.max(0, Math.min(CATALOG_PAGE_SIZE, totalAvailable - tier1Skip))
  const tier2Skip = Math.max(0, skip - totalAvailable)
  const tier2Take = CATALOG_PAGE_SIZE - tier1Take

  const [tier1Rows, tier2Rows] = await Promise.all([
    tier1Take > 0
      ? prisma.catalogModel.findMany({ where: availableWhere, orderBy, skip: tier1Skip, take: tier1Take, select: MODEL_SELECT })
      : Promise.resolve([] as ModelRow[]),
    tier2Take > 0
      ? prisma.catalogModel.findMany({ where: unavailableWhere, orderBy, skip: tier2Skip, take: tier2Take, select: MODEL_SELECT })
      : Promise.resolve([] as ModelRow[]),
  ])
  modelRows = [...tier1Rows, ...tier2Rows]

  return finishResult(modelRows, totalCount, page, brandRows.map((r) => r.brand))
}

async function finishResult(
  modelRows: ModelRow[],
  totalCount: number,
  page: number,
  brands: string[],
): Promise<CatalogDiscoveryResult> {
  const totalPages = Math.max(1, Math.ceil(totalCount / CATALOG_PAGE_SIZE))
  const modelIds = modelRows.map((m) => m.id)
  const availabilityByModel = new Map<string, CatalogModelAvailability>()
  for (const id of modelIds) availabilityByModel.set(id, { count: 0, lowestPrice: null })

  // One page-scoped query for the whole page's availability — never per-model.
  // Listing.price lives on Listing, catalogId lives on the related ItemInstance, so
  // a native Prisma groupBy (which only aggregates scalar fields on the queried
  // model) can't compute count+min in one grouped call across that relation without
  // raw SQL. At current/foreseeable catalog scale, fetching the minimal eligible
  // rows for exactly this page's ~24 models and reducing in-process is the simplest
  // correct bounded approach — still exactly one query, not N.
  if (modelIds.length > 0) {
    const eligibleListings = await prisma.listing.findMany({
      where: eligibleListingWhere(modelIds),
      select: { price: true, item: { select: { catalogId: true } } },
    })
    for (const listing of eligibleListings) {
      const entry = availabilityByModel.get(listing.item.catalogId)
      if (!entry) continue
      entry.count += 1
      entry.lowestPrice = entry.lowestPrice === null ? listing.price : Math.min(entry.lowestPrice, listing.price)
    }
  }

  return {
    models: modelRows.map((m) => ({
      id: m.id, brand: m.brand, name: m.name, year: m.year, series: m.series, color: m.color, scale: m.scale,
      photoUrl: m.photos[0]?.url ?? null,
    })),
    availabilityByModel,
    totalCount,
    page,
    totalPages,
    brands,
  }
}
