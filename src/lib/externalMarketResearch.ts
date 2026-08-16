import { Prisma } from '@prisma/client'
import { prisma, type DbClient } from '@/lib/prisma'
import { median, percentile } from '@/lib/resaleEstimator'

// Below this sample count in the 12-month primary window, extend to 24-month history.
export const MIN_SOLD_PRIMARY_SAMPLE = 3

// Active-ask eligibility window in days. Asks older than this are stale and excluded.
export const ASK_WINDOW_DAYS = 30

export type ExternalSoldSummary = {
  medianCents: number
  p25Cents: number
  p75Cents: number
  minCents: number
  maxCents: number
  sampleSize: number
  freshestSoldAt: Date
  stalestSoldAt: Date
  extendedHistoryUsed: boolean  // true when 24m window was used due to thin primary
  windowMonths: 12 | 24
}

export type ResearchFreshness = 'fresh' | 'aging' | 'stale' | 'unavailable'

// Active-ask price stats — reuses the same askCents array already fetched for
// lowestActiveAskCents below; no additional query. Added for 14C pricing-intelligence
// evidence summaries (Tier 4: external active asks, context only — never a sold value).
export type ExternalAskSummary = {
  count: number
  medianCents: number
  p75Cents: number
  highestActiveAskCents: number
}

export type ExternalMarketSummary = {
  catalogModelId: string
  asOf: Date
  soldSummary: ExternalSoldSummary | null
  activeAskCount: number
  lowestActiveAskCents: number | null
  askSummary: ExternalAskSummary | null
  researchFreshness: ResearchFreshness
  latestSoldAt: Date | null
  latestAskObservedAt: Date | null
  providers: string[]
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Subtract calendar months from a date. JavaScript Date handles month-end overflow
// naturally (e.g. Feb 31 → Mar 2/3); this is intentional for boundary comparisons.
export function subtractMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() - months, date.getDate())
}

// ── Decimal → cents boundary ──────────────────────────────────────────────────

// Single controlled conversion from DB Decimal to integer cents.
// Avoids floating-point intermediate by using Decimal arithmetic before toNumber().
export function decimalToCents(d: Prisma.Decimal): number {
  return d.times(new Prisma.Decimal('100'))
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber()
}

// ── Computation ───────────────────────────────────────────────────────────────

// computeWindowStats remains available for admin-only diagnostic use.
// The buyer-facing API uses buildSoldSummary with the 12/24-month threshold logic.
export type WindowStats = {
  sampleSize: number
  medianCents: number | null
  p25Cents: number | null
  p75Cents: number | null
  minCents: number | null
  maxCents: number | null
  freshestObservedAt: Date | null
  stalestObservedAt: Date | null
}

export function computeWindowStats(
  priceCents: number[],
  observedAts: Date[],
  windowDays: number | null,
  asOf: Date,
): WindowStats | null {
  const cutoff = windowDays !== null
    ? new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000)
    : null

  const inWindow: Array<{ price: number; date: Date }> = []
  for (let i = 0; i < priceCents.length; i++) {
    if (cutoff === null || observedAts[i] >= cutoff) {
      inWindow.push({ price: priceCents[i], date: observedAts[i] })
    }
  }
  if (inWindow.length === 0) return null

  const sorted = [...inWindow].sort((a, b) => a.price - b.price)
  const prices = sorted.map(x => x.price)
  const n = prices.length
  const medianCents = n % 2 === 0
    ? Math.round((prices[n / 2 - 1] + prices[n / 2]) / 2)
    : prices[Math.floor(n / 2)]

  let freshest: Date | null = null
  let stalest: Date | null = null
  for (const { date } of inWindow) {
    if (!freshest || date > freshest) freshest = date
    if (!stalest || date < stalest) stalest = date
  }
  return {
    sampleSize: n,
    medianCents,
    p25Cents: prices[Math.floor((n - 1) * 0.25)],
    p75Cents: prices[Math.floor((n - 1) * 0.75)],
    minCents: prices[0],
    maxCents: prices[n - 1],
    freshestObservedAt: freshest,
    stalestObservedAt: stalest,
  }
}

// Build the primary buyer-facing sold summary.
// priceCents and soldAts are pre-filtered to the 24-month window (by the DB query).
// If primary (12m) has < MIN_SOLD_PRIMARY_SAMPLE, extended (24m) is used instead.
// Records exactly at the 12-month boundary belong to the primary window (>=).
export function buildSoldSummary(
  priceCents: number[],
  soldAts: Date[],
  asOf: Date,
): ExternalSoldSummary | null {
  if (priceCents.length === 0) return null

  const cutoff12m = subtractMonths(asOf, 12)

  const primaryIdxs: number[] = []
  for (let i = 0; i < soldAts.length; i++) {
    if (soldAts[i] >= cutoff12m) primaryIdxs.push(i)
  }
  const useExtended = primaryIdxs.length < MIN_SOLD_PRIMARY_SAMPLE

  const workingCents = useExtended ? priceCents : primaryIdxs.map(i => priceCents[i])
  const workingDates = useExtended ? soldAts   : primaryIdxs.map(i => soldAts[i])

  if (workingCents.length === 0) return null

  const sorted = [...workingCents].sort((a, b) => a - b)
  const n = sorted.length
  const medianCents = n % 2 === 0
    ? Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2)
    : sorted[Math.floor(n / 2)]

  let freshest = workingDates[0]
  let stalest  = workingDates[0]
  for (const d of workingDates) {
    if (d > freshest) freshest = d
    if (d < stalest)  stalest  = d
  }

  return {
    medianCents,
    p25Cents: sorted[Math.floor((n - 1) * 0.25)],
    p75Cents: sorted[Math.floor((n - 1) * 0.75)],
    minCents: sorted[0],
    maxCents: sorted[n - 1],
    sampleSize: n,
    freshestSoldAt: freshest,
    stalestSoldAt:  stalest,
    extendedHistoryUsed: useExtended,
    windowMonths: useExtended ? 24 : 12,
  }
}

export function classifyFreshness(
  latestSoldAt: Date | null,
  latestAskObservedAt: Date | null,
  asOf: Date,
): ResearchFreshness {
  const latest = latestSoldAt && latestAskObservedAt
    ? (latestSoldAt > latestAskObservedAt ? latestSoldAt : latestAskObservedAt)
    : (latestSoldAt ?? latestAskObservedAt)
  if (!latest) return 'unavailable'
  const daysSince = (asOf.getTime() - latest.getTime()) / (24 * 60 * 60 * 1000)
  if (daysSince <= 7)  return 'fresh'
  if (daysSince <= 30) return 'aging'
  return 'stale'
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function getExternalMarketSummary(
  catalogModelId: string,
  asOf: Date = new Date(),
): Promise<ExternalMarketSummary> {
  const map = await getExternalMarketSummaries([catalogModelId], asOf)
  return map.get(catalogModelId) ?? emptyExternalSummary(catalogModelId, asOf)
}

function emptyExternalSummary(catalogModelId: string, asOf: Date): ExternalMarketSummary {
  return {
    catalogModelId,
    asOf,
    soldSummary: null,
    activeAskCount: 0,
    lowestActiveAskCents: null,
    askSummary: null,
    researchFreshness: 'unavailable',
    latestSoldAt: null,
    latestAskObservedAt: null,
    providers: [],
  }
}

// Batch fetch matched, eligible observations for catalogModelIds and compute summaries.
// Eligible sold: matchStatus=matched, currency=USD, totalPrice>0, soldAt within 24 months.
// Eligible asks: matchStatus=matched, currency=USD, totalPrice>0, observedAt within 30 days.
// No per-record total cap — all eligible rows are fetched.
// asOf must be provided by the caller so all summaries in one request share one timestamp.
// 15K (execution-snapshot pass): `client` defaults to the global prisma client, so
// every existing caller is unaffected — a caller holding an open transaction (e.g.
// auto-listing execution) passes its `tx` so this read joins that transaction's
// isolation snapshot instead of its own disconnected implicit transaction.
export async function getExternalMarketSummaries(
  catalogModelIds: string[],
  asOf: Date = new Date(),
  client: DbClient = prisma,
): Promise<Map<string, ExternalMarketSummary>> {
  const deduped = [...new Set(catalogModelIds)]
  if (deduped.length === 0) return new Map()

  const cutoff24m  = subtractMonths(asOf, 24)
  const cutoffAsk  = new Date(asOf.getTime() - ASK_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // Single query: eligible sold (≤24 months) + eligible asks (≤30 days).
  // DB-level predicates: matchStatus=matched, currency=USD, totalPrice>0.
  // No take limit — complete coverage is required for correct medians/counts.
  const obs = await client.externalMarketObservation.findMany({
    where: {
      catalogModelId: { in: deduped },
      matchStatus: 'matched',
      currency: 'USD',
      totalPrice: { gt: 0 },
      OR: [
        { observationType: 'sold',       soldAt:     { gte: cutoff24m } },
        { observationType: 'active_ask', observedAt: { gte: cutoffAsk } },
      ],
    },
    select: {
      catalogModelId: true,
      observationType: true,
      totalPrice: true,
      soldAt: true,
      observedAt: true,
      provider: true,
    },
    orderBy: { id: 'asc' },
  })

  const byCatalog = new Map<string, typeof obs>()
  for (const row of obs) {
    if (!row.catalogModelId) continue
    if (!byCatalog.has(row.catalogModelId)) byCatalog.set(row.catalogModelId, [])
    byCatalog.get(row.catalogModelId)!.push(row)
  }

  const result = new Map<string, ExternalMarketSummary>()

  for (const catalogModelId of deduped) {
    const rows = byCatalog.get(catalogModelId) ?? []

    // Eligible sold: soldAt not null and within 24m (already guaranteed by DB query)
    const soldRows = rows.filter(r => r.observationType === 'sold' && r.soldAt !== null)
    const soldPriceCents = soldRows.map(r => decimalToCents(r.totalPrice))
    const soldDates      = soldRows.map(r => r.soldAt!)

    // Eligible asks: observedAt within 30d (already guaranteed by DB query)
    const askRows        = rows.filter(r => r.observationType === 'active_ask')
    const askCents       = askRows.map(r => decimalToCents(r.totalPrice))

    const latestSoldAt         = soldDates.length > 0
      ? soldDates.reduce((a, b) => (b > a ? b : a))
      : null
    const latestAskObservedAt  = askRows.length > 0
      ? askRows.map(r => r.observedAt).reduce((a, b) => (b > a ? b : a))
      : null

    const providers = [...new Set(rows.map(r => r.provider))]

    const sortedAsks = [...askCents].sort((a, b) => a - b)
    const askSummary: ExternalAskSummary | null = sortedAsks.length > 0
      ? {
          count: sortedAsks.length,
          medianCents: median(sortedAsks),
          p75Cents: percentile(sortedAsks, 0.75),
          highestActiveAskCents: sortedAsks[sortedAsks.length - 1],
        }
      : null

    result.set(catalogModelId, {
      catalogModelId,
      asOf,
      soldSummary: buildSoldSummary(soldPriceCents, soldDates, asOf),
      activeAskCount: askRows.length,
      lowestActiveAskCents: askCents.length > 0 ? Math.min(...askCents) : null,
      askSummary,
      researchFreshness: classifyFreshness(latestSoldAt, latestAskObservedAt, asOf),
      latestSoldAt,
      latestAskObservedAt,
      providers,
    })
  }

  for (const catalogModelId of deduped) {
    if (!result.has(catalogModelId)) result.set(catalogModelId, emptyExternalSummary(catalogModelId, asOf))
  }

  return result
}
