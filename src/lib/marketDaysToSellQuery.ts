// 30B: canonical, focused Days-to-Sell query — a NEW lower-level query, not a
// reuse of the legacy resaleEstimator.ts engine (which stays untouched for its
// existing admin/cross-model consumers, per 30A §26/§74). Reuses the exact 22B
// internal sale-eligibility predicate (buildInternalWhere, marketSaleQuery.ts)
// — never a second, weaker "completed sale" definition — and joins
// Listing.createdAt (the only listing-start timestamp the schema has) to
// compute duration = completedAt - listing.createdAt. Internal-only: external
// sold observations carry no listing-created-date equivalent (30A §18).
import { prisma } from '@/lib/prisma'
import { buildInternalWhere } from './marketSaleQuery'
import { median } from './marketValuationMath'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// 30A §29: sparser than raw sales activity — reuses the same 180-day window
// as /market's real Fast Movers precedent, never unlimited all-time history,
// never a model-family fallback.
export const DAYS_TO_SELL_WINDOW_DAYS = 180
// 30A §30: no median from N=1 or N=2 — not a robust signal without context.
export const DAYS_TO_SELL_MIN_SAMPLE = 3

export type DaysToSellResult =
  | { status: 'insufficient_data'; sampleCount: number }
  | { status: 'available'; medianDays: number; sampleCount: number }

export type DaysToSellFilter = {
  catalogModelId: string
  marketVariantId?: string
  startDate: Date
  endDate: Date
}

export async function getMedianDaysToSell(filter: DaysToSellFilter): Promise<DaysToSellResult> {
  const rows = await prisma.orderItem.findMany({
    where: buildInternalWhere(filter),
    select: {
      order: { select: { completedAt: true } },
      listing: { select: { createdAt: true } },
    },
  })

  const durations: number[] = []
  for (const row of rows) {
    const completedAt = row.order.completedAt
    if (!completedAt) continue
    const durationMs = completedAt.getTime() - row.listing.createdAt.getTime()
    if (durationMs < 0) continue // 30A §27/§73: negative/invalid duration excluded
    durations.push(Math.round(durationMs / MS_PER_DAY))
  }

  if (durations.length < DAYS_TO_SELL_MIN_SAMPLE) {
    return { status: 'insufficient_data', sampleCount: durations.length }
  }

  durations.sort((a, b) => a - b)
  return { status: 'available', medianDays: median(durations), sampleCount: durations.length }
}
