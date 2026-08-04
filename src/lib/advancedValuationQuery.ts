import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ComparableSale, TargetModel } from '@/lib/resaleEstimator'
import { buildAdvancedValuation } from '@/lib/advancedValuation'
import type { AdvancedValuation } from '@/lib/advancedValuation'

// Page size for keyset pagination over OrderItem.id ASC.
// Not a total cap — scanning continues across pages until all eligible rows are fetched.
const BATCH_CANDIDATE_LIMIT = 2000

// Max targets per comparable-sales query chunk.
// Each target contributes up to 4 OR conditions; chunking keeps query plans predictable.
const TARGET_CHUNK_SIZE = 50

export type CollectionValuationItem = {
  collectionItemId: string
  catalogModelId: string | null
  modelName: string
  quantity: number
  quantityValid: boolean
  valuation: AdvancedValuation | null
  estimatedSubtotal: number | null
  lowSubtotal: number | null
  highSubtotal: number | null
}

// Integer quantity in [1, 999] only. Never round or clamp — invalid quantities are unvalued.
export function isValidQuantity(qty: number): boolean {
  return Number.isInteger(qty) && qty >= 1 && qty <= 999
}

export type CollectionValuationResult = {
  asOf: Date
  items: CollectionValuationItem[]
  totalEstimated: number
  totalLow: number
  totalHigh: number
  valuedCount: number
  unvaluedCount: number
  coveragePercent: number
}

// ── Query helpers ─────────────────────────────────────────────────────────────

// Builds per-model OR conditions covering all fallback tiers.
function buildOrConditions(targets: TargetModel[]): Prisma.ItemInstanceWhereInput[] {
  const conditions: Prisma.ItemInstanceWhereInput[] = []
  for (const t of targets) {
    conditions.push({ catalogId: t.id })
    conditions.push({
      catalog: {
        brand: { equals: t.brand, mode: 'insensitive' },
        name:  { equals: t.name,  mode: 'insensitive' },
      },
    })
    if (t.series && t.year != null) {
      conditions.push({
        catalog: {
          brand:  { equals: t.brand,  mode: 'insensitive' },
          series: { equals: t.series, mode: 'insensitive' },
          year: t.year,
        },
      })
    }
    if (t.series) {
      conditions.push({
        catalog: {
          brand:  { equals: t.brand,  mode: 'insensitive' },
          series: { equals: t.series, mode: 'insensitive' },
        },
      })
    }
  }
  return conditions
}

// Standalone page-fetcher so TypeScript can infer the return type without a circular
// dependency between the rows result and the afterId cursor update inside the while loop.
async function fetchSalePage(
  orConditions: Prisma.ItemInstanceWhereInput[],
  afterId: string | undefined,
) {
  return prisma.orderItem.findMany({
    where: {
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
      order: { status: 'complete', completedAt: { not: null } },
      price: { gt: 0 },
      item:  { OR: orConditions },
    },
    select: {
      id:      true,
      orderId: true,
      price:   true,
      order:   { select: { completedAt: true } },
      listing: { select: { createdAt: true } },
      item: {
        select: {
          sku: true,
          catalog: { select: { id: true, brand: true, name: true, series: true, year: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
    take: BATCH_CANDIDATE_LIMIT,
  })
}

// Fetches all eligible comparable sales using keyset pagination on OrderItem.id ASC.
// Chunks targets to keep OR-condition counts manageable; deduplicates across pages and chunks.
// No date filter here — the 24-month cutoff and extended-history fallback are handled by
// computeEstimate after all candidate rows are in memory.
async function fetchComparableSalesBatch(targets: TargetModel[]): Promise<ComparableSale[]> {
  if (targets.length === 0) return []

  // Chunk targets so each query has at most TARGET_CHUNK_SIZE * 4 OR conditions
  const chunks: TargetModel[][] = []
  for (let i = 0; i < targets.length; i += TARGET_CHUNK_SIZE) {
    chunks.push(targets.slice(i, i + TARGET_CHUNK_SIZE))
  }

  const seen = new Set<string>()
  const result: ComparableSale[] = []

  for (const chunk of chunks) {
    const orConditions = buildOrConditions(chunk)
    let afterId: string | undefined = undefined

    while (true) {
      const rows = await fetchSalePage(orConditions, afterId)

      for (const row of rows) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        if (!row.order.completedAt) continue
        if (!row.listing)           continue
        if (!row.item.catalog)      continue
        if (row.price <= 0 || !isFinite(row.price)) continue
        result.push({
          orderItemId:      row.id,
          orderId:          row.orderId,
          catalogModelId:   row.item.catalog.id,
          catalogBrand:     row.item.catalog.brand,
          catalogName:      row.item.catalog.name,
          catalogSeries:    row.item.catalog.series,
          catalogYear:      row.item.catalog.year,
          soldPriceCents:   Math.round(row.price * 100),
          listingCreatedAt: row.listing.createdAt,
          orderCompletedAt: row.order.completedAt,
          sku:              row.item.sku,
        })
      }

      if (rows.length < BATCH_CANDIDATE_LIMIT) break
      afterId = rows[rows.length - 1].id
    }
  }

  return result
}

// Fetches active+available listings with price > 0 for the given catalog IDs.
// Returns a Map<catalogModelId, pricesCents[]>.
async function fetchActiveAsksBatch(catalogModelIds: string[]): Promise<{
  pricesByCatalog: Map<string, number[]>
  countByCatalog: Map<string, number>
}> {
  if (catalogModelIds.length === 0) {
    return { pricesByCatalog: new Map(), countByCatalog: new Map() }
  }

  const rows = await prisma.listing.findMany({
    where: {
      status: 'active',
      price:  { gt: 0 },
      item:   { status: 'available', catalogId: { in: catalogModelIds } },
    },
    select: {
      id:    true,
      price: true,
      item:  { select: { catalogId: true } },
    },
    orderBy: [{ price: 'asc' }, { id: 'asc' }],
  })

  const pricesByCatalog = new Map<string, number[]>()
  const countByCatalog  = new Map<string, number>()
  for (const row of rows) {
    const cid = row.item.catalogId
    if (!pricesByCatalog.has(cid)) pricesByCatalog.set(cid, [])
    pricesByCatalog.get(cid)!.push(Math.round(row.price * 100))
    countByCatalog.set(cid, (countByCatalog.get(cid) ?? 0) + 1)
  }
  return { pricesByCatalog, countByCatalog }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Single-model lookup. Creates its own asOf when called independently.
export async function getCatalogValuation(catalogModelId: string): Promise<AdvancedValuation> {
  const asOf = new Date()
  const valuations = await getCatalogValuations([catalogModelId], asOf)
  const result = valuations.get(catalogModelId)
  if (!result) {
    const noTarget: TargetModel = { id: catalogModelId, brand: '', name: '', series: null, year: null }
    return buildAdvancedValuation(noTarget, [], [], 0, asOf)
  }
  return result
}

// Batch multi-model lookup. One comparable-sales query and one active-asks query.
// Never fetches one query per model (no N+1).
// asOf must be provided by the caller so all valuations in a single build share one timestamp.
export async function getCatalogValuations(
  catalogModelIds: string[],
  asOf: Date = new Date(),
): Promise<Map<string, AdvancedValuation>> {
  const deduped = [...new Set(catalogModelIds)]
  if (deduped.length === 0) return new Map()

  // 1. Fetch catalog model metadata
  const catalogModels = await prisma.catalogModel.findMany({
    where: { id: { in: deduped } },
    select: { id: true, brand: true, name: true, series: true, year: true },
  })

  const targets: TargetModel[] = catalogModels.map(cm => ({
    id:     cm.id,
    brand:  cm.brand,
    name:   cm.name,
    series: cm.series,
    year:   cm.year,
  }))

  // 2. Batch fetch comparable sales and active asks (2 queries total)
  const [allComparables, { pricesByCatalog, countByCatalog }] = await Promise.all([
    fetchComparableSalesBatch(targets),
    fetchActiveAsksBatch(deduped),
  ])

  // 3. Build valuation per target
  const result = new Map<string, AdvancedValuation>()
  for (const target of targets) {
    const askPrices = pricesByCatalog.get(target.id) ?? []
    const askCount  = countByCatalog.get(target.id)  ?? 0
    const valuation = buildAdvancedValuation(target, allComparables, askPrices, askCount, asOf)
    result.set(target.id, valuation)
  }

  return result
}

// Authenticated collection valuation. profileId must come from session, never from browser input.
export async function getCollectionValuation(
  profileId: string,
): Promise<CollectionValuationResult> {
  const asOf = new Date()

  const collectionItems = await prisma.collectionItem.findMany({
    where: { profileId },
    select: {
      id:        true,
      catalogId: true,
      brand:     true,
      name:      true,
      quantity:  true,
      catalog:   { select: { id: true, brand: true, name: true } },
    },
    orderBy: { id: 'asc' },
  })

  // Deduplicate catalog IDs (only items with a catalog match can be valued)
  const catalogIds = [...new Set(
    collectionItems
      .map(ci => ci.catalogId)
      .filter((id): id is string => id !== null),
  )]

  const valuationMap = catalogIds.length > 0
    ? await getCatalogValuations(catalogIds, asOf)
    : new Map<string, AdvancedValuation>()

  const items: CollectionValuationItem[] = collectionItems.map(ci => {
    const qty = ci.quantity
    const qtyValid = isValidQuantity(qty)
    const catalogName = ci.catalog ? `${ci.catalog.brand} ${ci.catalog.name}` : null
    const modelName = catalogName ?? ([ci.brand, ci.name].filter(Boolean).join(' ') || 'Unnamed item')

    if (!ci.catalogId || !qtyValid) {
      return {
        collectionItemId:   ci.id,
        catalogModelId:     ci.catalogId ?? null,
        modelName,
        quantity:           qty,
        quantityValid:      qtyValid,
        valuation:          null,
        estimatedSubtotal:  null,
        lowSubtotal:        null,
        highSubtotal:       null,
      }
    }

    const val = valuationMap.get(ci.catalogId) ?? null
    const hasValue = val !== null && val.estimatedValue !== null

    return {
      collectionItemId:  ci.id,
      catalogModelId:    ci.catalogId,
      modelName,
      quantity:          qty,
      quantityValid:     true,
      valuation:         val,
      estimatedSubtotal: hasValue ? (val!.estimatedValue! * qty) : null,
      lowSubtotal:       hasValue && val!.lowEstimate  !== null ? (val!.lowEstimate  * qty) : null,
      highSubtotal:      hasValue && val!.highEstimate !== null ? (val!.highEstimate * qty) : null,
    }
  })

  let totalEstimated = 0
  let totalLow       = 0
  let totalHigh      = 0
  let valuedCount    = 0
  let unvaluedCount  = 0

  for (const item of items) {
    if (item.estimatedSubtotal !== null) {
      totalEstimated += item.estimatedSubtotal
      totalLow       += item.lowSubtotal  ?? 0
      totalHigh      += item.highSubtotal ?? 0
      valuedCount++
    } else {
      unvaluedCount++
    }
  }

  const total = valuedCount + unvaluedCount
  const coveragePercent = total > 0 ? Math.round((valuedCount / total) * 100) : 0

  return {
    asOf,
    items,
    totalEstimated,
    totalLow,
    totalHigh,
    valuedCount,
    unvaluedCount,
    coveragePercent,
  }
}
