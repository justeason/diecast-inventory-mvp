// 23B: pure Valuation Engine V1 math — no Prisma, no DB client, no Next APIs.
// Operates entirely on already-fetched 22B MarketSaleObservation[] (or simpler
// pure structures). median/percentile/IQR-fence logic is a behavior-preserving
// extraction of the already-proven implementation in resaleEstimator.ts /
// advancedValuation.ts — copied rather than imported, so this milestone never
// risks changing the legacy engine's own behavior (23A §54/§81).
import type { MarketSaleObservation } from './marketSaleQuery'

export type SpecificityTier = 'model_variant_condition' | 'model_variant' | 'model'
export type ValuationConfidence = 'high' | 'medium' | 'low'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const OUTLIER_MIN_SAMPLE = 5
const RANGE_MIN_SAMPLE = 5
const RECENCY_THRESHOLD_DAYS = 90
const HIGH_DISPERSION_RATIO = 0.5

// ── Median / percentile — identical behavior to resaleEstimator.ts's own ──────
export function median(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) throw new Error('median: empty array')
  if (n % 2 === 1) return sorted[Math.floor(n / 2)]
  return Math.round((sorted[Math.floor(n / 2) - 1] + sorted[Math.floor(n / 2)]) / 2)
}

export function percentile(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) throw new Error('percentile: empty array')
  const idx = Math.floor(p * (n - 1))
  return sorted[idx]
}

// ── Outlier filter — Tukey 1.5×IQR, identical fence arithmetic to
// advancedValuation.ts's applyIqrFilter, generalized over any object exposing
// priceCents so callers never need a separate price-to-record reconciliation
// step (the old engine's own count-matching workaround). Never removes every
// observation — falls back to the raw (sorted) set if filtering would empty it. ──
export function applyOutlierFilter<T extends { priceCents: number }>(
  observations: T[],
): { used: T[]; removed: boolean } {
  const sorted = [...observations].sort((a, b) => a.priceCents - b.priceCents)
  if (sorted.length < OUTLIER_MIN_SAMPLE) return { used: sorted, removed: false }

  const prices = sorted.map((o) => o.priceCents)
  const q1 = percentile(prices, 0.25)
  const q3 = percentile(prices, 0.75)
  const iqr = q3 - q1
  // Doubled-integer arithmetic avoids fractional cents: 2v >= 2*Q1-3*IQR <=> v >= Q1-1.5*IQR
  const lo2 = 2 * q1 - 3 * iqr
  const hi2 = 2 * q3 + 3 * iqr

  const filtered = sorted.filter((o) => 2 * o.priceCents >= lo2 && 2 * o.priceCents <= hi2)
  if (filtered.length === 0) return { used: sorted, removed: false }
  return { used: filtered, removed: filtered.length < sorted.length }
}

// ── Market Range — Q1/Q3 of the post-outlier USED sample. Requires N>=5
// (same threshold at which outlier filtering itself activates) — below that,
// quartile statistics are not meaningfully stable, so range is null rather
// than a fabricated interval. Never raw min/max. ──────────────────────────────
export function computeMarketRange(usedSortedPricesCents: number[]): { low: number | null; high: number | null } {
  if (usedSortedPricesCents.length < RANGE_MIN_SAMPLE) return { low: null, high: null }
  return { low: percentile(usedSortedPricesCents, 0.25), high: percentile(usedSortedPricesCents, 0.75) }
}

// ── Dispersion — descriptive only, feeds confidence, never a volatility score. ──
export function isHighDispersion(rangeLowCents: number | null, rangeHighCents: number | null, estimatedValueCents: number): boolean {
  if (rangeLowCents === null || rangeHighCents === null || estimatedValueCents <= 0) return false
  return (rangeHighCents - rangeLowCents) / estimatedValueCents > HIGH_DISPERSION_RATIO
}

// ── Specificity tier selection ────────────────────────────────────────────────
// Membership is presence/absence only — a tier with >=1 qualifying observation
// is used; NEVER broadened merely because a wider tier has more samples.
// Unknown (null) fields never satisfy a narrower tier (21C/21D's own
// "null means unknown, never coerced" principle, reused here).
export type TierTarget = { marketVariantId: string | null; condition: string | null }

export function filterByTier(
  observations: MarketSaleObservation[],
  tier: SpecificityTier,
  target: TierTarget,
): MarketSaleObservation[] {
  if (tier === 'model') return observations
  if (tier === 'model_variant') {
    return target.marketVariantId === null
      ? []
      : observations.filter((o) => o.marketVariantId !== null && o.marketVariantId === target.marketVariantId)
  }
  // model_variant_condition
  if (target.marketVariantId === null || target.condition === null) return []
  return observations.filter(
    (o) =>
      o.marketVariantId !== null &&
      o.marketVariantId === target.marketVariantId &&
      o.condition !== null &&
      o.condition === target.condition,
  )
}

export type TierSelection = { specificity: SpecificityTier; observations: MarketSaleObservation[] }

// allowedTiers must be ordered narrowest -> broadest. Returns the first tier
// (in order) with >=1 qualifying observation, or null if none qualify at all.
export function selectTier(
  observations: MarketSaleObservation[],
  allowedTiers: SpecificityTier[],
  target: TierTarget,
): TierSelection | null {
  for (const tier of allowedTiers) {
    const matched = filterByTier(observations, tier, target)
    if (matched.length > 0) return { specificity: tier, observations: matched }
  }
  return null
}

// ── Source-mix counting — no weighting, just a split. ─────────────────────────
export function splitSourceCounts(observations: MarketSaleObservation[]): { internal: number; external: number } {
  let internal = 0
  let external = 0
  for (const o of observations) {
    if (o.sourceType === 'internal') internal++
    else external++
  }
  return { internal, external }
}

export function latestSoldAt(observations: Array<{ soldAt: Date }>): Date | null {
  if (observations.length === 0) return null
  return new Date(Math.max(...observations.map((o) => o.soldAt.getTime())))
}

// ── Assembly ───────────────────────────────────────────────────────────────────
// 25B: the single pure "raw observations -> valued result" step shared by both
// the single-model orchestration (marketValuation.ts::getValuation) and the
// Portfolio batch composition (marketValuation.ts::getValuationsBatch) — the
// only difference between single and batch is HOW the observation bucket for
// one model was fetched; once fetched, both must run through this exact same
// median/outlier/range/confidence assembly. No second valuation algorithm.
export type ValuedAssemblyInput = {
  catalogModelId: string
  marketVariantId: string | null
  condition: string | null
  specificity: SpecificityTier
  primarySpecificity: SpecificityTier
  observations: MarketSaleObservation[]
  asOf: Date
  windowStart: Date
  extendedHistoryUsed: boolean
  sampleTruncated: boolean
  fallbackReason: 'no_sales_at_requested_specificity' | 'no_recent_sales' | null
}

export type ValuedAssemblyResult = {
  status: 'valued'
  catalogModelId: string
  marketVariantId: string | null
  condition: string | null
  estimatedValueCents: number
  marketRangeLowCents: number | null
  marketRangeHighCents: number | null
  confidence: ValuationConfidence
  specificity: SpecificityTier
  primarySpecificity: SpecificityTier
  rawSampleCount: number
  usedSampleCount: number
  excludedOutlierCount: number
  internalSampleCount: number
  externalSampleCount: number
  asOf: Date
  windowStart: Date
  extendedHistoryUsed: boolean
  sampleTruncated: boolean
  method: 'median_sales'
  outlierMethod: 'iqr_1_5' | 'none'
  fallbackReason: 'no_sales_at_requested_specificity' | 'no_recent_sales' | null
  latestSaleAt: Date | null
}

export function assembleValuedResult(input: ValuedAssemblyInput): ValuedAssemblyResult {
  const rawObservations = input.observations
  const rawSampleCount = rawObservations.length
  const { used } = applyOutlierFilter(rawObservations)
  const usedSampleCount = used.length
  const excludedOutlierCount = rawSampleCount - usedSampleCount

  const usedSortedPrices = used.map((o) => o.priceCents).sort((a, b) => a - b)
  const estimatedValueCents = median(usedSortedPrices)
  const { low: marketRangeLowCents, high: marketRangeHighCents } = computeMarketRange(usedSortedPrices)

  const { internal: internalSampleCount, external: externalSampleCount } = splitSourceCounts(used)
  const latestUsedSaleAt = latestSoldAt(used)

  const confidence = deriveConfidence({
    usedSampleCount,
    latestSaleAt: latestUsedSaleAt,
    asOf: input.asOf,
    isPrimarySpecificity: input.specificity === input.primarySpecificity,
    extendedHistoryUsed: input.extendedHistoryUsed,
    isHighDispersion: isHighDispersion(marketRangeLowCents, marketRangeHighCents, estimatedValueCents),
  })

  return {
    status: 'valued',
    catalogModelId: input.catalogModelId,
    marketVariantId: input.marketVariantId,
    condition: input.condition,

    estimatedValueCents,
    marketRangeLowCents,
    marketRangeHighCents,

    confidence,
    specificity: input.specificity,
    primarySpecificity: input.primarySpecificity,

    rawSampleCount,
    usedSampleCount,
    excludedOutlierCount,

    internalSampleCount,
    externalSampleCount,

    asOf: input.asOf,
    windowStart: input.windowStart,
    extendedHistoryUsed: input.extendedHistoryUsed,
    sampleTruncated: input.sampleTruncated,

    method: 'median_sales',
    outlierMethod: rawSampleCount >= 5 ? 'iqr_1_5' : 'none',
    fallbackReason: input.fallbackReason,

    latestSaleAt: latestUsedSaleAt,
  }
}

// ── Confidence ─────────────────────────────────────────────────────────────────
// "How strongly the available data supports this estimate" — never a
// probability of selling at that price. Extended history is inherently stale
// (it was only ever queried after the entire primary-window hierarchy came up
// empty), so it is capped at 'low' regardless of sample size.
export function deriveConfidence(params: {
  usedSampleCount: number
  latestSaleAt: Date | null
  asOf: Date
  isPrimarySpecificity: boolean
  extendedHistoryUsed: boolean
  isHighDispersion: boolean
}): ValuationConfidence {
  if (params.extendedHistoryUsed) return 'low'

  const latestAgeDays = params.latestSaleAt
    ? (params.asOf.getTime() - params.latestSaleAt.getTime()) / MS_PER_DAY
    : Infinity
  const isRecent = latestAgeDays <= RECENCY_THRESHOLD_DAYS

  if (
    params.usedSampleCount >= 8 &&
    isRecent &&
    params.isPrimarySpecificity &&
    !params.isHighDispersion
  ) {
    return 'high'
  }
  if (params.usedSampleCount >= 3 && isRecent) {
    return 'medium'
  }
  return 'low'
}
