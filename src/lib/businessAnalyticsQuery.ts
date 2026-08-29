// 14B: DB query layer for business analytics. Read-only. SQL/Prisma aggregation
// where practical; no unbounded findMany() on ItemInstance/Order/OrderItem/
// SellerPayoutLine. No buyer/seller PII selected anywhere in this file.
//
// GMV invariant: OrderItem has no `quantity` field — each row is the full line price
// for exactly one physical ItemInstance (createOrder creates one OrderItem per listing/
// item; an item can only ever be sold once, since its status leaves 'available' the
// moment it's reserved). GMV = sum(OrderItem.price) is therefore already the full
// per-unit-times-quantity total with no separate multiplication needed. This is used
// identically everywhere GMV appears (overview, revenue, seller table, CSV).

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { DateRange, BucketGranularity } from '@/lib/businessAnalyticsDates'
import { chooseBucketGranularity, bucketStart, advanceBucket } from '@/lib/businessAnalyticsDates'
import { decimalFromFloatDollars, sumDecimal, subtractDecimal, daysBetween, DECIMAL_ZERO } from '@/lib/businessAnalyticsMath'
// 17C: reuse 15N's authoritative ownership classification instead of the analytics
// layer's own inverse-of-consignment proxy (`sourceType !== 'consignment'`), which
// silently treated null/unknown sourceType (e.g. items created via the manual admin
// item form, which has no sourceType field at all) as owned. isOwnedSourceType is an
// exact allowlist (buyout/company_owned); isConsignmentSourceType is unchanged
// (=== 'consignment'). Anything that is neither is excluded from BOTH gross spread
// and gross margin — it still counts in GMV/units sold, computed independently above.
import { isOwnedSourceType, isConsignmentSourceType } from '@/lib/financialPosition'

function rangeWhere(field: string, range: DateRange) {
  return range.start ? { [field]: { gte: range.start, lt: range.end } } : { [field]: { lt: range.end } }
}

// ── Overview ─────────────────────────────────────────────────────────────────────

export type OverviewMetrics = {
  unitsSold: number
  completedOrders: number
  gmv: Prisma.Decimal
  // Gross spread (consignment) and gross margin (buyout/company-owned) are DIFFERENT
  // economic measures over DIFFERENT item populations — see businessAnalyticsRegistry.ts.
  // They are kept as separate fields everywhere (never summed into one blended number)
  // so no KPI/label can imply a figure is consignment-only, or company-wide, when it
  // is actually the other, or a mix of both. Neither is audited net revenue — see
  // "marketplace_revenue" in the registry for why that figure is reported unavailable.
  grossSpreadDetermined: Prisma.Decimal
  grossSpreadUndeterminedItems: number
  grossMarginDetermined: Prisma.Decimal
  grossMarginUndeterminedItems: number
  activeInventory: number
  sellThrough: { numerator: number; denominator: number }
  medianDaysToSell: number | null
  daysToSellInvalidCount: number
  listingToSale: { numerator: number; denominator: number }
  unpaidSellerLiability: Prisma.Decimal
  sellersWithCompletedSales: number
}

export async function getOverviewMetrics(range: DateRange): Promise<OverviewMetrics> {
  const [
    unitsSoldRows, completedOrderCount, activeInventory,
    sellThroughCohort, listingCohort, liability, sellerCount,
  ] = await Promise.all([
    prisma.orderItem.findMany({
      where: { order: { status: 'complete', ...rangeWhere('completedAt', range) } },
      select: {
        id: true,
        itemId: true,
        price: true,
        item: { select: { sourceType: true, purchasePrice: true, createdAt: true } },
        order: { select: { completedAt: true } },
      },
    }),
    prisma.order.count({ where: { status: 'complete', ...rangeWhere('completedAt', range) } }),
    prisma.itemInstance.count({ where: { status: { in: ['available', 'reserved'] } } }),
    getSellThroughCohortCounts(range),
    getListingConversionCohortCounts(range),
    getOutstandingLiability(),
    getSellersWithCompletedSalesCount(range),
  ])

  const gmv = sumDecimal(unitsSoldRows.map(r => decimalFromFloatDollars(r.price)))
  const spreadAndMargin = await computeGrossSpreadAndMargin(unitsSoldRows.map(r => ({ id: r.id, price: r.price, sourceType: r.item.sourceType, purchasePrice: r.item.purchasePrice })))

  const seenItemIds = new Set<string>()
  const durations: number[] = []
  let daysToSellInvalidCount = 0
  for (const r of unitsSoldRows) {
    if (r.order.completedAt === null) { daysToSellInvalidCount++; continue }
    if (seenItemIds.has(r.itemId)) { daysToSellInvalidCount++; continue } // defensive: should never happen
    seenItemIds.add(r.itemId)
    const d = daysBetween(r.item.createdAt, r.order.completedAt)
    if (d < 0) { daysToSellInvalidCount++; continue } // negative duration is invalid data — counted, not silently dropped
    durations.push(d)
  }
  const medianDaysToSell = durations.length > 0 ? [...durations].sort((a, b) => a - b)[Math.floor((durations.length - 1) / 2)] : null

  return {
    unitsSold: unitsSoldRows.length,
    completedOrders: completedOrderCount,
    gmv,
    grossSpreadDetermined: spreadAndMargin.grossSpread,
    grossSpreadUndeterminedItems: spreadAndMargin.undeterminedConsignment,
    grossMarginDetermined: spreadAndMargin.grossMargin,
    grossMarginUndeterminedItems: spreadAndMargin.undeterminedOther,
    activeInventory,
    sellThrough: sellThroughCohort,
    medianDaysToSell,
    daysToSellInvalidCount,
    listingToSale: listingCohort,
    unpaidSellerLiability: liability,
    sellersWithCompletedSales: sellerCount,
  }
}

// "Gross spread" (consignment: grossSalePrice − netAmount) and "gross margin"
// (buyout/company-owned: price − purchasePrice) are computed over disjoint item
// populations and returned SEPARATELY — see businessAnalyticsRegistry.ts. They are
// never summed into one blended figure: doing so would let a single number silently
// mix commission-withheld (consignment) with cost-of-goods margin (buyout/company-
// owned), which are not comparable/interchangeable economics. Neither is audited net
// revenue; payment-processing fees are not deducted from either.
async function computeGrossSpreadAndMargin(
  items: Array<{ id: string; price: number; sourceType: string | null; purchasePrice: number | null }>,
): Promise<{ grossSpread: Prisma.Decimal; undeterminedConsignment: number; grossMargin: Prisma.Decimal; undeterminedOther: number }> {
  const consignmentItems = items.filter(i => isConsignmentSourceType(i.sourceType))
  const otherItems = items.filter(i => isOwnedSourceType(i.sourceType))

  const payoutLines = consignmentItems.length > 0
    ? await prisma.sellerPayoutLine.findMany({
        where: { lineType: 'consignment', orderItemId: { in: consignmentItems.map(i => i.id) } },
        select: { grossSalePrice: true, netAmount: true },
      })
    : []
  const grossSpread = sumDecimal(payoutLines.map(l => subtractDecimal(l.grossSalePrice ?? DECIMAL_ZERO, l.netAmount)))
  // Consignment items sold without a (yet) matching payout line are undetermined.
  const undeterminedConsignment = Math.max(0, consignmentItems.length - payoutLines.length)

  let grossMargin = DECIMAL_ZERO
  let undeterminedOther = 0
  for (const item of otherItems) {
    if (item.purchasePrice === null) { undeterminedOther++; continue }
    grossMargin = grossMargin.plus(subtractDecimal(decimalFromFloatDollars(item.price), decimalFromFloatDollars(item.purchasePrice)))
  }

  return { grossSpread, undeterminedConsignment, grossMargin, undeterminedOther }
}

// ── Inventory ────────────────────────────────────────────────────────────────────

export type InventorySnapshot = {
  total: number
  available: number
  reserved: number
  sold: number
  draft: number
  notForSale: number
  listedActive: number
  soldDuringPeriod: number
}

export async function getInventorySnapshot(range: DateRange): Promise<InventorySnapshot> {
  const [statusGroups, listedActive, soldDuringPeriod, total] = await Promise.all([
    prisma.itemInstance.groupBy({ by: ['status'], _count: { id: true } }),
    prisma.itemInstance.count({ where: { listing: { status: 'active' } } }),
    prisma.orderItem.count({ where: { order: { status: 'complete', ...rangeWhere('completedAt', range) } } }),
    prisma.itemInstance.count(),
  ])
  const byStatus: Record<string, number> = {}
  for (const g of statusGroups) byStatus[g.status] = g._count.id

  return {
    total,
    available: byStatus['available'] ?? 0,
    reserved: byStatus['reserved'] ?? 0,
    sold: byStatus['sold'] ?? 0,
    draft: byStatus['draft'] ?? 0,
    notForSale: byStatus['not_for_sale'] ?? 0,
    listedActive,
    soldDuringPeriod,
  }
}

const AGING_BUCKETS = [
  { key: '0-30', minDays: 0, maxDays: 30 },
  { key: '31-60', minDays: 31, maxDays: 60 },
  { key: '61-90', minDays: 61, maxDays: 90 },
  { key: '91-180', minDays: 91, maxDays: 180 },
  { key: '181+', minDays: 181, maxDays: null as number | null },
] as const

export type AgingBucket = { key: string; units: number; pct: number }

// Aging is computed over CURRENT unsold inventory, using ItemInstance.createdAt (the
// authoritative intake timestamp) — never CatalogModel.createdAt.
export async function getInventoryAging(asOf: Date): Promise<AgingBucket[]> {
  const counts = await Promise.all(
    AGING_BUCKETS.map(b => {
      const upper = new Date(asOf.getTime() - b.minDays * 86_400_000)
      const lower = b.maxDays !== null ? new Date(asOf.getTime() - (b.maxDays + 1) * 86_400_000) : null
      return prisma.itemInstance.count({
        where: {
          status: { not: 'sold' },
          createdAt: lower ? { gt: lower, lte: upper } : { lte: upper },
        },
      })
    }),
  )
  const total = counts.reduce((s, c) => s + c, 0)
  return AGING_BUCKETS.map((b, i) => ({ key: b.key, units: counts[i], pct: total > 0 ? (counts[i] / total) * 100 : 0 }))
}

export type DaysToSellRow = { intakeAt: Date; soldAt: Date }

// Bounded by order volume in the period (a flow query), not the full ItemInstance table.
export type DaysToSellResult = { durations: number[]; invalidCount: number }

// Only OrderItem rows on Order.status = 'complete' are considered — a cancelled order
// can never complete, and once an item is sold it can never be reserved/ordered again,
// so each sold ItemInstance maps to at most one completed OrderItem. itemId duplicates
// among completed orders (which should be structurally impossible) are defensively
// detected and counted as invalid rather than silently double-counted.
export async function getDaysToSellDurations(range: DateRange): Promise<DaysToSellResult> {
  const rows = await prisma.orderItem.findMany({
    where: { order: { status: 'complete', ...rangeWhere('completedAt', range) } },
    select: { itemId: true, item: { select: { createdAt: true } }, order: { select: { completedAt: true } } },
  })

  const seenItemIds = new Set<string>()
  const durations: number[] = []
  let invalidCount = 0
  for (const r of rows) {
    if (r.order.completedAt === null) { invalidCount++; continue }
    if (seenItemIds.has(r.itemId)) { invalidCount++; continue } // defensive: should never happen
    seenItemIds.add(r.itemId)
    const d = daysBetween(r.item.createdAt, r.order.completedAt)
    if (d < 0) { invalidCount++; continue } // negative duration is invalid data — counted, not silently dropped
    durations.push(d)
  }
  return { durations, invalidCount }
}

async function getSellThroughCohortCounts(range: DateRange): Promise<{ numerator: number; denominator: number }> {
  const [denominator, numerator] = await Promise.all([
    prisma.itemInstance.count({ where: rangeWhere('createdAt', range) }),
    prisma.itemInstance.count({ where: { status: 'sold', ...rangeWhere('createdAt', range) } }),
  ])
  return { numerator, denominator }
}

export async function getSellThroughCohort(range: DateRange) {
  return getSellThroughCohortCounts(range)
}

// ── Conversion ───────────────────────────────────────────────────────────────────

async function getListingConversionCohortCounts(range: DateRange): Promise<{ numerator: number; denominator: number }> {
  const [denominator, numerator] = await Promise.all([
    prisma.listing.count({ where: rangeWhere('createdAt', range) }),
    prisma.listing.count({ where: { status: 'sold', ...rangeWhere('createdAt', range) } }),
  ])
  return { numerator, denominator }
}

export type ConversionFunnel = {
  listingsCreated: number
  itemsEnteringReservation: number
  ordersCreated: number
  paymentsCompleted: number
  completedOrders: number
  unitsSold: number
  listingToSale: { numerator: number; denominator: number }
  orderCompletion: { numerator: number; denominator: number }
  cancellationRate: { numerator: number; denominator: number }
}

export async function getConversionFunnel(range: DateRange): Promise<ConversionFunnel> {
  const [
    listingsCreated, itemsEnteringReservation, ordersCreated, paymentsCompleted,
    completedOrders, unitsSold, listingToSale, cancelledOrders,
  ] = await Promise.all([
    prisma.listing.count({ where: rangeWhere('createdAt', range) }),
    prisma.orderItem.count({ where: { order: rangeWhere('createdAt', range) } }), // reservation happens atomically with order creation
    prisma.order.count({ where: rangeWhere('createdAt', range) }),
    prisma.order.count({ where: { paymentStatus: 'paid', ...rangeWhere('paidAt', range) } }),
    prisma.order.count({ where: { status: 'complete', ...rangeWhere('completedAt', range) } }),
    prisma.orderItem.count({ where: { order: { status: 'complete', ...rangeWhere('completedAt', range) } } }),
    getListingConversionCohortCounts(range),
    prisma.order.count({ where: { status: 'cancelled', ...rangeWhere('createdAt', range) } }),
  ])
  const ordersInPeriod = ordersCreated

  return {
    listingsCreated,
    itemsEnteringReservation,
    ordersCreated,
    paymentsCompleted,
    completedOrders,
    unitsSold,
    listingToSale,
    orderCompletion: { numerator: completedOrders, denominator: ordersInPeriod },
    cancellationRate: { numerator: cancelledOrders, denominator: ordersInPeriod },
  }
}

// ── Payout liability ─────────────────────────────────────────────────────────────

export type PayoutLiabilitySnapshot = {
  eligibleNoPayout: Prisma.Decimal
  held: Prisma.Decimal
  inDraftPayout: Prisma.Decimal
  inApprovedPayout: Prisma.Decimal
  paidTotal: Prisma.Decimal
  voidedTotal: Prisma.Decimal
  outstanding: Prisma.Decimal
  sellersWithOutstanding: number
}

async function sumLineNet(where: Prisma.SellerPayoutLineWhereInput): Promise<Prisma.Decimal> {
  const agg = await prisma.sellerPayoutLine.aggregate({ where, _sum: { netAmount: true } })
  return agg._sum.netAmount ?? DECIMAL_ZERO
}

// 16B focused-review: the ONE authoritative "what counts as outstanding seller
// payout liability" predicate — exported so a customer-scoped caller (16B's
// accountOverviewQuery.ts) can reuse it verbatim (with a customerProfileId filter
// ANDed in) instead of hand-copying an equivalent-looking where-shape that could
// silently drift from this definition over time. Never mutated/widened per-caller —
// callers only ever narrow it further (by customerProfileId), never redefine it.
export function outstandingPayoutLineWhere(customerProfileId?: string): Prisma.SellerPayoutLineWhereInput {
  return {
    ...(customerProfileId ? { customerProfileId } : {}),
    status: { in: ['eligible', 'held'] },
    OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }],
  }
}

// Edge-case behavior, confirmed against the actual schema/action code
// (sellerPayoutCalculation.ts, actions/sellerPayouts.ts):
//   - No double-counting: SellerPayoutLine.orderItemId is @unique and sourceKey is
//     @unique (one line per sale/agreement, ever); payoutId is a single nullable FK
//     (a line belongs to at most one payout at a time); removeLineFromDraftPayout only
//     operates on 'draft' payouts, so a line already in an 'approved'/'paid' payout can
//     never be pulled out and reassigned elsewhere.
//   - No 'failed' payout status exists in this schema (only draft/approved/paid) — a
//     line that never gets marked paid simply remains outstanding indefinitely; there
//     is no distinct "failed" bucket to report.
//   - Voided lines (voidSellerPayoutLine) are excluded from liability — correct, they
//     represent a cancelled obligation.
//   - There is no "replacement payout" mechanism and SellerPayout rows are never
//     removed anywhere in the codebase — payouts only ever move forward
//     draft -> approved -> paid, so "orphan payout line" (payoutId pointing at a
//     deleted payout) cannot occur via application code.
//   - Partial payment is NOT representable: markSellerPayoutPaid transitions the whole
//     payout (and therefore all of its lines) atomically from 'approved' to 'paid' —
//     there is no partial-amount-paid field. Liability is therefore always all-or-
//     nothing per payout, not per-line partial.
export async function getOutstandingLiability(): Promise<Prisma.Decimal> {
  return sumLineNet(outstandingPayoutLineWhere())
}

export async function getPayoutLiabilitySnapshot(): Promise<PayoutLiabilitySnapshot> {
  const [eligibleNoPayout, held, inDraftPayout, inApprovedPayout, paidTotal, voidedTotal, outstanding, outstandingSellers] = await Promise.all([
    sumLineNet({ status: 'eligible', payoutId: null }),
    sumLineNet({ status: 'held' }),
    sumLineNet({ status: { not: 'voided' }, payout: { status: 'draft' } }),
    sumLineNet({ status: { not: 'voided' }, payout: { status: 'approved' } }),
    sumLineNet({ payout: { status: 'paid' } }),
    sumLineNet({ status: 'voided' }),
    getOutstandingLiability(),
    prisma.sellerPayoutLine.groupBy({
      by: ['customerProfileId'],
      where: { status: { in: ['eligible', 'held'] }, OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }] },
    }),
  ])
  return { eligibleNoPayout, held, inDraftPayout, inApprovedPayout, paidTotal, voidedTotal, outstanding, sellersWithOutstanding: outstandingSellers.length }
}

export type LiabilityAgingBucket = { key: string; amount: Prisma.Decimal; count: number }

// No due-date field exists — buckets are labeled "Liability age" (from eligibleAt),
// never "overdue".
export async function getLiabilityAging(asOf: Date): Promise<LiabilityAgingBucket[]> {
  const buckets = [
    { key: '0-7', minDays: 0, maxDays: 7 },
    { key: '8-14', minDays: 8, maxDays: 14 },
    { key: '15-30', minDays: 15, maxDays: 30 },
    { key: '31+', minDays: 31, maxDays: null as number | null },
  ]
  const outstandingWhere = outstandingPayoutLineWhere()
  const results = await Promise.all(
    buckets.map(async b => {
      const upper = new Date(asOf.getTime() - b.minDays * 86_400_000)
      const lower = b.maxDays !== null ? new Date(asOf.getTime() - (b.maxDays + 1) * 86_400_000) : null
      const where: Prisma.SellerPayoutLineWhereInput = { ...outstandingWhere, eligibleAt: lower ? { gt: lower, lte: upper } : { lte: upper } }
      const [sum, count] = await Promise.all([
        prisma.sellerPayoutLine.aggregate({ where, _sum: { netAmount: true } }),
        prisma.sellerPayoutLine.count({ where }),
      ])
      return { key: b.key, amount: sum._sum.netAmount ?? DECIMAL_ZERO, count }
    }),
  )
  return results
}

export type PayoutFlow = { paidDuringPeriod: Prisma.Decimal; paidCount: number; newLiabilityDuringPeriod: Prisma.Decimal }

export async function getPayoutFlow(range: DateRange): Promise<PayoutFlow> {
  const [paidAgg, paidCount, newLiability] = await Promise.all([
    prisma.sellerPayoutLine.aggregate({ where: { payout: { status: 'paid', ...rangeWhere('paidAt', range) } }, _sum: { netAmount: true } }),
    prisma.sellerPayoutLine.count({ where: { payout: { status: 'paid', ...rangeWhere('paidAt', range) } } }),
    sumLineNet({ status: { not: 'voided' }, ...rangeWhere('eligibleAt', range) }),
  ])
  return { paidDuringPeriod: paidAgg._sum.netAmount ?? DECIMAL_ZERO, paidCount, newLiabilityDuringPeriod: newLiability }
}

// ── Revenue ──────────────────────────────────────────────────────────────────────

export type RevenueBreakdown = {
  gmv: Prisma.Decimal
  // "grossSpread"/"grossMargin" — amount withheld from seller / sale-minus-cost. NOT
  // audited net revenue (payment-processing fees, refunds, etc. are not deducted).
  // "Marketplace revenue" itself is not available from this data model — see registry.
  consignment: { gmv: Prisma.Decimal; sellerProceeds: Prisma.Decimal; grossSpread: Prisma.Decimal; items: number }
  costBased: { gmv: Prisma.Decimal; grossMargin: Prisma.Decimal; items: number; undeterminedItems: number; undeterminedGmv: Prisma.Decimal }
  sellerProceedsFlow: Prisma.Decimal // all payout lines eligible in period (consignment + buyout), excluding voided
  reconciliationDifference: Prisma.Decimal
}

export async function getRevenueBreakdown(range: DateRange): Promise<RevenueBreakdown> {
  const items = await prisma.orderItem.findMany({
    where: { order: { status: 'complete', ...rangeWhere('completedAt', range) } },
    select: { id: true, price: true, orderId: true, item: { select: { sourceType: true, purchasePrice: true } } },
  })

  const consignmentItems = items.filter(i => isConsignmentSourceType(i.item.sourceType))
  const costBasedItems = items.filter(i => isOwnedSourceType(i.item.sourceType))

  const payoutLines = consignmentItems.length > 0
    ? await prisma.sellerPayoutLine.findMany({
        where: { lineType: 'consignment', orderItemId: { in: consignmentItems.map(i => i.id) } },
        select: { orderItemId: true, grossSalePrice: true, netAmount: true },
      })
    : []
  const lineByOrderItem = new Map(payoutLines.map(l => [l.orderItemId as string, l]))

  let consignmentGmv = DECIMAL_ZERO
  let consignmentSellerProceeds = DECIMAL_ZERO
  let consignmentSpread = DECIMAL_ZERO
  for (const ci of consignmentItems) {
    const line = lineByOrderItem.get(ci.id)
    if (!line) continue // undetermined — excluded, not zero-filled
    consignmentGmv = consignmentGmv.plus(line.grossSalePrice ?? decimalFromFloatDollars(ci.price))
    consignmentSellerProceeds = consignmentSellerProceeds.plus(line.netAmount)
    consignmentSpread = consignmentSpread.plus(subtractDecimal(line.grossSalePrice ?? decimalFromFloatDollars(ci.price), line.netAmount))
  }

  let costGmv = DECIMAL_ZERO
  let costMargin = DECIMAL_ZERO
  let undeterminedGmv = DECIMAL_ZERO
  let undeterminedCount = 0
  let determinedCostItems = 0
  for (const item of costBasedItems) {
    const price = decimalFromFloatDollars(item.price)
    costGmv = costGmv.plus(price)
    if (item.item.purchasePrice === null) {
      undeterminedGmv = undeterminedGmv.plus(price)
      undeterminedCount++
      continue
    }
    determinedCostItems++
    costMargin = costMargin.plus(subtractDecimal(price, decimalFromFloatDollars(item.item.purchasePrice)))
  }

  const gmv = sumDecimal(items.map(i => decimalFromFloatDollars(i.price)))
  const sellerProceedsFlow = await sumLineNet({ status: { not: 'voided' }, ...rangeWhere('eligibleAt', range) })

  // Reconciliation is only meaningful over the consignment subset, where GMV = seller
  // proceeds + gross spread holds exactly by construction. Buyout/company-owned items'
  // seller cost was paid at an earlier intake date, not from this period's sales.
  const reconciliationDifference = subtractDecimal(consignmentGmv, sumDecimal([consignmentSellerProceeds, consignmentSpread]))

  return {
    gmv,
    consignment: { gmv: consignmentGmv, sellerProceeds: consignmentSellerProceeds, grossSpread: consignmentSpread, items: consignmentItems.length },
    costBased: { gmv: costGmv, grossMargin: costMargin, items: determinedCostItems, undeterminedItems: undeterminedCount, undeterminedGmv },
    sellerProceedsFlow,
    reconciliationDifference,
  }
}

// ── Seller performance ──────────────────────────────────────────────────────────
//
// Sorting/pagination is DB-bounded: each sort key is a Postgres CTE that aggregates
// directly from the source tables and is windowed with LIMIT + a row-value keyset
// cursor — Postgres does the sort and the limit, never the application. Only the
// returned page's profileIds (<=50) are then "hydrated" with the remaining display
// columns, again via queries scoped to just that page — never all sellers.

export type SellerSortKey = 'grossSales' | 'unitsSold' | 'sellThrough' | 'payoutOutstanding' | 'medianDaysToSell'

export type SellerRow = {
  profileId: string
  displayName: string // non-PII: public CustomerCommunityProfile.handle (isPublic only), else a truncated internal ID
  submissions: number
  unitsReceived: number
  unitsListed: number
  unitsSold: number
  sellThrough: number | null
  grossSales: Prisma.Decimal
  sellerProceeds: Prisma.Decimal
  payoutPaid: Prisma.Decimal
  payoutOutstanding: Prisma.Decimal
  medianIntakeToListingDays: number | null
  medianListingToSaleDays: number | null
  rejectionRate: number | null
}

const SELLER_PAGE_SIZE = 50

type SellerPointer = { profileId: string; value: number }

// column is always one of the hardcoded strings below — never user input — so Prisma.raw
// here cannot become a SQL-injection vector.
function rangeSql(column: string, range: DateRange): Prisma.Sql {
  return range.start
    ? Prisma.sql`AND ${Prisma.raw(column)} >= ${range.start} AND ${Prisma.raw(column)} < ${range.end}`
    : Prisma.sql`AND ${Prisma.raw(column)} < ${range.end}`
}

// Runs one sort key's aggregate CTE, LEFT JOINed from the full SellerProfile table so
// zero-value sellers are still reachable — but the JOIN, GROUP BY, ORDER BY, and LIMIT
// all execute in Postgres; only <=51 rows ever cross into the application. Missing
// values are normalized to -1 (every real metric here is >= 0, so -1 can never collide
// with a real value — including a genuine zero, e.g. 0% sell-through or a same-day
// median-days-to-sell), so a plain numeric comparison handles the "no data yet" case
// without NULLS LAST special-casing. COALESCE is applied on both sides of the cursor
// comparison, so SQL NULL never reaches the tuple predicate.
//
// The sort is MIXED-DIRECTION: value DESC (primary), profileId ASC (secondary tiebreak).
// A naive row-value tuple `(value, profileId) < (cursorValue, cursorProfileId)` only
// gives the correct "next page" predicate when both columns sort the same direction —
// with DESC/ASC mixed, that naive form instead re-selects rows already returned on the
// prior page whenever more than one page's worth of rows share the same value (the
// common case: any cohort of tied/no-data sellers larger than SELLER_PAGE_SIZE, e.g.
// many sellers who haven't sold anything yet). The predicate below is written
// per-direction explicitly so pagination is correct across a same-value tie boundary.
async function fetchSellerSortPage(aggCte: Prisma.Sql, cursor: SellerPointer | null): Promise<SellerPointer[]> {
  const rows = await prisma.$queryRaw<Array<{ profile_id: string; value: number | null }>>`
    WITH agg AS (${aggCte})
    SELECT sp."profileId" AS profile_id, agg.value AS value
    FROM "SellerProfile" sp
    LEFT JOIN agg ON agg.profile_id = sp."profileId"
    ${cursor ? Prisma.sql`WHERE COALESCE(agg.value, -1) < ${cursor.value}::float8
      OR (COALESCE(agg.value, -1) = ${cursor.value}::float8 AND sp."profileId" > ${cursor.profileId}::text)` : Prisma.empty}
    ORDER BY COALESCE(agg.value, -1) DESC, sp."profileId" ASC
    LIMIT ${SELLER_PAGE_SIZE + 1}
  `
  return rows.map(r => ({ profileId: r.profile_id, value: r.value ?? -1 }))
}

function grossSalesCte(range: DateRange): Prisma.Sql {
  return Prisma.sql`
    SELECT sub."profileId" AS profile_id, SUM(oi.price)::float8 AS value
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    JOIN "ItemInstance" i ON i.id = oi."itemId"
    JOIN "SellerAgreement" sa ON sa.id = i."sellerAgreementId"
    JOIN "SellerSubmission" sub ON sub.id = sa."submissionId"
    WHERE o.status = 'complete' ${rangeSql('o."completedAt"', range)}
    GROUP BY sub."profileId"
  `
}

function unitsSoldCte(): Prisma.Sql {
  return Prisma.sql`
    SELECT sub."profileId" AS profile_id, COUNT(*)::float8 AS value
    FROM "ItemInstance" i
    JOIN "SellerAgreement" sa ON sa.id = i."sellerAgreementId"
    JOIN "SellerSubmission" sub ON sub.id = sa."submissionId"
    WHERE i.status = 'sold'
    GROUP BY sub."profileId"
  `
}

function sellThroughCte(): Prisma.Sql {
  return Prisma.sql`
    SELECT sub."profileId" AS profile_id,
      CASE WHEN COUNT(*) > 0 THEN (COUNT(*) FILTER (WHERE i.status = 'sold'))::float8 / COUNT(*)::float8 * 100 ELSE NULL END AS value
    FROM "ItemInstance" i
    JOIN "SellerAgreement" sa ON sa.id = i."sellerAgreementId"
    JOIN "SellerSubmission" sub ON sub.id = sa."submissionId"
    GROUP BY sub."profileId"
  `
}

function payoutOutstandingCte(): Prisma.Sql {
  return Prisma.sql`
    SELECT spl."customerProfileId" AS profile_id, SUM(spl."netAmount")::float8 AS value
    FROM "SellerPayoutLine" spl
    LEFT JOIN "SellerPayout" p ON p.id = spl."payoutId"
    WHERE spl.status IN ('eligible', 'held') AND (spl."payoutId" IS NULL OR p.status IN ('draft', 'approved'))
    GROUP BY spl."customerProfileId"
  `
}

// Listing-to-sale median, in days — Postgres computes the per-seller percentile
// directly (PERCENTILE_CONT), so no per-seller row materialization is needed even for
// this otherwise-hard-to-paginate statistic. Negative durations (data error) excluded.
function medianDaysToSellCte(): Prisma.Sql {
  return Prisma.sql`
    SELECT sub."profileId" AS profile_id,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."completedAt" - lst."createdAt")) / 86400.0) AS value
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    JOIN "Listing" lst ON lst.id = oi."listingId"
    JOIN "ItemInstance" i ON i.id = oi."itemId"
    JOIN "SellerAgreement" sa ON sa.id = i."sellerAgreementId"
    JOIN "SellerSubmission" sub ON sub.id = sa."submissionId"
    WHERE o.status = 'complete' AND o."completedAt" IS NOT NULL AND o."completedAt" >= lst."createdAt"
    GROUP BY sub."profileId"
  `
}

async function fetchSellerPage(range: DateRange, sort: SellerSortKey, cursor: SellerPointer | null): Promise<SellerPointer[]> {
  switch (sort) {
    case 'grossSales': return fetchSellerSortPage(grossSalesCte(range), cursor)
    case 'unitsSold': return fetchSellerSortPage(unitsSoldCte(), cursor)
    case 'sellThrough': return fetchSellerSortPage(sellThroughCte(), cursor)
    case 'payoutOutstanding': return fetchSellerSortPage(payoutOutstandingCte(), cursor)
    case 'medianDaysToSell': return fetchSellerSortPage(medianDaysToSellCte(), cursor)
  }
}

// Hydrates display-only columns for exactly the page's profileIds (<=50) — every query
// below is scoped with `{ in: pageProfileIds }`, never the full seller population.
async function hydrateSellerPage(range: DateRange, pageProfileIds: string[]): Promise<Map<string, SellerRow>> {
  const out = new Map<string, SellerRow>()
  if (pageProfileIds.length === 0) return out

  const [
    submissionGroups, rejectedGroups, proceedsGroups, paidGroups, outstandingGroups,
    agreements, communityProfiles,
  ] = await Promise.all([
    prisma.sellerSubmission.groupBy({ by: ['profileId'], where: { profileId: { in: pageProfileIds } }, _count: { id: true } }),
    prisma.sellerSubmission.groupBy({ by: ['profileId'], where: { profileId: { in: pageProfileIds }, status: { in: ['declined', 'withdrawn'] } }, _count: { id: true } }),
    prisma.sellerPayoutLine.groupBy({ by: ['customerProfileId'], where: { customerProfileId: { in: pageProfileIds }, status: { not: 'voided' }, ...rangeWhere('eligibleAt', range) }, _sum: { netAmount: true } }),
    prisma.sellerPayoutLine.groupBy({ by: ['customerProfileId'], where: { customerProfileId: { in: pageProfileIds }, payout: { status: 'paid' } }, _sum: { netAmount: true } }),
    prisma.sellerPayoutLine.groupBy({ by: ['customerProfileId'], where: { customerProfileId: { in: pageProfileIds }, status: { in: ['eligible', 'held'] }, OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }] }, _sum: { netAmount: true } }),
    prisma.sellerAgreement.findMany({ where: { submission: { profileId: { in: pageProfileIds } } }, select: { id: true, submissionId: true, submission: { select: { profileId: true } } } }),
    // Non-PII identity only: a handle the seller explicitly made public. Never
    // SellerProfile.displayName (admin free-text — may contain a real name) and never
    // CustomerProfile.name.
    prisma.customerCommunityProfile.findMany({ where: { profileId: { in: pageProfileIds }, isPublic: true }, select: { profileId: true, handle: true } }),
  ])

  const agreementIds = agreements.map(a => a.id)
  const [itemGroups, soldGroups, listedGroups] = await Promise.all([
    prisma.itemInstance.groupBy({ by: ['sellerAgreementId'], where: { sellerAgreementId: { in: agreementIds } }, _count: { id: true } }),
    prisma.itemInstance.groupBy({ by: ['sellerAgreementId'], where: { sellerAgreementId: { in: agreementIds }, status: 'sold' }, _count: { id: true } }),
    prisma.itemInstance.groupBy({ by: ['sellerAgreementId'], where: { sellerAgreementId: { in: agreementIds }, listing: { isNot: null } }, _count: { id: true } }),
  ])
  const profileByAgreement = new Map(agreements.map(a => [a.id, a.submission.profileId]))

  function foldByAgreement(groups: Array<{ sellerAgreementId: string | null; _count: { id: number } }>): Map<string, number> {
    const acc = new Map<string, number>()
    for (const g of groups) {
      const pid = g.sellerAgreementId ? profileByAgreement.get(g.sellerAgreementId) : null
      if (!pid) continue
      acc.set(pid, (acc.get(pid) ?? 0) + g._count.id)
    }
    return acc
  }
  const unitsReceivedByProfile = foldByAgreement(itemGroups)
  const unitsSoldByProfile = foldByAgreement(soldGroups)
  const unitsListedByProfile = foldByAgreement(listedGroups)

  // Grouped by seller: bounded to the same page's agreements, via a raw scoped groupBy.
  const grossSalesRows = agreementIds.length > 0
    ? await prisma.orderItem.findMany({
        where: { order: { status: 'complete', ...rangeWhere('completedAt', range) }, item: { sellerAgreementId: { in: agreementIds } } },
        select: { price: true, item: { select: { sellerAgreementId: true } } },
      })
    : []
  const grossSalesByProfile = new Map<string, Prisma.Decimal>()
  for (const row of grossSalesRows) {
    const pid = row.item.sellerAgreementId ? profileByAgreement.get(row.item.sellerAgreementId) : null
    if (!pid) continue
    grossSalesByProfile.set(pid, (grossSalesByProfile.get(pid) ?? DECIMAL_ZERO).plus(decimalFromFloatDollars(row.price)))
  }

  // Median intake-to-listing / listing-to-sale — bounded to this page's agreements only.
  const [listedItems, soldItems] = agreementIds.length > 0
    ? await Promise.all([
        prisma.itemInstance.findMany({ where: { sellerAgreementId: { in: agreementIds }, listing: { isNot: null } }, select: { createdAt: true, sellerAgreementId: true, listing: { select: { createdAt: true } } } }),
        prisma.orderItem.findMany({ where: { order: { status: 'complete' }, item: { sellerAgreementId: { in: agreementIds } } }, select: { item: { select: { sellerAgreementId: true } }, order: { select: { completedAt: true } }, listing: { select: { createdAt: true } } } }),
      ])
    : [[], []]
  const intakeToListingByProfile = new Map<string, number[]>()
  for (const item of listedItems) {
    const pid = item.sellerAgreementId ? profileByAgreement.get(item.sellerAgreementId) : null
    if (!pid || !item.listing) continue
    const d = daysBetween(item.createdAt, item.listing.createdAt)
    if (d < 0) continue
    if (!intakeToListingByProfile.has(pid)) intakeToListingByProfile.set(pid, [])
    intakeToListingByProfile.get(pid)!.push(d)
  }
  const listingToSaleByProfile = new Map<string, number[]>()
  for (const row of soldItems) {
    const pid = row.item.sellerAgreementId ? profileByAgreement.get(row.item.sellerAgreementId) : null
    if (!pid || !row.order.completedAt) continue
    const d = daysBetween(row.listing.createdAt, row.order.completedAt)
    if (d < 0) continue
    if (!listingToSaleByProfile.has(pid)) listingToSaleByProfile.set(pid, [])
    listingToSaleByProfile.get(pid)!.push(d)
  }
  function median(days: number[] | undefined): number | null {
    if (!days || days.length === 0) return null
    const sorted = [...days].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) / 2)]
  }

  const submissionsByProfile = new Map(submissionGroups.map(g => [g.profileId, g._count.id]))
  const rejectedByProfile = new Map(rejectedGroups.map(g => [g.profileId, g._count.id]))
  const proceedsByProfile = new Map(proceedsGroups.map(g => [g.customerProfileId, g._sum.netAmount ?? DECIMAL_ZERO]))
  const paidByProfile = new Map(paidGroups.map(g => [g.customerProfileId, g._sum.netAmount ?? DECIMAL_ZERO]))
  const outstandingByProfile = new Map(outstandingGroups.map(g => [g.customerProfileId, g._sum.netAmount ?? DECIMAL_ZERO]))
  const handleByProfile = new Map(communityProfiles.map(c => [c.profileId, c.handle]))

  for (const pid of pageProfileIds) {
    const received = unitsReceivedByProfile.get(pid) ?? 0
    const sold = unitsSoldByProfile.get(pid) ?? 0
    const submissions = submissionsByProfile.get(pid) ?? 0
    const rejected = rejectedByProfile.get(pid) ?? 0
    out.set(pid, {
      profileId: pid,
      displayName: handleByProfile.get(pid) ?? `Seller ${pid.slice(0, 8)}`,
      submissions,
      unitsReceived: received,
      unitsListed: unitsListedByProfile.get(pid) ?? 0,
      unitsSold: sold,
      sellThrough: received > 0 ? (sold / received) * 100 : null,
      grossSales: grossSalesByProfile.get(pid) ?? DECIMAL_ZERO,
      sellerProceeds: proceedsByProfile.get(pid) ?? DECIMAL_ZERO,
      payoutPaid: paidByProfile.get(pid) ?? DECIMAL_ZERO,
      payoutOutstanding: outstandingByProfile.get(pid) ?? DECIMAL_ZERO,
      medianIntakeToListingDays: median(intakeToListingByProfile.get(pid)),
      medianListingToSaleDays: median(listingToSaleByProfile.get(pid)),
      rejectionRate: submissions > 0 ? (rejected / submissions) * 100 : null,
    })
  }
  return out
}

export async function getSellerPerformancePage(
  range: DateRange,
  sort: SellerSortKey,
  cursor: SellerPointer | null,
): Promise<{ items: SellerRow[]; nextCursor: SellerPointer | null }> {
  const pointers = await fetchSellerPage(range, sort, cursor)
  if (pointers.length === 0) return { items: [], nextCursor: null }

  const hasMore = pointers.length > SELLER_PAGE_SIZE
  const pagePointers = hasMore ? pointers.slice(0, SELLER_PAGE_SIZE) : pointers
  const hydrated = await hydrateSellerPage(range, pagePointers.map(p => p.profileId))

  const items = pagePointers.map(p => hydrated.get(p.profileId)).filter((r): r is SellerRow => r !== undefined)
  const last = pagePointers[pagePointers.length - 1]
  return { items, nextCursor: hasMore ? { value: last.value, profileId: last.profileId } : null }
}

async function getSellersWithCompletedSalesCount(range: DateRange): Promise<number> {
  const rows = await prisma.orderItem.findMany({
    where: { order: { status: 'complete', ...rangeWhere('completedAt', range) }, item: { sellerAgreementId: { not: null } } },
    select: { item: { select: { sellerAgreementId: true } } },
  })
  const agreementIds = [...new Set(rows.map(r => r.item.sellerAgreementId).filter((x): x is string => x !== null))]
  if (agreementIds.length === 0) return 0
  const agreements = await prisma.sellerAgreement.findMany({ where: { id: { in: agreementIds } }, select: { submission: { select: { profileId: true } } } })
  return new Set(agreements.map(a => a.submission.profileId)).size
}

// ── Time series ──────────────────────────────────────────────────────────────────
//
// Deterministic UTC buckets (day/week/month per chooseBucketGranularity). Money is
// aggregated as Prisma.Decimal per bucket, never JS Number. No historical
// payout-liability series — SellerPayoutLine/SellerPayout have no snapshot history,
// only current state, so only a "payouts paid" FLOW series (by paidAt) is offered.
// Gross spread (consignment) and gross margin (buyout/company-owned) are kept as
// SEPARATE series — never summed into one unlabeled "margin" number — for the same
// reason as OverviewMetrics above: they are different economics over disjoint items.

export type TimeSeriesBucket = {
  bucketStart: Date
  completedOrders: number
  unitsSold: number
  gmv: Prisma.Decimal
  consignmentGrossSpread: Prisma.Decimal
  buyoutGrossMargin: Prisma.Decimal
  inventoryIntake: number
  inventorySold: number
  payoutsPaid: Prisma.Decimal
}

function bucketKey(d: Date): string {
  return d.toISOString()
}

// Generous enough for legitimate all-time history (2000 monthly buckets = 166+
// years), but still a hard bound — catches a malformed/implausible timestamp (e.g. a
// bad epoch-zero date from a data bug) rather than iterating unboundedly.
const MAX_BUCKETS = 2000

// Builds the full list of zero-filled bucket boundaries from `from` (inclusive) to
// `to` (exclusive), so a bucket with no events still appears with zero values rather
// than being silently absent from the series. Assumes `from` has already been passed
// through clampSeriesStart, so this loop is never expected to hit MAX_BUCKETS in
// practice — the cap here is a pure backstop, not the primary safety mechanism.
function bucketBoundaries(from: Date, to: Date, granularity: BucketGranularity): Date[] {
  const out: Date[] = []
  let cur = bucketStart(from, granularity)
  for (let i = 0; i < MAX_BUCKETS && cur.getTime() < to.getTime(); i++) {
    out.push(new Date(cur))
    cur = advanceBucket(cur, granularity)
  }
  return out
}

// Must UNDER-estimate the true bucket duration (day/week are exact; month uses the
// shortest possible month, 28 days) — clampSeriesStart divides the safety budget by
// this value, so an underestimate keeps the clamped span conservatively SHORT,
// guaranteeing bucketBoundaries' real calendar-month advancement always finishes
// within MAX_BUCKETS. An overestimate would do the opposite: push the clamped start
// too far back for the real (shorter) calendar months to cover before hitting the
// MAX_BUCKETS guard, silently truncating the series before it reaches `to` again.
function approxBucketMs(granularity: BucketGranularity): number {
  if (granularity === 'day') return 86_400_000
  if (granularity === 'week') return 7 * 86_400_000
  return 28 * 86_400_000 // month
}

// If [from, to) would need more buckets than MAX_BUCKETS at this granularity — only
// realistically reachable via a malformed/implausible historical timestamp, since
// legitimate ranges are already granularity-matched by chooseBucketGranularity — clip
// the START forward so the series still reaches all the way to `to`. This only ever
// discards the OLDEST (excess/garbage) portion of the range; the current/recent data
// the caller actually asked for is never silently dropped. Increasing granularity
// further isn't available here (month is already the coarsest bucket), so clamping
// the start is the mechanism, per the "increase granularity, don't drop data" rule —
// the effect is equivalent (fewer, wider-spanning buckets that still reach `to`).
function clampSeriesStart(from: Date, to: Date, granularity: BucketGranularity): Date {
  const maxSpanMs = MAX_BUCKETS * approxBucketMs(granularity)
  const clamped = new Date(to.getTime() - maxSpanMs)
  return clamped.getTime() > from.getTime() ? clamped : from
}

// Earliest relevant timestamp across the three source tables, via DB-side MIN
// aggregation only — never by loading full row sets into application memory just to
// find the smallest value. Only run for 'all time' (range.start === null); a bounded
// range already has an explicit start and needs no lookup.
async function getEarliestBusinessTimestamp(): Promise<Date | null> {
  const [orderMin, intakeMin, payoutMin] = await Promise.all([
    prisma.order.aggregate({ where: { status: 'complete' }, _min: { completedAt: true } }),
    prisma.itemInstance.aggregate({ _min: { createdAt: true } }),
    prisma.sellerPayout.aggregate({ where: { status: 'paid' }, _min: { paidAt: true } }),
  ])
  const candidates = [orderMin._min.completedAt, intakeMin._min.createdAt, payoutMin._min.paidAt].filter((d): d is Date => d !== null)
  return candidates.length > 0 ? new Date(Math.min(...candidates.map(d => d.getTime()))) : null
}

export async function getTimeSeries(range: DateRange): Promise<TimeSeriesBucket[]> {
  const granularity = chooseBucketGranularity(range)

  // Effective series start: the filter's own start, or (for 'all time') the earliest
  // timestamp actually observed in the database — via MIN aggregation, never a
  // fabricated epoch and never a full-table scan into memory. Then clamped against a
  // malformed/implausible timestamp (clampSeriesStart), and used to bound the event
  // queries below — so an extreme historical outlier can't force those queries to
  // pull a similarly extreme, unbounded row set either.
  const rawEffectiveStart = range.start ?? (await getEarliestBusinessTimestamp()) ?? range.end
  const effectiveStart = clampSeriesStart(rawEffectiveStart, range.end, granularity)
  const eventWindow = { gte: effectiveStart, lt: range.end }

  const [completedOrderRows, orderItemRows, intakeRows, paidLineRows] = await Promise.all([
    prisma.order.findMany({ where: { status: 'complete', completedAt: eventWindow }, select: { completedAt: true } }),
    prisma.orderItem.findMany({
      where: { order: { status: 'complete', completedAt: eventWindow } },
      select: { price: true, order: { select: { completedAt: true } }, item: { select: { sourceType: true, purchasePrice: true } }, id: true },
    }),
    prisma.itemInstance.findMany({ where: { createdAt: eventWindow }, select: { createdAt: true } }),
    prisma.sellerPayoutLine.findMany({ where: { payout: { status: 'paid', paidAt: eventWindow } }, select: { netAmount: true, payout: { select: { paidAt: true } } } }),
  ])

  // Consignment items' spread needs their linked payout line — bounded to this range's items.
  const consignmentOrderItemIds = orderItemRows.filter(r => isConsignmentSourceType(r.item.sourceType)).map(r => r.id)
  const payoutLines = consignmentOrderItemIds.length > 0
    ? await prisma.sellerPayoutLine.findMany({ where: { lineType: 'consignment', orderItemId: { in: consignmentOrderItemIds } }, select: { orderItemId: true, grossSalePrice: true, netAmount: true } })
    : []
  const lineByOrderItem = new Map(payoutLines.map(l => [l.orderItemId as string, l]))

  const boundaries = bucketBoundaries(effectiveStart, range.end, granularity)
  const buckets = new Map<string, TimeSeriesBucket>()
  for (const b of boundaries) {
    buckets.set(bucketKey(b), {
      bucketStart: b, completedOrders: 0, unitsSold: 0, gmv: DECIMAL_ZERO,
      consignmentGrossSpread: DECIMAL_ZERO, buyoutGrossMargin: DECIMAL_ZERO,
      inventoryIntake: 0, inventorySold: 0, payoutsPaid: DECIMAL_ZERO,
    })
  }

  function bucketFor(d: Date): TimeSeriesBucket | undefined {
    return buckets.get(bucketKey(bucketStart(d, granularity)))
  }

  for (const row of completedOrderRows) {
    if (!row.completedAt) continue
    const b = bucketFor(row.completedAt)
    if (b) b.completedOrders++
  }

  for (const row of orderItemRows) {
    if (!row.order.completedAt) continue
    const b = bucketFor(row.order.completedAt)
    if (!b) continue
    b.unitsSold++
    b.inventorySold++
    b.gmv = b.gmv.plus(decimalFromFloatDollars(row.price))

    if (isConsignmentSourceType(row.item.sourceType)) {
      const line = lineByOrderItem.get(row.id)
      if (line) b.consignmentGrossSpread = b.consignmentGrossSpread.plus(subtractDecimal(line.grossSalePrice ?? decimalFromFloatDollars(row.price), line.netAmount))
    } else if (isOwnedSourceType(row.item.sourceType) && row.item.purchasePrice !== null) {
      b.buyoutGrossMargin = b.buyoutGrossMargin.plus(subtractDecimal(decimalFromFloatDollars(row.price), decimalFromFloatDollars(row.item.purchasePrice)))
    }
  }

  for (const row of intakeRows) {
    const b = bucketFor(row.createdAt)
    if (b) b.inventoryIntake++
  }

  for (const row of paidLineRows) {
    if (!row.payout?.paidAt) continue
    const b = bucketFor(row.payout.paidAt)
    if (b) b.payoutsPaid = b.payoutsPaid.plus(row.netAmount)
  }

  return boundaries.map(b => buckets.get(bucketKey(b))!)
}
