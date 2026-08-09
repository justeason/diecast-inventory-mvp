import { median, percentile, computeEstimate } from '@/lib/resaleEstimator'
import type { MatchLevel, TargetModel, ComparableSale, ComparableRecord } from '@/lib/resaleEstimator'

export type MatchTier = MatchLevel

export type AdvancedConfidence = 'high' | 'medium' | 'low' | 'insufficient'

export type ConfidenceReasonCode =
  | 'exact_match'
  | 'fallback_match'
  | 'sample_count_high'
  | 'sample_count_medium'
  | 'sample_count_low'
  | 'sample_insufficient'
  | 'recent_sales_good'
  | 'recent_sales_stale'
  | 'recent_sales_none'
  | 'dispersion_high'
  | 'outliers_removed'
  | 'extended_history'
  | 'latest_sale_fresh'
  | 'latest_sale_stale'

export type ConfidenceReason = {
  code: ConfidenceReasonCode
  label: string
}

export type TrendDirection = 'up' | 'down' | 'flat' | 'unavailable'

export type TrendResult = {
  direction: TrendDirection
  percentageChange: number | null
  recentMedian: number | null
  priorMedian: number | null
}

export type LiquidityContext = {
  medianDaysToSell: number | null
  p25DaysToSell: number | null
  p75DaysToSell: number | null
  durationSampleCount: number
  recentCompletedSaleCount: number
  activePurchasableListingCount: number
}

export type ActiveAskContext = {
  activeListingCount: number
  lowestActiveAsk: number | null
  medianActiveAsk: number | null
  highestActiveAsk: number | null
}

export type AdvancedValuation = {
  catalogModelId: string
  asOf: Date
  matchTier: MatchTier
  sampleCount: number
  effectiveSampleCount: number
  estimatedValue: number | null
  lowEstimate: number | null
  highEstimate: number | null
  confidence: AdvancedConfidence
  confidenceReasons: ConfidenceReason[]
  latestSaleAt: Date | null
  medianDaysToSell: number | null
  recentTrend: TrendResult
  activeAskContext: ActiveAskContext
  liquidity: LiquidityContext
  outliersRemoved: boolean
  unweightedMedian: number | null
  weightedMedian: number | null
  extendedHistoryUsed: boolean
  // Min/max of the filtered (post-IQR) sold set, and the oldest sale in the chosen
  // window — additive fields for 14C pricing-intelligence blending; not used by the
  // pre-existing collection-valuation consumer.
  minCents: number | null
  maxCents: number | null
  oldestSaleAt: Date | null
}

const MS_90D  = 90  * 24 * 60 * 60 * 1000
const MS_180D = 180 * 24 * 60 * 60 * 1000
const MS_365D = 365 * 24 * 60 * 60 * 1000

const OUTLIER_MIN_SAMPLE = 5
const TREND_MIN_WINDOW = 3
const FLAT_THRESHOLD = 0.03
const WEIGHTED_MEDIAN_MIN_RECENT = 3

// ── IQR outlier filter ────────────────────────────────────────────────────────

// Returns filtered set and whether any values were removed.
// Operates on integer cents. Never removes all observations.
export function applyIqrFilter(sorted: number[]): { filtered: number[]; removed: boolean } {
  if (sorted.length < OUTLIER_MIN_SAMPLE) return { filtered: sorted, removed: false }
  const q1 = percentile(sorted, 0.25)
  const q3 = percentile(sorted, 0.75)
  const iqr = q3 - q1
  // Multiply by 2 to stay in integers: 2*v >= 2*Q1 - 3*IQR  ↔  v >= Q1 - 1.5*IQR
  const lo2 = 2 * q1 - 3 * iqr
  const hi2 = 2 * q3 + 3 * iqr
  const filtered = sorted.filter(v => 2 * v >= lo2 && 2 * v <= hi2)
  if (filtered.length === 0) return { filtered: sorted, removed: false }
  return { filtered, removed: filtered.length < sorted.length }
}

// ── Recency weighting ─────────────────────────────────────────────────────────

// Returns integer weight for a sale's age in ms.
// Boundaries: 0–90d → 4, 91–180d → 3, 181–365d → 2, older → 1.
// A sale at exactly 90 days gets weight 4 (belongs to the most-recent bucket).
export function recencyWeight(ageMs: number): number {
  if (ageMs <= MS_90D)  return 4
  if (ageMs <= MS_180D) return 3
  if (ageMs <= MS_365D) return 2
  return 1
}

// Weighted median via weight-expansion then standard median. Returns integer cents.
export function weightedMedianCents(records: ComparableRecord[], asOf: Date): number {
  const asOfMs = asOf.getTime()
  const expanded: number[] = []
  for (const r of records) {
    const ageMs = asOfMs - r.orderCompletedAt.getTime()
    const w = recencyWeight(Math.max(0, ageMs))
    for (let i = 0; i < w; i++) expanded.push(r.soldPriceCents)
  }
  expanded.sort((a, b) => a - b)
  return median(expanded)
}

// ── Trend ─────────────────────────────────────────────────────────────────────

// Uses exact-model completed sales only. Requires >=3 valid sales per window.
// A sale at exactly 90 days old belongs to the recent (0–90d) window.
// Fallback matches are excluded.
export function computeTrend(
  records: ComparableRecord[],
  asOf: Date,
): TrendResult {
  const asOfMs = asOf.getTime()
  const exactRecords = records.filter(r => r.matchLevel === 'exact')

  const recentPrices: number[] = []
  const priorPrices: number[] = []
  for (const r of exactRecords) {
    const ageMs = asOfMs - r.orderCompletedAt.getTime()
    if (ageMs <= MS_90D)  recentPrices.push(r.soldPriceCents)
    else if (ageMs <= MS_180D) priorPrices.push(r.soldPriceCents)
  }

  if (recentPrices.length < TREND_MIN_WINDOW || priorPrices.length < TREND_MIN_WINDOW) {
    return { direction: 'unavailable', percentageChange: null, recentMedian: null, priorMedian: null }
  }

  recentPrices.sort((a, b) => a - b)
  priorPrices.sort((a, b) => a - b)
  const recentMedian = median(recentPrices)
  const priorMedian  = median(priorPrices)

  if (priorMedian === 0) {
    return { direction: 'unavailable', percentageChange: null, recentMedian, priorMedian }
  }

  const change    = (recentMedian - priorMedian) / priorMedian
  const absChange = Math.abs(change)
  const direction: TrendDirection = absChange < FLAT_THRESHOLD ? 'flat' : change > 0 ? 'up' : 'down'
  const percentageChange = Math.round(change * 10000) / 100

  return { direction, percentageChange, recentMedian, priorMedian }
}

// ── Confidence ────────────────────────────────────────────────────────────────

export function deriveAdvancedConfidence(params: {
  matchTier: MatchTier
  sampleCount: number
  recentSampleCount: number
  latestSaleAt: Date | null
  asOf: Date
  iqrRange: number | null
  estimatedValueCents: number | null
  outliersRemoved: boolean
  extendedHistoryUsed: boolean
}): { confidence: AdvancedConfidence; reasons: ConfidenceReason[] } {
  const reasons: ConfidenceReason[] = []

  if (params.sampleCount === 0 || params.matchTier === 'insufficient') {
    return {
      confidence: 'insufficient',
      reasons: [{ code: 'sample_insufficient', label: 'No eligible completed sales' }],
    }
  }

  if (params.matchTier === 'exact') {
    reasons.push({ code: 'exact_match', label: 'Exact model match' })
  } else {
    reasons.push({ code: 'fallback_match', label: `Fallback match (${params.matchTier})` })
  }

  if (params.sampleCount >= 8) {
    reasons.push({ code: 'sample_count_high', label: '8+ completed sales' })
  } else if (params.sampleCount >= 3) {
    reasons.push({ code: 'sample_count_medium', label: '3–7 completed sales' })
  } else {
    reasons.push({ code: 'sample_count_low', label: '1–2 completed sales' })
  }

  if (params.recentSampleCount >= 3) {
    reasons.push({ code: 'recent_sales_good', label: '3+ sales in last 180 days' })
  } else if (params.recentSampleCount > 0) {
    reasons.push({ code: 'recent_sales_stale', label: 'Few recent sales' })
  } else {
    reasons.push({ code: 'recent_sales_none', label: 'No sales in last 180 days' })
  }

  const latestAgeDays = params.latestSaleAt
    ? (params.asOf.getTime() - params.latestSaleAt.getTime()) / (1000 * 60 * 60 * 24)
    : Infinity
  const isStale = latestAgeDays > 90
  if (!isStale) {
    reasons.push({ code: 'latest_sale_fresh', label: 'Latest sale within 90 days' })
  } else {
    reasons.push({ code: 'latest_sale_stale', label: 'Latest sale older than 90 days' })
  }

  const hasHighDispersion =
    params.iqrRange !== null &&
    params.estimatedValueCents !== null &&
    params.estimatedValueCents > 0 &&
    params.iqrRange / params.estimatedValueCents > 0.5
  if (hasHighDispersion) {
    reasons.push({ code: 'dispersion_high', label: 'High price dispersion' })
  }

  if (params.outliersRemoved) {
    reasons.push({ code: 'outliers_removed', label: 'Price outliers removed' })
  }

  if (params.extendedHistoryUsed) {
    reasons.push({ code: 'extended_history', label: 'Extended history (>24 months) used' })
  }

  // Classification: deterministic multi-factor
  let confidence: AdvancedConfidence

  const isExact = params.matchTier === 'exact'
  const isModelFamily = params.matchTier === 'model_family'

  if (
    isExact &&
    params.sampleCount >= 8 &&
    params.recentSampleCount >= 3 &&
    !isStale &&
    !hasHighDispersion &&
    !params.extendedHistoryUsed
  ) {
    confidence = 'high'
  } else if (
    (isExact && params.sampleCount >= 3) ||
    (isModelFamily && params.sampleCount >= 8 && params.recentSampleCount >= 3 && !isStale)
  ) {
    confidence = 'medium'
  } else if (params.sampleCount >= 1) {
    confidence = 'low'
  } else {
    confidence = 'insufficient'
  }

  return { confidence, reasons }
}

// ── Active ask context ────────────────────────────────────────────────────────

// Active asks are shown separately and never blended into realized estimatedValue.
export function computeActiveAskContext(pricesCents: number[]): ActiveAskContext {
  if (pricesCents.length === 0) {
    return { activeListingCount: 0, lowestActiveAsk: null, medianActiveAsk: null, highestActiveAsk: null }
  }
  const sorted = [...pricesCents].sort((a, b) => a - b)
  return {
    activeListingCount: sorted.length,
    lowestActiveAsk:    sorted[0],
    medianActiveAsk:    median(sorted),
    highestActiveAsk:   sorted[sorted.length - 1],
  }
}

// ── Liquidity ─────────────────────────────────────────────────────────────────

export function computeLiquidity(
  records: ComparableRecord[],
  activePurchasableListingCount: number,
  asOf: Date,
): LiquidityContext {
  const asOfMs = asOf.getTime()
  const validDays = records
    .map(r => r.daysToSell)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b)

  const recentCompletedSaleCount = records.filter(
    r => asOfMs - r.orderCompletedAt.getTime() <= MS_180D,
  ).length

  return {
    medianDaysToSell: validDays.length > 0 ? median(validDays) : null,
    p25DaysToSell: validDays.length > 0 ? percentile(validDays, 0.25) : null,
    p75DaysToSell: validDays.length > 0 ? percentile(validDays, 0.75) : null,
    durationSampleCount: validDays.length,
    recentCompletedSaleCount,
    activePurchasableListingCount,
  }
}

// ── Main builder ──────────────────────────────────────────────────────────────

// Builds an AdvancedValuation for one catalog model.
// allComparables: all eligible ComparableSale rows (deduplicated, prefiltered by caller).
// activeAskPricesCents: prices of active+available listings with price > 0.
// activePurchasableListingCount: count of those listings.
export function buildAdvancedValuation(
  target: TargetModel,
  allComparables: ComparableSale[],
  activeAskPricesCents: number[],
  activePurchasableListingCount: number,
  asOf: Date,
): AdvancedValuation {
  const base = computeEstimate(target, allComparables, asOf.getTime())

  const noSales: AdvancedValuation = {
    catalogModelId: target.id,
    asOf,
    matchTier: 'insufficient',
    sampleCount: 0,
    effectiveSampleCount: 0,
    estimatedValue: null,
    lowEstimate: null,
    highEstimate: null,
    confidence: 'insufficient',
    confidenceReasons: [{ code: 'sample_insufficient', label: 'No eligible completed sales' }],
    latestSaleAt: null,
    medianDaysToSell: null,
    recentTrend: { direction: 'unavailable', percentageChange: null, recentMedian: null, priorMedian: null },
    activeAskContext: computeActiveAskContext(activeAskPricesCents),
    liquidity: {
      medianDaysToSell: null,
      p25DaysToSell: null,
      p75DaysToSell: null,
      durationSampleCount: 0,
      recentCompletedSaleCount: 0,
      activePurchasableListingCount,
    },
    outliersRemoved: false,
    unweightedMedian: null,
    weightedMedian: null,
    extendedHistoryUsed: false,
    minCents: null,
    maxCents: null,
    oldestSaleAt: null,
  }

  if (base.matchLevel === 'insufficient' || base.comparables.length === 0) {
    return noSales
  }

  const records = base.comparables
  const asOfMs = asOf.getTime()

  // IQR filter on integer-cent prices
  const rawSorted = records.map(r => r.soldPriceCents).sort((a, b) => a - b)
  const { filtered: filteredSorted, removed: outliersRemoved } = applyIqrFilter(rawSorted)

  // Map filtered prices back to records (exact value match, preserving order)
  const filteredCounts: Record<number, number> = {}
  for (const v of filteredSorted) {
    filteredCounts[v] = (filteredCounts[v] ?? 0) + 1
  }
  // Rebuild filtered records (preserving original record objects)
  const remainCounts = { ...filteredCounts }
  const filteredRecords = records.filter(r => {
    const v = r.soldPriceCents
    if ((remainCounts[v] ?? 0) > 0) {
      remainCounts[v]--
      return true
    }
    return false
  })

  const effectiveSampleCount = filteredRecords.length
  const sampleCount = records.length

  // Unweighted median on filtered set
  const unweightedMedian = filteredSorted.length > 0 ? median(filteredSorted) : null

  // Count recent samples (within 180 days) from filtered set
  const recentSampleCount = filteredRecords.filter(
    r => asOfMs - r.orderCompletedAt.getTime() <= MS_180D,
  ).length

  // Weighted median — use when exact match and >=3 recent sales in filtered set
  const useWeighted =
    base.matchLevel === 'exact' && recentSampleCount >= WEIGHTED_MEDIAN_MIN_RECENT
  const wMedian =
    filteredRecords.length > 0 ? weightedMedianCents(filteredRecords, asOf) : null
  const weightedMedian = wMedian

  const estimatedValue = useWeighted && wMedian !== null ? wMedian : unweightedMedian
  const lowEstimate    = filteredSorted.length > 0 ? percentile(filteredSorted, 0.25) : null
  const highEstimate   = filteredSorted.length > 0 ? percentile(filteredSorted, 0.75) : null

  // Enforce low <= estimatedValue <= high
  let finalEstimate = estimatedValue
  if (finalEstimate !== null && lowEstimate !== null && highEstimate !== null) {
    finalEstimate = Math.max(lowEstimate, Math.min(highEstimate, finalEstimate))
  }

  const latestSaleAt = base.newestComparableDate

  const iqrRange =
    lowEstimate !== null && highEstimate !== null ? highEstimate - lowEstimate : null

  const { confidence, reasons } = deriveAdvancedConfidence({
    matchTier: base.matchLevel,
    sampleCount,
    recentSampleCount,
    latestSaleAt,
    asOf,
    iqrRange,
    estimatedValueCents: finalEstimate,
    outliersRemoved,
    extendedHistoryUsed: base.extendedHistoryUsed,
  })

  const recentTrend = computeTrend(records, asOf)
  const liquidity   = computeLiquidity(filteredRecords, activePurchasableListingCount, asOf)

  return {
    catalogModelId: target.id,
    asOf,
    matchTier: base.matchLevel,
    sampleCount,
    effectiveSampleCount,
    estimatedValue: finalEstimate,
    lowEstimate,
    highEstimate,
    confidence,
    confidenceReasons: reasons,
    latestSaleAt,
    medianDaysToSell: liquidity.medianDaysToSell,
    recentTrend,
    activeAskContext: computeActiveAskContext(activeAskPricesCents),
    liquidity,
    outliersRemoved,
    unweightedMedian,
    weightedMedian,
    extendedHistoryUsed: base.extendedHistoryUsed,
    minCents: filteredSorted.length > 0 ? filteredSorted[0] : null,
    maxCents: filteredSorted.length > 0 ? filteredSorted[filteredSorted.length - 1] : null,
    oldestSaleAt: base.oldestComparableDate,
  }
}
