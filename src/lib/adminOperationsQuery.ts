// 15H: DB boundary for the admin command center. Read-only (Part J section 34 —
// never mutates ItemInstance/Listing/Order/SellerAgreement/SellerPortfolio/
// SellerPayout/RiskApprovalRequest/IntakeDraft). Reuses the authoritative bounded
// queries from 14B/15E/15F directly rather than re-deriving their logic (Part J
// section 33) — this file only adds the small number of additional bounded counts
// those modules don't already expose, plus the parallel composition/formatting for
// the homepage payload.
//
// Query budget (Part N section 41): every count/sum below is a single DB-side
// COUNT/aggregate/groupBy, or (RiskApprovalRequest has no Prisma relation to
// SellerPayout — targetId is a polymorphic string, not an FK) one raw NOT EXISTS
// COUNT. None of these row-cap: an authoritative number must stay exact no matter
// how many qualifying rows exist (15H focused-review section 1) — only genuinely
// presentational reads (global search, recent-activity previews) are allowed to be
// `take`-bounded, and this file has none of those.

import { prisma } from '@/lib/prisma'
import { getExceptionQueueSummary } from '@/lib/intakeExceptionQueueQuery'
import { getApprovalQueueSummary } from '@/lib/riskPolicyQuery'
import { getOverviewMetrics } from '@/lib/businessAnalyticsQuery'
import { todayRange } from '@/lib/businessAnalyticsDates'
import { fmtUsdDecimal } from '@/lib/businessAnalyticsFormat'
import { type AttentionItem, sortByAttentionBand } from '@/lib/adminOperations'

// ── Nav badges — cheap enough to run on every admin page load ──────────────────────

export type AdminAttentionBadges = {
  intakeExceptions: number
  pendingApprovals: number
  shipmentDiscrepancies: number
}

export async function getAdminAttentionBadges(): Promise<AdminAttentionBadges> {
  const [exceptions, approvals, shipmentDiscrepancies] = await Promise.all([
    getExceptionQueueSummary({}),
    getApprovalQueueSummary(),
    prisma.sellerInboundShipment.count({ where: { status: 'issue' } }),
  ])
  return {
    intakeExceptions: exceptions.open,
    pendingApprovals: approvals.pending,
    shipmentDiscrepancies,
  }
}

// ── Command center payload — /admin only ────────────────────────────────────────

export type CommandCenterData = {
  needsAttention: AttentionItem[]
  workQueues: {
    readyForIntake: { shipments: number; units: number; href: string }
    intakeInProgress: { shipments: number; href: string }
    availableNotListed: { count: number; href: string }
    openOrders: { count: number; href: string }
    payoutReady: { count: number; href: string }
  }
  businessPulse: {
    itemsProcessedToday: number
    itemsListedToday: number
    unitsSoldToday: number
    completedOrdersToday: number
    gmvToday: string
  }
}

export async function getCommandCenterData(now: Date = new Date()): Promise<CommandCenterData> {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))

  const [
    exceptionSummary,
    approvalSummary,
    shipmentDiscrepancies,
    payoutReadyRows,
    readyForIntakeAgg,
    intakeInProgressCount,
    availableNotListedCount,
    openOrdersCount,
    itemsProcessedToday,
    itemsListedToday,
    overviewToday,
  ] = await Promise.all([
    getExceptionQueueSummary({}),
    getApprovalQueueSummary(),
    prisma.sellerInboundShipment.count({ where: { status: 'issue' } }),
    // A payout already awaiting its own mark-paid risk approval is not "ready to
    // process" — it's already counted under Pending Approvals (section 14). No
    // Prisma relation exists between SellerPayout and RiskApprovalRequest
    // (targetId is a polymorphic string, not an FK), so this exact exclusion is
    // expressed as a single NOT EXISTS COUNT rather than a capped findMany +
    // in-JS set-difference (focused-review section 1) — correct no matter how
    // many payouts or pending approvals exist.
    prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM "SellerPayout" sp
      WHERE sp.status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM "RiskApprovalRequest" r
          WHERE r."targetType" = 'seller_payout' AND r."targetId" = sp.id AND r.status = 'pending'
        )
    `,
    // Ready for Intake (section 10): received shipments with no intake-draft
    // lineage yet. DB-side count + sum via the real IntakeDraft relation — never a
    // row-capped findMany (focused-review section 1).
    prisma.sellerInboundShipment.aggregate({
      where: { status: 'received', intakeDraftLineage: { none: {} } },
      _count: { _all: true },
      _sum: { receivedQuantity: true },
    }),
    // Intake In Progress (section 11): received shipments with at least one
    // intake-draft already created against them.
    prisma.sellerInboundShipment.count({
      where: { status: 'received', intakeDraftLineage: { some: {} } },
    }),
    // "Available, not listed" (section 12) — a provable current-state filter, not a
    // formal Ready-to-List certification (that's 15J). No listing at all, or a
    // listing that's no longer active (archived), both count.
    prisma.itemInstance.count({
      where: { status: 'available', OR: [{ listing: null }, { listing: { status: { not: 'active' } } }] },
    }),
    // Section 13: schema cannot truthfully distinguish "requires action" from
    // "normal in-flight" beyond terminal states, so this is honestly labeled
    // "Open orders" rather than implying a certified action queue.
    prisma.order.count({ where: { status: { notIn: ['complete', 'cancelled'] } } }),
    prisma.itemInstance.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.listing.count({ where: { createdAt: { gte: todayStart } } }),
    getOverviewMetrics(todayRange(now)),
  ])

  const payoutReady = payoutReadyRows[0]?.count ?? 0
  const readyForIntake = { shipments: readyForIntakeAgg._count._all, units: readyForIntakeAgg._sum.receivedQuantity ?? 0 }

  const needsAttention: AttentionItem[] = sortByAttentionBand([
    {
      code: 'pending_approvals',
      label: 'Pending approvals',
      count: approvalSummary.pending,
      detail: approvalSummary.pending > 0
        ? `${approvalSummary.byRiskLevel.high} high / ${approvalSummary.byRiskLevel.medium} medium`
        : undefined,
      href: '/admin/approvals',
    },
    // No separate "payouts needing action" needs-attention card: it would show the
    // exact same number as Work Queue's Payout Ready below (focused-review section
    // 5) — a payout still gated by a pending mark-paid approval is already covered
    // by pending_approvals above, and an approved-and-ready payout is routine work,
    // not an exception, so it's represented once, in the Work Queue.
    {
      code: 'intake_exceptions',
      label: 'Intake exceptions',
      count: exceptionSummary.open,
      href: '/admin/intake/exceptions',
    },
    {
      code: 'shipment_discrepancies',
      label: 'Shipment discrepancies',
      count: shipmentDiscrepancies,
      href: '/admin/intake/operations?issueOnly=1',
    },
    {
      code: 'portfolio_issues',
      // No cheap global count exists without per-portfolio hydration (Part C
      // section 7) — link to the existing bounded needs_attention filter instead
      // of computing an expensive exact number here.
      label: 'Portfolio issues',
      count: null,
      href: '/admin/seller-portfolios?filter=needs_attention',
    },
    {
      code: 'inventory_contradictions',
      // Same rationale — detectItemContradictions runs per-item (15C detail page
      // only); no bounded global count exists yet.
      label: 'Inventory contradictions',
      count: null,
      href: '/admin/reconciliation',
    },
  ])

  return {
    needsAttention,
    workQueues: {
      readyForIntake: {
        shipments: readyForIntake.shipments,
        units: readyForIntake.units,
        href: '/admin/intake/operations',
      },
      intakeInProgress: {
        shipments: intakeInProgressCount,
        href: '/admin/intake/operations',
      },
      availableNotListed: {
        count: availableNotListedCount,
        href: '/admin/items?status=available',
      },
      openOrders: {
        count: openOrdersCount,
        href: '/admin/orders',
      },
      payoutReady: {
        count: payoutReady,
        href: '/admin/seller-payouts',
      },
    },
    businessPulse: {
      itemsProcessedToday,
      itemsListedToday,
      unitsSoldToday: overviewToday.unitsSold,
      completedOrdersToday: overviewToday.completedOrders,
      gmvToday: fmtUsdDecimal(overviewToday.gmv),
    },
  }
}
