// 14B: Pure financial/statistical calculations. Decimal-safe — never accumulates
// money via JS Number/Float. All money enters/leaves as Prisma.Decimal or integer cents.

import { Prisma } from '@prisma/client'

const ZERO = new Prisma.Decimal(0)
const DP = 2
const ROUND = Prisma.Decimal.ROUND_HALF_UP

// ── Money ────────────────────────────────────────────────────────────────────────

// Converts a Listing/OrderItem Float price (always 2-decimal dollars in this schema)
// to Decimal via its fixed string form — never via direct Number arithmetic.
export function decimalFromFloatDollars(dollars: number): Prisma.Decimal {
  return new Prisma.Decimal(dollars.toFixed(2))
}

export function sumDecimal(values: Array<Prisma.Decimal | null | undefined>): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => (v ? acc.plus(v) : acc), ZERO).toDecimalPlaces(DP, ROUND)
}

export function decimalToCents(d: Prisma.Decimal): number {
  return d.times(100).toDecimalPlaces(0, ROUND).toNumber()
}

export function centsToDecimal(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100).toDecimalPlaces(DP, ROUND)
}

export function subtractDecimal(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.minus(b).toDecimalPlaces(DP, ROUND)
}

export const DECIMAL_ZERO = ZERO

// ── Commercial period summary (17E final source-of-truth cleanup) ────────────────
//
// Pure — takes already-fetched rows, does no DB access. The ONE place completed-
// orders/units-sold/GMV are computed from raw OrderItem rows. Both
// getCommercialPeriodSummary (its own narrow `{price}`-only fetch) and
// getOverviewMetrics (its wider fetch, which already contains `price` alongside the
// extra fields margin/median need) call this same function — a wide row satisfies
// `{ price: number }` structurally, so no second query or reshaping is needed.
export type CommercialPeriodSummary = { completedOrders: number; unitsSold: number; gmv: Prisma.Decimal }

export function computeCommercialPeriodSummary(input: { orderItems: Array<{ price: number }>; completedOrders: number }): CommercialPeriodSummary {
  return {
    completedOrders: input.completedOrders,
    unitsSold: input.orderItems.length,
    gmv: sumDecimal(input.orderItems.map(r => decimalFromFloatDollars(r.price))),
  }
}

// ── Ratios / period comparisons ─────────────────────────────────────────────────

export type RatioResult = { value: number | null; numerator: number; denominator: number }

// Zero denominator → null (renders "N/A"), never divide-by-zero or Infinity.
export function ratio(numerator: number, denominator: number): RatioResult {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator }
}

export type PeriodChange = { kind: 'change'; pct: number } | { kind: 'new' } | { kind: 'unavailable' }

// current/previous are flow counts over equal-length periods. previous=0 with
// current>0 is reported as 'new' (not a fake infinite percentage). Both zero is
// 'unavailable' (nothing changed, nothing to compare).
export function periodChange(current: number, previous: number): PeriodChange {
  if (previous === 0) return current > 0 ? { kind: 'new' } : { kind: 'unavailable' }
  return { kind: 'change', pct: ((current - previous) / previous) * 100 }
}

// ── Descriptive stats over a sorted-ready number[] (e.g. days-to-sell durations) ──

export type DurationStats = { average: number | null; median: number | null; p75: number | null; p90: number | null; count: number }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export function computeDurationStats(days: number[]): DurationStats {
  if (days.length === 0) return { average: null, median: null, p75: null, p90: null, count: 0 }
  const sorted = [...days].sort((a, b) => a - b)
  const average = sorted.reduce((s, d) => s + d, 0) / sorted.length
  return {
    average,
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    count: sorted.length,
  }
}

// Whole calendar days between two instants, using UTC-safe millisecond math (no
// timezone-dependent date-part subtraction). Negative durations are invalid data —
// callers must exclude them rather than silently including a negative "days to sell".
export function daysBetween(earlier: Date, later: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000)
}
