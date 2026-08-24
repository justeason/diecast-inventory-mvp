// 16J: DB boundary for public CatalogModel discovery (/catalog). CatalogModel has
// no active/inactive/deleted/suppressed/public field (inspected: brand, name,
// series?, year?, color?, scale?, notes — nothing else). Duplicate merges DELETE
// the losing row outright (see mergeCatalogModels in actions/catalog.ts), and
// CatalogSuggestion (unreviewed candidates) is a separate table entirely — so
// every CatalogModel row that exists is already the narrowest defensible "public"
// set. No new eligibility field was invented for this.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { eligibleListingWhere } from './listingEligibility'

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

export async function getCatalogDiscovery(params: {
  q?: string
  brand?: string
  year?: string
  page?: number
}): Promise<CatalogDiscoveryResult> {
  const q = (params.q ?? '').trim().slice(0, MAX_QUERY_LENGTH)
  const brand = (params.brand ?? '').trim()
  const yearNum = parseYear(params.year)
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
  const where: Prisma.CatalogModelWhereInput = conditions.length ? { AND: conditions } : {}

  // brand/name/year/id: deterministic, tie-broken by id — stable across pages even
  // if two rows share brand+name+year.
  const orderBy: Prisma.CatalogModelOrderByWithRelationInput[] = [
    { brand: 'asc' },
    { name: 'asc' },
    { year: 'asc' },
    { id: 'asc' },
  ]

  const [totalCount, brandRows] = await Promise.all([
    prisma.catalogModel.count({ where }),
    // Same unbounded-but-cardinality-bounded distinct-brand pattern /browse already
    // uses — brand is a manufacturer name, not a high-cardinality field.
    prisma.catalogModel.findMany({ distinct: ['brand'], select: { brand: true }, orderBy: { brand: 'asc' } }),
  ])

  const totalPages = Math.max(1, Math.ceil(totalCount / CATALOG_PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * CATALOG_PAGE_SIZE

  const modelRows = await prisma.catalogModel.findMany({
    where,
    orderBy,
    skip,
    take: CATALOG_PAGE_SIZE,
    select: {
      id: true, brand: true, name: true, year: true, series: true, color: true, scale: true,
      photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
    },
  })

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
    brands: brandRows.map((r) => r.brand),
  }
}
