// 17D: DB query layer for CatalogModel sales performance analytics. Read-only,
// admin-only (see page-level isAdminAuthenticated gate). Separate module from
// businessAnalyticsQuery.ts (already large) — reuses its date/money conventions,
// never duplicates sale-truth predicates.
//
// Attribution: ItemInstance.catalogId is a REQUIRED (non-nullable) field in the
// current schema, and CatalogModel merges (mergeCatalogModels) reassign every
// ItemInstance.catalogId to the canonical model before deleting the duplicate —
// so in the CURRENT domain, every completed sale's physical item always has a
// valid CatalogModel. Coverage is still computed defensively (never assumed),
// so this file stays correct if that constraint is ever relaxed; today it will
// always report 100% attribution — that is the honest current answer, not a bug.
// See businessAnalyticsQuery.ts's OrderItem/GMV invariant comment for the
// "1 OrderItem row = 1 physical unit" rule this file also relies on.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { DateRange } from '@/lib/businessAnalyticsDates'
import { decimalFromFloatDollars, sumDecimal, daysBetween, DECIMAL_ZERO } from '@/lib/businessAnalyticsMath'

function rangeWhere(field: string, range: DateRange) {
  return range.start ? { [field]: { gte: range.start, lt: range.end } } : { [field]: { lt: range.end } }
}

function rangeSql(column: string, range: DateRange): Prisma.Sql {
  return range.start
    ? Prisma.sql`AND ${Prisma.raw(column)} >= ${range.start} AND ${Prisma.raw(column)} < ${range.end}`
    : Prisma.sql`AND ${Prisma.raw(column)} < ${range.end}`
}

function median(days: number[]): number | null {
  if (days.length === 0) return null
  const sorted = [...days].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

// ── Coverage: period totals vs catalog-attributed totals ─────────────────────────
// Reuses the EXACT existing "completed sale" predicate (Order.status = complete,
// completedAt in range) — this is not a new definition of a sale, just a grouping
// of the same OrderItem rows businessAnalyticsQuery.ts's own units_sold/GMV use.

export type CatalogAttributionCoverage = {
  periodUnits: number
  periodGmv: Prisma.Decimal
  attributedUnits: number
  attributedGmv: Prisma.Decimal
}

export async function getCatalogAttributionCoverage(range: DateRange): Promise<CatalogAttributionCoverage> {
  const rows = await prisma.orderItem.findMany({
    where: { order: { status: 'complete', ...rangeWhere('completedAt', range) } },
    select: { price: true, item: { select: { catalogId: true } } },
  })
  const attributed = rows.filter(r => r.item.catalogId !== null)
  return {
    periodUnits: rows.length,
    periodGmv: sumDecimal(rows.map(r => decimalFromFloatDollars(r.price))),
    attributedUnits: attributed.length,
    attributedGmv: sumDecimal(attributed.map(r => decimalFromFloatDollars(r.price))),
  }
}

// ── Ranked/paginated model-performance table ──────────────────────────────────────
//
// Population is always "CatalogModels with >=1 completed sale in the selected
// period" (the unitsSold CTE) — sorting by availableCopies/wantedCount reorders
// that SAME population, it never widens it to every model that merely has stock
// or Wanted interest (that's the separate no-supply section below). Sort/pagination
// happen in Postgres (CTE + keyset cursor, mirroring getSellerPerformancePage's
// proven architecture) — only the returned page's <=50 catalogModelIds are then
// hydrated with display columns.

export type CatalogModelSortKey = 'unitsSold' | 'gmv' | 'medianDaysToSell' | 'availableCopies' | 'wantedCount'

export type CatalogModelRow = {
  catalogModelId: string
  brand: string
  name: string
  year: number | null
  series: string | null
  scale: string | null
  unitsSold: number
  gmv: Prisma.Decimal
  medianDaysToSell: number | null
  availableCopies: number
  wantedCount: number
}

const MODEL_PAGE_SIZE = 50

type ModelPointer = { catalogModelId: string; value: number }

function unitsSoldCte(range: DateRange): Prisma.Sql {
  return Prisma.sql`
    SELECT i."catalogId" AS catalog_model_id, COUNT(*)::float8 AS value
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    JOIN "ItemInstance" i ON i.id = oi."itemId"
    WHERE o.status = 'complete' ${rangeSql('o."completedAt"', range)}
    GROUP BY i."catalogId"
  `
}

// Float sum here is a SORT KEY only — cheap and fine for ordering. The DISPLAYED
// GMV is always recomputed Decimal-safe in hydrateModelPage, never read from here.
function gmvCte(range: DateRange): Prisma.Sql {
  return Prisma.sql`
    SELECT i."catalogId" AS catalog_model_id, SUM(oi.price)::float8 AS value
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    JOIN "ItemInstance" i ON i.id = oi."itemId"
    WHERE o.status = 'complete' ${rangeSql('o."completedAt"', range)}
    GROUP BY i."catalogId"
  `
}

// Same duration semantics as the overview's median days-to-sell: Order.completedAt
// - ItemInstance.createdAt (intake-to-sale), never Listing.createdAt. Negative
// durations excluded via the >= guard — never a fabricated negative "days to sell".
function medianDaysToSellCte(range: DateRange): Prisma.Sql {
  return Prisma.sql`
    SELECT i."catalogId" AS catalog_model_id,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."completedAt" - i."createdAt")) / 86400.0) AS value
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    JOIN "ItemInstance" i ON i.id = oi."itemId"
    WHERE o.status = 'complete' AND o."completedAt" IS NOT NULL AND o."completedAt" >= i."createdAt" ${rangeSql('o."completedAt"', range)}
    GROUP BY i."catalogId"
  `
}

// Current snapshot — no date filter, no DateRange parameter (mirrors 17C's own
// lifetime-CTE convention: takes no `range` argument at all, not just "ignores it").
// Same eligibility predicate as listingEligibility.ts's eligibleListingWhere
// (Listing.status='active' AND item.status='available'), expressed in raw SQL
// because this CTE must GROUP BY the item's catalogId, which Prisma's groupBy
// cannot express across a relation.
function availableCopiesCte(): Prisma.Sql {
  return Prisma.sql`
    SELECT i."catalogId" AS catalog_model_id, COUNT(*)::float8 AS value
    FROM "ItemInstance" i
    JOIN "Listing" l ON l."itemId" = i.id
    WHERE l.status = 'active' AND i.status = 'available'
    GROUP BY i."catalogId"
  `
}

// Current snapshot — no date filter. WantedCatalogModel has a unique
// (customerProfileId, catalogModelId) constraint, so plain COUNT(*) already equals
// the distinct-customer count — no DISTINCT needed.
function wantedCountCte(): Prisma.Sql {
  return Prisma.sql`
    SELECT w."catalogModelId" AS catalog_model_id, COUNT(*)::float8 AS value
    FROM "WantedCatalogModel" w
    GROUP BY w."catalogModelId"
  `
}

function metricCteFor(sortKey: CatalogModelSortKey, range: DateRange): Prisma.Sql {
  switch (sortKey) {
    case 'unitsSold': return unitsSoldCte(range)
    case 'gmv': return gmvCte(range)
    case 'medianDaysToSell': return medianDaysToSellCte(range)
    case 'availableCopies': return availableCopiesCte()
    case 'wantedCount': return wantedCountCte()
  }
}

// Keyset cursor pagination, mixed-direction (value DESC, catalogModelId ASC) tie-
// break — same predicate shape as fetchSellerSortPage in businessAnalyticsQuery.ts,
// proven correct there for a same-value tie boundary larger than one page.
async function fetchModelSortPage(range: DateRange, sortKey: CatalogModelSortKey, cursor: ModelPointer | null): Promise<ModelPointer[]> {
  const soldCte = unitsSoldCte(range) // population anchor: models with >=1 sale in period
  const metricCte = metricCteFor(sortKey, range)

  const rows = await prisma.$queryRaw<Array<{ catalog_model_id: string; value: number | null }>>`
    WITH sold AS (${soldCte}), metric AS (${metricCte})
    SELECT sold.catalog_model_id AS catalog_model_id, COALESCE(metric.value, -1) AS value
    FROM sold
    LEFT JOIN metric ON metric.catalog_model_id = sold.catalog_model_id
    ${cursor ? Prisma.sql`WHERE COALESCE(metric.value, -1) < ${cursor.value}::float8
      OR (COALESCE(metric.value, -1) = ${cursor.value}::float8 AND sold.catalog_model_id > ${cursor.catalogModelId}::text)` : Prisma.empty}
    ORDER BY COALESCE(metric.value, -1) DESC, sold.catalog_model_id ASC
    LIMIT ${MODEL_PAGE_SIZE + 1}
  `
  return rows.map(r => ({ catalogModelId: r.catalog_model_id, value: r.value ?? -1 }))
}

// Hydrates display-only columns for exactly the page's catalogModelIds (<=50) —
// every query below is scoped with `{ in: pageIds }`, never the full CatalogModel
// table. GMV/median are recomputed here (not read from the sort CTE) so the
// DISPLAYED GMV stays Decimal-safe and the median stays consistent with the
// overview's own JS-median convention (Part M) rather than SQL PERCENTILE_CONT.
async function hydrateModelPage(range: DateRange, pageIds: string[]): Promise<Map<string, CatalogModelRow>> {
  const out = new Map<string, CatalogModelRow>()
  if (pageIds.length === 0) return out

  const [models, salesRows, availableGroups, wantedGroups] = await Promise.all([
    prisma.catalogModel.findMany({ where: { id: { in: pageIds } }, select: { id: true, brand: true, name: true, year: true, series: true, scale: true } }),
    prisma.orderItem.findMany({
      where: { order: { status: 'complete', ...rangeWhere('completedAt', range) }, item: { catalogId: { in: pageIds } } },
      select: { price: true, item: { select: { catalogId: true, createdAt: true } }, order: { select: { completedAt: true } } },
    }),
    prisma.itemInstance.groupBy({ by: ['catalogId'], where: { catalogId: { in: pageIds }, status: 'available', listing: { status: 'active' } }, _count: { id: true } }),
    prisma.wantedCatalogModel.groupBy({ by: ['catalogModelId'], where: { catalogModelId: { in: pageIds } }, _count: { id: true } }),
  ])

  const unitsByModel = new Map<string, number>()
  const gmvByModel = new Map<string, Prisma.Decimal>()
  const durationsByModel = new Map<string, number[]>()
  for (const row of salesRows) {
    const id = row.item.catalogId
    unitsByModel.set(id, (unitsByModel.get(id) ?? 0) + 1)
    gmvByModel.set(id, (gmvByModel.get(id) ?? DECIMAL_ZERO).plus(decimalFromFloatDollars(row.price)))
    if (row.order.completedAt) {
      const d = daysBetween(row.item.createdAt, row.order.completedAt)
      if (d >= 0) {
        if (!durationsByModel.has(id)) durationsByModel.set(id, [])
        durationsByModel.get(id)!.push(d)
      }
    }
  }
  const availableByModel = new Map(availableGroups.map(g => [g.catalogId, g._count.id]))
  const wantedByModel = new Map(wantedGroups.map(g => [g.catalogModelId, g._count.id]))

  for (const m of models) {
    out.set(m.id, {
      catalogModelId: m.id,
      brand: m.brand,
      name: m.name,
      year: m.year,
      series: m.series,
      scale: m.scale,
      unitsSold: unitsByModel.get(m.id) ?? 0,
      gmv: gmvByModel.get(m.id) ?? DECIMAL_ZERO,
      medianDaysToSell: median(durationsByModel.get(m.id) ?? []),
      availableCopies: availableByModel.get(m.id) ?? 0,
      wantedCount: wantedByModel.get(m.id) ?? 0,
    })
  }
  return out
}

export async function getCatalogModelPerformancePage(
  range: DateRange,
  sort: CatalogModelSortKey,
  cursor: ModelPointer | null,
): Promise<{ items: CatalogModelRow[]; nextCursor: ModelPointer | null }> {
  const pointers = await fetchModelSortPage(range, sort, cursor)
  if (pointers.length === 0) return { items: [], nextCursor: null }

  const hasMore = pointers.length > MODEL_PAGE_SIZE
  const pagePointers = hasMore ? pointers.slice(0, MODEL_PAGE_SIZE) : pointers
  const hydrated = await hydrateModelPage(range, pagePointers.map(p => p.catalogModelId))

  const items = pagePointers.map(p => hydrated.get(p.catalogModelId)).filter((r): r is CatalogModelRow => r !== undefined)
  const last = pagePointers[pagePointers.length - 1]
  return { items, nextCursor: hasMore ? { value: last.value, catalogModelId: last.catalogModelId } : null }
}

// ── Wanted with no available copies (current snapshot only) ──────────────────────
// Deliberately independent of the sales-table population above — a model can
// belong here with zero period sales, or even zero Listings ever (Parts T/U): the
// NOT EXISTS predicate only requires the absence of a currently-eligible Listing,
// never a Listing row's presence/history. availableCopies is always 0 by
// construction, so it is not separately queried.
//
// 17D final reconciliation (Part 1): bounded to NO_SUPPLY_LIMIT, same LIMIT+1/slice
// "hasMore" trick as the main model table — so the page can tell the admin this is
// a shortlist (ordered by Wanted desc) rather than silently truncating an unbounded
// result with no cue. No full pagination — this section is intentionally compact.

export type WantedNoSupplyRow = {
  catalogModelId: string
  brand: string
  name: string
  year: number | null
  series: string | null
  scale: string | null
  wantedCount: number
  availableCopies: 0
}

const NO_SUPPLY_LIMIT = 50

// 17E: `limit` is optional (defaults to the existing NO_SUPPLY_LIMIT, so every
// pre-existing call site is byte-equivalent) purely so the management summary can
// request a small shortlist (e.g. 5) without a second query/implementation —
// same ordering, same NOT EXISTS predicate, same truncation semantics either way.
export async function getWantedWithNoSupply(limit: number = NO_SUPPLY_LIMIT): Promise<{ items: WantedNoSupplyRow[]; truncated: boolean }> {
  const rows = await prisma.$queryRaw<Array<{ catalog_model_id: string; wanted_count: number }>>`
    SELECT w."catalogModelId" AS catalog_model_id, COUNT(*)::float8 AS wanted_count
    FROM "WantedCatalogModel" w
    WHERE NOT EXISTS (
      SELECT 1 FROM "Listing" l
      JOIN "ItemInstance" i ON i.id = l."itemId"
      WHERE i."catalogId" = w."catalogModelId" AND l.status = 'active' AND i.status = 'available'
    )
    GROUP BY w."catalogModelId"
    ORDER BY wanted_count DESC, w."catalogModelId" ASC
    LIMIT ${limit + 1}
  `
  if (rows.length === 0) return { items: [], truncated: false }

  const truncated = rows.length > limit
  const pageRows = truncated ? rows.slice(0, limit) : rows

  const ids = pageRows.map(r => r.catalog_model_id)
  const models = await prisma.catalogModel.findMany({ where: { id: { in: ids } }, select: { id: true, brand: true, name: true, year: true, series: true, scale: true } })
  const byId = new Map(models.map(m => [m.id, m]))

  const items = pageRows.map(r => {
    const m = byId.get(r.catalog_model_id)!
    return { catalogModelId: r.catalog_model_id, brand: m.brand, name: m.name, year: m.year, series: m.series, scale: m.scale, wantedCount: r.wanted_count, availableCopies: 0 as const }
  })
  return { items, truncated }
}
