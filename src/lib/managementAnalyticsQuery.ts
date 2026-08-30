// 17E: Cross-domain management operating summary — pure orchestration/composition
// layer. Calls existing authoritative helpers from businessAnalyticsQuery.ts
// (14B/17C), financialPositionQuery.ts (15N), and catalogAnalyticsQuery.ts (17D).
// No formula, predicate, or aggregation is reimplemented here — this file only
// shapes their outputs into one summary object. See each source module for the
// actual metric definitions; this module owns none of them.

import type { Prisma } from '@prisma/client'
import type { DateRange } from '@/lib/businessAnalyticsDates'
// 17E final query-efficiency reconciliation: uses the narrow getCommercialPeriodSummary
// (completedOrders/unitsSold/gmv only), never the full getOverviewMetrics — which also
// triggers gross spread/margin, active inventory, sell-through/listing cohorts, its OWN
// getOutstandingLiability() call, and sellers-with-completed-sales, none of which this
// page renders. Using the narrow helper also removes what would otherwise be a second,
// duplicate getOutstandingLiability() fetch: this module's own direct call below is now
// the ONLY call to it for a management request.
import { getCommercialPeriodSummary } from '@/lib/businessAnalyticsQuery'
import { getOwnedInventoryPosition, getOutstandingLiability, type OwnedInventoryPosition } from '@/lib/financialPositionQuery'
import { getWantedWithNoSupply, type WantedNoSupplyRow } from '@/lib/catalogAnalyticsQuery'

// Small shortlist only — the full ranked list lives at /admin/analytics/catalog.
// Passed straight through to 17D's own getWantedWithNoSupply(limit) parameter
// (added in 17E as a tiny, behavior-preserving extraction — default unchanged).
const CATALOG_SHORTLIST_LIMIT = 5

export type ManagementSummary = {
  // SELECTED PERIOD — from businessAnalyticsQuery.getCommercialPeriodSummary(range).
  commercial: {
    completedOrders: number
    unitsSold: number
    gmv: Prisma.Decimal
  }
  // CURRENT SNAPSHOT — from financialPositionQuery.ts (15N). No range involved.
  financialPosition: {
    ownedInventory: OwnedInventoryPosition
    outstandingSellerLiability: Prisma.Decimal
  }
  // CURRENT SNAPSHOT — from catalogAnalyticsQuery.ts (17D). No range involved.
  catalogSignals: {
    noSupply: WantedNoSupplyRow[]
    noSupplyTruncated: boolean
  }
}

export async function getManagementSummary(range: DateRange): Promise<ManagementSummary> {
  const [commercial, ownedInventory, outstandingSellerLiability, noSupply] = await Promise.all([
    getCommercialPeriodSummary(range),
    getOwnedInventoryPosition(),
    getOutstandingLiability(),
    getWantedWithNoSupply(CATALOG_SHORTLIST_LIMIT),
  ])

  return {
    commercial,
    financialPosition: {
      ownedInventory,
      outstandingSellerLiability,
    },
    catalogSignals: {
      noSupply: noSupply.items,
      noSupplyTruncated: noSupply.truncated,
    },
  }
}
