// 15N: pure finance-definition layer. No DB access (see financialPositionQuery.ts
// for that boundary). Owns metric semantics/classification/coverage — never
// recomputed independently in a React page.
//
// ── Part A inspection findings — reported here, not silently assumed ─────────────
// * No authoritative cash/bank/Stripe balance is persisted anywhere in this schema
//   (Order stores payment identifiers, not a balance). "Cash"/"Liquidity"/"Net Cash"
//   can never be computed truthfully — financialPositionQuery.ts reports this
//   population as `unavailable`, never $0 or a GMV substitute.
// * Order/OrderItem/SellerPayoutLine have no refund, shipping-cost, payment-
//   processor-fee, or tax fields — "Other cash activity" (Part I/26) is omitted
//   entirely rather than estimated.
// * Buyout seller obligations are already fully represented in SellerPayoutLine
//   (lineType='buyout', created once per accepted agreement at intake conversion —
//   see intakeConversion.ts). SellerAgreement.agreedBuyoutAmount is therefore NEVER
//   added as a second liability figure here (Part G/19). It also never supports a
//   current-inventory-cost figure (focused-review, buyout-cost-semantics pass): for
//   a multi-item batch there is no valid way to attribute any portion of the
//   agreement total to specific still-held units once any unit from that batch has
//   sold — current owned-inventory cost is exclusively exact item-level
//   ItemInstance.purchasePrice; the gap is disclosed only via unit-based coverage.
// * Inventory turnover (Part M/38) is omitted — no reliable, already-established
//   COGS-over-time denominator exists in this data model to build one truthfully.

import { Prisma } from '@prisma/client'

// ── Ownership classification (Part C) ─────────────────────────────────────────────
// Only these two sourceType values represent company-owned physical inventory.
// Consignment is never company-owned. Legacy/unknown (null, or any other historical
// value) is neither — it is reported as its own bucket, never silently folded into
// "owned" or "consigned" (Part C/4).
export const OWNED_SOURCE_TYPES = ['buyout', 'company_owned'] as const
export type OwnedSourceType = (typeof OWNED_SOURCE_TYPES)[number]

export function isOwnedSourceType(sourceType: string | null): sourceType is OwnedSourceType {
  return sourceType !== null && (OWNED_SOURCE_TYPES as readonly string[]).includes(sourceType)
}

export function isConsignmentSourceType(sourceType: string | null): boolean {
  return sourceType === 'consignment'
}

// ── Metric availability model (Part S/46) ─────────────────────────────────────────
// Never `null -> $0`. A metric is either fully available, available only for a known
// subset of a larger population (partial, with explicit coverage), or genuinely
// unavailable with a stated reason — three distinct states, never collapsed.
export type FinancialMetric<T> =
  | { status: 'available'; value: T }
  | { status: 'partial'; value: T; coveragePct: number; knownUnits: number; totalUnits: number }
  | { status: 'unavailable'; reason: string }

// One decimal place — enough to distinguish 74.6% from 75.4% without false precision.
export function coveragePercent(knownUnits: number, totalUnits: number): number | null {
  if (totalUnits <= 0) return null
  return Math.round((knownUnits / totalUnits) * 1000) / 10
}

// Builds a FinancialMetric from a known-subset value and the known/total unit counts
// (Part 7/33: coverage is UNIT-based — knownUnits/totalUnits — never value-weighted
// or guessed). totalUnits === 0 is reported unavailable (no population to cover),
// distinct from a genuinely-zero value over a real population.
export function unitCoverageMetric<T>(value: T, knownUnits: number, totalUnits: number, emptyReason: string): FinancialMetric<T> {
  const pct = coveragePercent(knownUnits, totalUnits)
  if (pct === null) return { status: 'unavailable', reason: emptyReason }
  if (knownUnits >= totalUnits) return { status: 'available', value }
  return { status: 'partial', value, coveragePct: pct, knownUnits, totalUnits }
}

// ── Aging buckets (Part M/36, Part N/39) ──────────────────────────────────────────
// Shared boundary definition — reused by both owned-inventory aging and (via 14B's
// own getLiabilityAging, which predates this file and keeps its own identical-shaped
// buckets) payout-liability aging, so the two never drift into different day ranges
// under the same "Aging" label.
export type AgingBucketKey = '0-30' | '31-60' | '61-90' | '90+'
export const OWNED_INVENTORY_AGING_BUCKETS: { key: AgingBucketKey; minDays: number; maxDays: number | null }[] = [
  { key: '0-30', minDays: 0, maxDays: 30 },
  { key: '31-60', minDays: 31, maxDays: 60 },
  { key: '61-90', minDays: 61, maxDays: 90 },
  { key: '90+', minDays: 91, maxDays: null },
]

export function ageInDays(since: Date, asOf: Date): number {
  return Math.floor((asOf.getTime() - since.getTime()) / 86_400_000)
}

export function bucketForAgeDays(days: number): AgingBucketKey {
  for (const b of OWNED_INVENTORY_AGING_BUCKETS) {
    if (days >= b.minDays && (b.maxDays === null || days <= b.maxDays)) return b.key
  }
  return '90+'
}

// ── Money helper (Part T) ─────────────────────────────────────────────────────────
// A DB-side aggregate (_sum) already performed the addition in Postgres — this is a
// single, controlled Float->Decimal conversion of that ONE returned total, never a
// JS reduce() accumulating many rows.
export function decimalFromAggregateSum(sum: number | null): Prisma.Decimal {
  return sum === null ? new Prisma.Decimal(0) : new Prisma.Decimal(sum.toFixed(2))
}
