// 16B: DB boundary for the /account overview. Read-only — no .create/.update/
// .delete/.upsert anywhere in this file (see accountOverviewSafety tests). One
// function, `getAccountOverview(profileId)`, returning ONLY cheap/exact summary
// data — reuses existing domain logic/predicates rather than redefining order/
// collection/wanted/portfolio semantics (Part Q). profileId must always come from
// the caller's own server-verified session (Part N) — this file never reads it from
// request input.
import { prisma } from '@/lib/prisma'
import { getUnreadAlertCount } from '@/lib/buyerAlertsQuery'
import { outstandingPayoutLineWhere } from '@/lib/businessAnalyticsQuery'
import { DECIMAL_ZERO } from '@/lib/businessAnalyticsMath'

// Same statuses businessAnalyticsQuery.ts/account/orders/page.tsx already treat as
// terminal — an order is "active" while it has not yet reached one of these.
const TERMINAL_ORDER_STATUSES = ['complete', 'cancelled'] as const

export type RecentOrderRow = { id: string; createdAt: Date; status: string; totalCents: number | null }

export type OrdersSummary = {
  activeCount: number
  recent: RecentOrderRow[]
}

async function getOrdersSummary(profileId: string): Promise<OrdersSummary> {
  const [activeCount, recentOrders] = await Promise.all([
    prisma.order.count({ where: { customerProfileId: profileId, status: { notIn: [...TERMINAL_ORDER_STATUSES] } } }),
    prisma.order.findMany({
      where: { customerProfileId: profileId },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, createdAt: true, status: true, orderItems: { select: { price: true } } },
    }),
  ])
  return {
    activeCount,
    recent: recentOrders.map((o) => ({
      id: o.id,
      createdAt: o.createdAt,
      status: o.status,
      // Sum of a bounded (<=3 orders, each a handful of items) already-fetched set —
      // not an authoritative financial total, display-only, single Number() sum is
      // fine at this scale (no Decimal/Prisma money convention elsewhere in this
      // customer-facing order total either — see account/orders/page.tsx).
      totalCents: o.orderItems.length > 0 ? Math.round(o.orderItems.reduce((s, oi) => s + oi.price, 0) * 100) : null,
    })),
  }
}

export type CollectionSummary = { itemCount: number; uniqueModelCount: number }

async function getCollectionSummary(profileId: string): Promise<CollectionSummary> {
  const [itemCount, distinctModels] = await Promise.all([
    prisma.collectionItem.count({ where: { profileId } }),
    prisma.collectionItem.groupBy({ by: ['catalogId'], where: { profileId, catalogId: { not: null } } }),
  ])
  return { itemCount, uniqueModelCount: distinctModels.length }
}

export type WantedSummary = { wantedCount: number; unreadAlertCount: number }

// 16B Final Lightweight-Overview Pass: `availableMatchCount` was removed. Computing
// it exactly requires matchWantedList's uncapped candidate findMany over this
// customer's full wanted list — a genuine matching-engine scan, not a cheap DB
// count, and 16B explicitly forbids running that scan just to populate a dashboard
// number. The Wanted page itself still runs the full scan (wantedListMatching.ts is
// unchanged); /account only shows the exact, cheap wantedCount/unreadAlertCount and
// links out to "Check Matches" instead.
async function getWantedSummary(profileId: string): Promise<WantedSummary> {
  const [wantedCount, unreadAlertCount] = await Promise.all([
    prisma.wantedCatalogModel.count({ where: { customerProfileId: profileId } }),
    getUnreadAlertCount(profileId),
  ])
  return { wantedCount, unreadAlertCount }
}

export type SellingSummary = { outstandingPayoutCents: number }

// 16B Final Lightweight-Overview Pass: `activePortfolioCount` was removed.
// Non-terminal "stage" is derived (derivePortfolioStage), not a stored column, so an
// exact count requires hydrating every portfolio's submissions/agreements/shipments/
// items — the same uncapped domain-list load 16B forbids behind a dashboard number.
// No cheap DB-side predicate expresses "stage" without that hydration, and this file
// must not fork a second/approximate stage engine to fake one. The Selling card
// below only shows the exact, cheap outstanding-payout aggregate and links out to
// the real portfolio list instead of a count.
async function getSellingSummary(profileId: string): Promise<SellingSummary> {
  // outstandingPayoutLineWhere is the ONE authoritative outstanding-liability
  // predicate, shared verbatim with businessAnalyticsQuery.ts's admin-facing
  // getOutstandingLiability — never a hand-copied equivalent shape. customerProfileId
  // narrows it to this one customer; it is never omitted (Part 5 — never the
  // global/admin figure).
  const payoutAgg = await prisma.sellerPayoutLine.aggregate({
    where: outstandingPayoutLineWhere(profileId),
    _sum: { netAmount: true },
  })
  const outstanding = payoutAgg._sum.netAmount ?? DECIMAL_ZERO
  return { outstandingPayoutCents: Math.round(outstanding.toNumber() * 100) }
}

export type AccountOverview = {
  orders: OrdersSummary
  collection: CollectionSummary
  wanted: WantedSummary
  selling: SellingSummary
}

// Parallel, independent, bounded reads — no N+1, no full-table loads, no per-item
// 14C (Part 26/45). Each summary function above is itself already a fixed, small
// number of queries regardless of how much history the customer has.
export async function getAccountOverview(profileId: string): Promise<AccountOverview> {
  const [orders, collection, wanted, selling] = await Promise.all([
    getOrdersSummary(profileId),
    getCollectionSummary(profileId),
    getWantedSummary(profileId),
    getSellingSummary(profileId),
  ])
  return { orders, collection, wanted, selling }
}
