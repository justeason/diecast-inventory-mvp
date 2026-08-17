// 15N: DB boundary for financial position & liquidity. Read-only — no
// .create/.update/.delete/.upsert anywhere in this file (see financePositionSafety
// tests). Bounded aggregate queries only; no full ItemInstance/OrderItem/
// SellerPayoutLine table loads, no per-item 14C, no arbitrary row cap behind an
// authoritative total (Part T/U).
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { DateRange } from '@/lib/businessAnalyticsDates'
import { DECIMAL_ZERO } from '@/lib/businessAnalyticsMath'
import {
  OWNED_SOURCE_TYPES, unitCoverageMetric, decimalFromAggregateSum,
  OWNED_INVENTORY_AGING_BUCKETS, type FinancialMetric,
} from '@/lib/financialPosition'

function rangeWhere(field: string, range: DateRange) {
  return range.start ? { [field]: { gte: range.start, lt: range.end } } : { [field]: { lt: range.end } }
}

// Currently-owned physical inventory (Part C/5): sourceType is buyout/company_owned
// AND no stronger sale evidence exists than the convenient status field — mirrors
// 15C/15J's own "completed sale" check (a completed OrderItem always outranks a
// stale 'available' status) rather than duplicating that logic by hand.
const OWNED_CANDIDATE_WHERE: Prisma.ItemInstanceWhereInput = {
  sourceType: { in: [...OWNED_SOURCE_TYPES] },
  status: { not: 'sold' },
  orderItems: { none: { order: { status: 'complete' } } },
}

// ── Owned inventory + cost (Part C) ───────────────────────────────────────────────
export type OwnedInventoryPosition = {
  ownedUnits: number
  unitsWithCost: number
  unitsWithoutCost: number
  allocatedCost: Prisma.Decimal
  costCoverage: FinancialMetric<Prisma.Decimal>
}

export async function getOwnedInventoryPosition(): Promise<OwnedInventoryPosition> {
  const [total, withCostAgg] = await Promise.all([
    prisma.itemInstance.count({ where: OWNED_CANDIDATE_WHERE }),
    prisma.itemInstance.aggregate({
      where: { ...OWNED_CANDIDATE_WHERE, purchasePrice: { not: null } },
      _count: { _all: true },
      _sum: { purchasePrice: true },
    }),
  ])
  const unitsWithCost = withCostAgg._count._all
  const allocatedCost = decimalFromAggregateSum(withCostAgg._sum.purchasePrice)
  return {
    ownedUnits: total,
    unitsWithCost,
    unitsWithoutCost: total - unitsWithCost,
    allocatedCost,
    costCoverage: unitCoverageMetric(allocatedCost, unitsWithCost, total, 'No currently-owned inventory units.'),
  }
}

// 15N focused-review (buyout-cost-semantics pass): a prior version of this file
// summed SellerAgreement.agreedBuyoutAmount across multi-item accepted buyout
// agreements with an outstanding owned unit and presented it as "Unallocated batch
// acquisition cost." That number is invalid: once even one unit from a batch has
// sold, most of the agreement total economically belongs to units that are no
// longer current inventory (see the milestone's worked example — 10 items for
// $100, 9 sold, 1 held — the held unit's exact cost is NOT $100, and dividing to
// get $10 is exactly the equal-allocation this data model prohibits). There is no
// valid way to attribute any portion of a multi-item agreement total to specific
// remaining units, so this metric — and the SellerAgreement query that existed
// solely to compute it — has been removed rather than reworked. Current owned-
// inventory cost is ONLY ever exact item-level ItemInstance.purchasePrice; the gap
// is disclosed entirely through unit-based cost coverage below, never a dollar
// figure derived from agreement totals.

// Owned-inventory aging (Part M/36) — ItemInstance.createdAt is used as the
// acquisition-date proxy ONLY here, for buyout/company_owned items specifically:
// for those two source types, ItemInstance creation IS the intake-conversion moment
// capital became tied up (unlike consignment, where creation never represents an
// acquisition — ownership never transfers). Cost per bucket is coverage-aware, never
// a fabricated $0 for units with no recorded purchasePrice.
export type OwnedInventoryAgingBucket = { key: string; units: number; unitsWithCost: number; knownCost: Prisma.Decimal }

export async function getOwnedInventoryAging(asOf: Date = new Date()): Promise<OwnedInventoryAgingBucket[]> {
  const rows = await Promise.all(
    OWNED_INVENTORY_AGING_BUCKETS.map(async (b) => {
      const upper = new Date(asOf.getTime() - b.minDays * 86_400_000)
      const lower = b.maxDays !== null ? new Date(asOf.getTime() - (b.maxDays + 1) * 86_400_000) : null
      const where: Prisma.ItemInstanceWhereInput = {
        ...OWNED_CANDIDATE_WHERE,
        createdAt: lower ? { gt: lower, lte: upper } : { lte: upper },
      }
      const [units, costAgg] = await Promise.all([
        prisma.itemInstance.count({ where }),
        prisma.itemInstance.aggregate({ where: { ...where, purchasePrice: { not: null } }, _count: { _all: true }, _sum: { purchasePrice: true } }),
      ])
      return { key: b.key, units, unitsWithCost: costAgg._count._all, knownCost: decimalFromAggregateSum(costAgg._sum.purchasePrice) }
    }),
  )
  return rows
}

// ── Consigned inventory held (Part E) — never company-owned/asset ────────────────
export type ConsignedInventoryHeld = {
  unitsHeld: number
  listedUnits: number
  reservedUnits: number
  soldAwaitingPayout: number
}

export async function getConsignedInventoryHeld(): Promise<ConsignedInventoryHeld> {
  const [unitsHeld, listedUnits, reservedUnits, soldAwaitingPayout] = await Promise.all([
    prisma.itemInstance.count({ where: { sourceType: 'consignment', status: { in: ['available', 'reserved'] } } }),
    prisma.itemInstance.count({ where: { sourceType: 'consignment', status: { in: ['available', 'reserved'] }, listing: { status: 'active' } } }),
    prisma.itemInstance.count({ where: { sourceType: 'consignment', status: 'reserved' } }),
    // Same outstanding-liability predicate as businessAnalyticsQuery.ts's
    // getOutstandingLiability, scoped to consignment lines only — a unit COUNT of
    // that exact liability population, not a re-derived definition.
    prisma.sellerPayoutLine.count({
      where: { lineType: 'consignment', status: { in: ['eligible', 'held'] }, OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }] },
    }),
  ])
  return { unitsHeld, listedUnits, reservedUnits, soldAwaitingPayout }
}

// ── Payout-approval attention (Part P/41, Part F/17) — persisted state only, no
// re-evaluation of risk on dashboard load. ────────────────────────────────────────
export type PayoutApprovalAttention = { readyToPay: Prisma.Decimal; readyToPayCount: number; pendingApproval: Prisma.Decimal; pendingApprovalCount: number }

export async function getPayoutApprovalAttention(): Promise<PayoutApprovalAttention> {
  const pendingApprovals = await prisma.riskApprovalRequest.findMany({
    where: { action: 'seller_payout_mark_paid', status: 'pending' },
    select: { targetId: true },
  })
  const pendingIds = pendingApprovals.map((a) => a.targetId)

  const [approvedTotal, pendingTotal] = await Promise.all([
    prisma.sellerPayout.aggregate({ where: { status: 'approved' }, _sum: { totalAmount: true }, _count: { _all: true } }),
    pendingIds.length > 0
      ? prisma.sellerPayout.aggregate({ where: { status: 'approved', id: { in: pendingIds } }, _sum: { totalAmount: true }, _count: { _all: true } })
      : Promise.resolve({ _sum: { totalAmount: null }, _count: { _all: 0 } }),
  ])

  const approvedAmount = approvedTotal._sum.totalAmount ?? DECIMAL_ZERO
  const pendingAmount = pendingTotal._sum.totalAmount ?? DECIMAL_ZERO
  return {
    readyToPay: approvedAmount.minus(pendingAmount),
    readyToPayCount: approvedTotal._count._all - pendingTotal._count._all,
    pendingApproval: pendingAmount,
    pendingApprovalCount: pendingTotal._count._all,
  }
}

// ── Buyer payments captured (Part I/24) — distinct from GMV: proof funds were
// actually collected (paymentStatus='paid'), not merely that an order completed. ──
export type BuyerPaymentsCaptured = { count: number; amount: Prisma.Decimal }

export async function getBuyerPaymentsCaptured(range: DateRange): Promise<BuyerPaymentsCaptured> {
  const [count, agg] = await Promise.all([
    prisma.order.count({ where: { paymentStatus: 'paid', ...rangeWhere('paidAt', range) } }),
    prisma.orderItem.aggregate({ where: { order: { paymentStatus: 'paid', ...rangeWhere('paidAt', range) } }, _sum: { price: true } }),
  ])
  return { count, amount: decimalFromAggregateSum(agg._sum.price) }
}

// Re-exported so callers only need one import surface for the position page — the
// values themselves are still 14B's own exact, already-tested definitions, never
// redefined here (Part F/15, Part K/30-32).
export { getOutstandingLiability, getPayoutLiabilitySnapshot, getLiabilityAging, getOverviewMetrics, getPayoutFlow } from '@/lib/businessAnalyticsQuery'
export type { PayoutLiabilitySnapshot, LiabilityAgingBucket, OverviewMetrics, PayoutFlow } from '@/lib/businessAnalyticsQuery'
