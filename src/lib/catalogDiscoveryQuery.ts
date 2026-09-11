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
import { normalizePhrase, findCompoundBrandPrefix, buildExactOrClauses, buildPrefixOrClauses } from './catalogSearchTiers'

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

// 20B: generalizes 20A's own two-tier (available/unavailable) pagination walk
// into N ordered, MUTUALLY EXCLUSIVE tiers — used by search's up-to-six-tier
// relevance ranking. Every tier is counted (so totalCount is always the exact
// sum of mutually-exclusive tiers, §15), but a tier is only ever fetched
// (`findMany`) if the requested page window actually intersects it — a page
// may end mid-tier and resume in the next one, with no duplicate/missing rows
// and no per-model or catalog-size-dependent query.
async function paginateAcrossTiers(
  tierWheres: Prisma.CatalogModelWhereInput[],
  orderBy: Prisma.CatalogModelOrderByWithRelationInput[],
  requestedPage: number,
  pageSize: number,
): Promise<{ rows: ModelRow[]; totalCount: number; page: number }> {
  const counts = await Promise.all(tierWheres.map((where) => prisma.catalogModel.count({ where })))
  const totalCount = counts.reduce((a, b) => a + b, 0)
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * pageSize

  let remainingSkip = skip
  let remainingTake = pageSize
  const fetches: Promise<ModelRow[]>[] = []

  for (let i = 0; i < tierWheres.length && remainingTake > 0; i++) {
    const tierCount = counts[i]
    if (remainingSkip >= tierCount) {
      remainingSkip -= tierCount
      continue
    }
    const tierSkip = remainingSkip
    const tierTake = Math.min(remainingTake, tierCount - tierSkip)
    fetches.push(
      prisma.catalogModel.findMany({ where: tierWheres[i], orderBy, skip: tierSkip, take: tierTake, select: MODEL_SELECT }),
    )
    remainingSkip = 0
    remainingTake -= tierTake
  }

  const rowsPerTier = await Promise.all(fetches)
  return { rows: rowsPerTier.flat(), totalCount, page }
}

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

  // 20B: brand/year filters kept in their own array (rather than the old
  // single `conditions` array) purely so the comment at each call site can
  // say precisely what's being combined — both still flow into `baseWhere`
  // below unchanged, which every relevance tier is scoped to (§2).
  const filterConditions: Prisma.CatalogModelWhereInput[] = []
  if (brand) filterConditions.push({ brand })
  if (yearNum !== null) filterConditions.push({ year: yearNum })

  // AND across tokens, OR across fields within a token — lets a multi-word query
  // match a model whose words are spread across brand/name/series/etc. Exactly
  // the pre-20B broad qualification, untouched (§2).
  const tokenConditions: Prisma.CatalogModelWhereInput[] = []
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
    tokenConditions.push({ OR: orClauses })
  }

  // baseWhere: the exact same shape/value as pre-20B — filters AND the token
  // predicate together. Used unmodified by Available Now mode and by the
  // q-empty two-tier default (§12/§46 regression requirement).
  const baseWhere: Prisma.CatalogModelWhereInput = [...filterConditions, ...tokenConditions].length
    ? { AND: [...filterConditions, ...tokenConditions] }
    : {}

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

  if (q) {
    // 20B: deterministic relevance tiering — Exact > Prefix > Broad, each
    // split into Available-then-Unavailable (Available Now collapses to the
    // Available half only — §13/§20). Brand list is awaited HERE (rather than
    // left parallel with the count queries, unlike every other mode) because
    // compound brand+model parsing (§6/§18) needs it to build the tier
    // predicates in the first place — it's the same one distinct-brand query
    // every mode already runs, just resolved earlier in this one.
    const brandRows = await brandRowsPromise
    const knownBrands = brandRows.map((r) => r.brand)
    const normalizedPhrase = normalizePhrase(q)
    const compound = findCompoundBrandPrefix(normalizedPhrase, knownBrands)

    const exactOr = buildExactOrClauses(normalizedPhrase, compound)
    const prefixOr = buildPrefixOrClauses(normalizedPhrase, compound)

    // Each tier predicate is scoped to `baseWhere` (filters + the unchanged
    // broad token qualification, §2) — exact/prefix rows are always already a
    // subset of the broad universe (an exact/prefix match trivially satisfies
    // every individual token's OR-clause too), but ANDing baseWhere in
    // explicitly makes that invariant true by construction, not just by proof.
    const exactWhere: Prisma.CatalogModelWhereInput = { AND: [baseWhere, { OR: exactOr }] }
    const prefixWhere: Prisma.CatalogModelWhereInput = {
      AND: [baseWhere, { OR: prefixOr }, { NOT: { OR: exactOr } }],
    }
    const broadWhere: Prisma.CatalogModelWhereInput = {
      AND: [baseWhere, { NOT: { OR: exactOr } }, { NOT: { OR: prefixOr } }],
    }

    const withAvailable = (w: Prisma.CatalogModelWhereInput): Prisma.CatalogModelWhereInput => ({
      AND: [w, { items: { some: eligibleItemInstanceWhere() } }],
    })
    const withUnavailable = (w: Prisma.CatalogModelWhereInput): Prisma.CatalogModelWhereInput => ({
      AND: [w, { items: { none: eligibleItemInstanceWhere() } }],
    })

    // §13/§20: Available Now restricts the universe to available rows only —
    // there is nothing left to rank into an Unavailable half, so those three
    // tiers are never built/counted/fetched at all (not built-then-skipped).
    const tierWheres: Prisma.CatalogModelWhereInput[] = availableNow
      ? [withAvailable(exactWhere), withAvailable(prefixWhere), withAvailable(broadWhere)]
      : [
          withAvailable(exactWhere), withUnavailable(exactWhere),
          withAvailable(prefixWhere), withUnavailable(prefixWhere),
          withAvailable(broadWhere), withUnavailable(broadWhere),
        ]

    const tiered = await paginateAcrossTiers(tierWheres, orderBy, requestedPage, CATALOG_PAGE_SIZE)
    totalCount = tiered.totalCount
    page = tiered.page
    modelRows = tiered.rows
    return finishResult(modelRows, totalCount, page, knownBrands)
  }

  if (availableNow) {
    // 20A §22: Available Now (no q) forces a single tier — normal skip/take
    // pagination over availableWhere only, no second (unavailable) query.
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
