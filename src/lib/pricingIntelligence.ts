// 14C: Pricing & Valuation Intelligence — blends the existing first-party engine
// (advancedValuation.ts, 12G-A) with existing external market research
// (externalMarketResearch.ts, 12G-B) into one authoritative recommendation. Pure
// functions only; no DB access (see pricingIntelligenceQuery.ts for that boundary).
// No black-box model — every number here traces to a documented deterministic rule.
//
// ── Evidence windows (all reused from their existing authoritative source, not
//    reimplemented here) ─────────────────────────────────────────────────────────
//   First-party sold   : 24-month primary, all-time extended fallback if <3 recent
//                         comps (resaleEstimator.ts: TWO_YEARS_MS, MIN_WINDOW_COMPS).
//   External sold       : 12-month primary, 24-month extended fallback if <3 recent
//                         comps (externalMarketResearch.ts: MIN_SOLD_PRIMARY_SAMPLE).
//   External active ask : 30-day freshness window (externalMarketResearch.ts:
//                         ASK_WINDOW_DAYS). Stale asks are excluded upstream.
//   First-party active  : current status='active' Listings — a live snapshot, not a
//   ask (market position)  time-windowed evidence set (advancedValuationQuery.ts).
// All evidence for one result shares exactly one `asOf`, supplied by the caller.

import type { Confidence, MatchLevel } from '@/lib/resaleEstimator'
import { CONFIDENCE_ORDER, downgradeConfidence } from '@/lib/resaleEstimator'
import type { AdvancedValuation } from '@/lib/advancedValuation'
import type { ExternalMarketSummary } from '@/lib/externalMarketResearch'

export type EvidenceSummary = {
  count: number
  medianCents: number | null
  p25Cents: number | null
  p75Cents: number | null
  minCents: number | null
  maxCents: number | null
  freshestAt: string | null
  oldestAt: string | null
  windowLabel: string
  outliers: { rawCount: number; includedCount: number; excludedCount: number } | null
}

export type MarketPosition = {
  collectNTrades: { activeListingCount: number; lowestAskCents: number | null; medianAskCents: number | null; highestAskCents: number | null }
  external: { activeAskCount: number; lowestAskCents: number | null; medianAskCents: number | null; highestAskCents: number | null }
}

export type ListingPositionClass = 'below_guidance' | 'within_guidance' | 'above_guidance' | 'unavailable'

export type PricingIntelligenceResult = {
  catalogModelId: string
  asOf: string

  estimatedValueCents: number | null
  isAskOnly: boolean // true when recommendedListing is derived from active asks, not sold evidence

  recommendedListing: {
    lowCents: number | null
    targetCents: number | null
    highCents: number | null
  }

  confidence: {
    level: Confidence
    score: number | null // 0-100, deterministic function of level + sample size (see below)
    reasons: string[]
  }

  evidence: {
    firstPartySold: EvidenceSummary
    externalSold: EvidenceSummary
    activeAsks: EvidenceSummary // external active asks only — market context, not first-party position
  }

  marketPosition: MarketPosition
  marketPositionClass: 'below_market' | 'near_market' | 'above_market' | 'unavailable'

  matchLevel: MatchLevel
  warnings: string[]
  explanation: string
}

// ── Tolerance / rounding constants (centralized, tested) ─────────────────────────

// "Within guidance" / "near market" band — a listing/price within this fraction of
// the target is not materially mispriced. Applied to both section 16 and 17.
export const GUIDANCE_TOLERANCE_PCT = 0.05
// Agreement threshold between first-party and external sold medians for a "reasons"
// callout and for the blend not to be flagged as disagreeing.
export const MEDIAN_AGREEMENT_PCT = 0.15
// Minimum sold sample size (either source) before a range is considered non-thin.
const THIN_SAMPLE = 3

// ── Source weighting (saturating, documented) ─────────────────────────────────────
//
// weight(source) = sourcePriority(source) × min(sampleSize(source), SAMPLE_WEIGHT_CAP)
//
// Sample count beyond the cap still improves confidence (more evidence is still
// worth more trust) but stops buying additional blend LEVERAGE — a 100-observation
// external import cannot mathematically drown out 4 strong recent first-party sales
// just by sheer count. First-party keeps a fixed 2x per-effective-comp priority over
// external, reflecting the Tier1 > Tier2 evidence hierarchy, but that priority now
// only ever multiplies a capped sample count on both sides.
export const SAMPLE_WEIGHT_CAP = 10
export const FIRST_PARTY_SOURCE_PRIORITY = 2
export const EXTERNAL_SOURCE_PRIORITY = 1

function sourceWeight(sampleSize: number, priority: number): number {
  return Math.min(sampleSize, SAMPLE_WEIGHT_CAP) * priority
}

function pctDiff(a: number, b: number): number {
  // Deterministic one-shot decimal math (not accumulated) — same rounding pattern as
  // advancedValuation.ts's computeTrend: round to 2 decimal places of a percentage.
  if (b === 0) return 0
  return Math.round(((a - b) / b) * 10000) / 100
}

function round2(cents: number): number {
  return Math.round(cents)
}

// ── Evidence summary builders (reuse existing engines' own aggregates only) ──────

export function firstPartyEvidenceSummary(v: AdvancedValuation): EvidenceSummary {
  return {
    count: v.sampleCount,
    medianCents: v.unweightedMedian,
    p25Cents: v.lowEstimate,
    p75Cents: v.highEstimate,
    minCents: v.minCents,
    maxCents: v.maxCents,
    freshestAt: v.latestSaleAt ? v.latestSaleAt.toISOString() : null,
    oldestAt: v.oldestSaleAt ? v.oldestSaleAt.toISOString() : null,
    windowLabel: v.extendedHistoryUsed ? 'all-time (extended — fewer than 3 recent comps)' : 'last 24 months',
    outliers: v.sampleCount > 0
      ? { rawCount: v.sampleCount, includedCount: v.effectiveSampleCount, excludedCount: v.sampleCount - v.effectiveSampleCount }
      : null,
  }
}

export function externalSoldEvidenceSummary(s: ExternalMarketSummary): EvidenceSummary {
  const sold = s.soldSummary
  if (!sold) {
    return {
      count: 0, medianCents: null, p25Cents: null, p75Cents: null, minCents: null, maxCents: null,
      freshestAt: null, oldestAt: null, windowLabel: 'last 12 months', outliers: null,
    }
  }
  return {
    count: sold.sampleSize,
    medianCents: sold.medianCents,
    p25Cents: sold.p25Cents,
    p75Cents: sold.p75Cents,
    minCents: sold.minCents,
    maxCents: sold.maxCents,
    freshestAt: sold.freshestSoldAt.toISOString(),
    oldestAt: sold.stalestSoldAt.toISOString(),
    windowLabel: sold.extendedHistoryUsed ? 'last 24 months (extended — fewer than 3 in last 12)' : 'last 12 months',
    outliers: null, // external sold has no IQR pass — see warnings when dispersion is high
  }
}

export function externalActiveAskEvidenceSummary(s: ExternalMarketSummary): EvidenceSummary {
  const ask = s.askSummary
  if (!ask) {
    return {
      count: s.activeAskCount, medianCents: null, p25Cents: null, p75Cents: null,
      minCents: s.lowestActiveAskCents, maxCents: null,
      freshestAt: s.latestAskObservedAt ? s.latestAskObservedAt.toISOString() : null,
      oldestAt: null, windowLabel: 'last 30 days', outliers: null,
    }
  }
  return {
    count: ask.count,
    medianCents: ask.medianCents,
    p25Cents: null,
    p75Cents: ask.p75Cents,
    minCents: s.lowestActiveAskCents,
    maxCents: ask.highestActiveAskCents,
    freshestAt: s.latestAskObservedAt ? s.latestAskObservedAt.toISOString() : null,
    oldestAt: null,
    windowLabel: 'last 30 days',
    outliers: null,
  }
}

// ── Blended estimate ──────────────────────────────────────────────────────────────
//
// Tier 1 (first-party recent sold) and Tier 2 (external sold) are blended by a
// sample-size-weighted average, with first-party weighted 2x per comparable sale to
// reflect its priority (Tier 1 > Tier 2). Tier 3 (older evidence) is already folded
// into Tier 1/2 via each engine's own extended-window fallback. Tier 4 (active asks)
// never contributes to estimatedValueCents — only to recommendedListing when no sold
// evidence exists at all (isAskOnly=true), and always with a warning.
function blendSoldMedian(fp: AdvancedValuation, ext: ExternalMarketSummary): number | null {
  const fpWeight = fp.estimatedValue !== null ? sourceWeight(fp.effectiveSampleCount, FIRST_PARTY_SOURCE_PRIORITY) : 0
  const extWeight = ext.soldSummary !== null ? sourceWeight(ext.soldSummary.sampleSize, EXTERNAL_SOURCE_PRIORITY) : 0
  if (fpWeight === 0 && extWeight === 0) return null
  if (extWeight === 0) return fp.estimatedValue
  if (fpWeight === 0) return ext.soldSummary!.medianCents
  return round2((fp.estimatedValue! * fpWeight + ext.soldSummary!.medianCents * extWeight) / (fpWeight + extWeight))
}

function blendedLowHigh(fp: AdvancedValuation, ext: ExternalMarketSummary): { low: number | null; high: number | null } {
  const fpWeight = fp.lowEstimate !== null && fp.highEstimate !== null ? sourceWeight(fp.effectiveSampleCount, FIRST_PARTY_SOURCE_PRIORITY) : 0
  const extWeight = ext.soldSummary !== null ? sourceWeight(ext.soldSummary.sampleSize, EXTERNAL_SOURCE_PRIORITY) : 0
  if (fpWeight === 0 && extWeight === 0) return { low: null, high: null }
  if (extWeight === 0) return { low: fp.lowEstimate, high: fp.highEstimate }
  if (fpWeight === 0) return { low: ext.soldSummary!.p25Cents, high: ext.soldSummary!.p75Cents }
  const low = round2((fp.lowEstimate! * fpWeight + ext.soldSummary!.p25Cents * extWeight) / (fpWeight + extWeight))
  const high = round2((fp.highEstimate! * fpWeight + ext.soldSummary!.p75Cents * extWeight) / (fpWeight + extWeight))
  return { low, high }
}

// ── Confidence ─────────────────────────────────────────────────────────────────────
//
// Confidence is a RAW level (first-party base, adjusted by cross-source agreement)
// clamped DOWN by explicit, documented ceilings. Ceilings only ever lower the level —
// they can never be the reason a result reaches 'high'. This guarantees a tiny
// sample cannot reach 'high' merely because two weak estimates happen to agree: two
// single-sale sources agreeing exactly still cannot pass the sample-depth ceiling.

// totalSoldSample below this → confidence cannot exceed 'low', regardless of agreement.
const SAMPLE_CEILING_LOW = 3
// totalSoldSample below this (but >= SAMPLE_CEILING_LOW) → cannot exceed 'medium'.
const SAMPLE_CEILING_MEDIUM = 6
// (blendedHigh - blendedLow) / target ratio above this counts as "high dispersion" —
// caps confidence at 'medium' even if sources agree.
const HIGH_DISPERSION_RATIO = 0.5
// Share of first-party raw samples removed as IQR outliers above this caps at 'medium'.
const HIGH_OUTLIER_EXCLUSION_RATIO = 0.3

function levelMin(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER.indexOf(a) <= CONFIDENCE_ORDER.indexOf(b) ? a : b
}

function deriveConfidence(params: {
  fp: AdvancedValuation
  ext: ExternalMarketSummary
  totalSoldSample: number
  blendedMedian: number | null
  dispersionRatio: number | null
  isAskOnly: boolean
}): { level: Confidence; reasons: string[] } {
  const { fp, ext, totalSoldSample, blendedMedian, dispersionRatio, isAskOnly } = params
  const reasons: string[] = []

  if (totalSoldSample === 0 || isAskOnly || blendedMedian === null) {
    return {
      level: 'insufficient',
      reasons: isAskOnly
        ? ['No completed sales evidence — only active market asks available (ask-only context).']
        : ['No completed first-party or external sales found for this model.'],
    }
  }

  // Start from the first-party engine's own confidence (already accounts for match
  // tier, sample size, recency, dispersion, outliers, extended-history use).
  let level: Confidence = fp.confidence
  reasons.push(...fp.confidenceReasons.map(r => r.label))

  const hasExternal = ext.soldSummary !== null
  if (hasExternal) {
    reasons.push(`${ext.soldSummary!.sampleSize} external sold observation(s) (${ext.soldSummary!.windowMonths}mo window)`)
  }

  // Agreement between first-party and external medians.
  if (fp.estimatedValue !== null && hasExternal) {
    const diff = Math.abs(pctDiff(ext.soldSummary!.medianCents, fp.estimatedValue))
    if (diff <= MEDIAN_AGREEMENT_PCT * 100) {
      reasons.push(`First-party and external medians agree within ${diff.toFixed(1)}%`)
      // Two independently-agreeing sources may upgrade confidence by one level — but
      // only within the sample-depth/dispersion/staleness ceilings applied below.
      const idx = CONFIDENCE_ORDER.indexOf(level)
      level = CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.length - 1, idx + 1)]
    } else {
      reasons.push(`First-party and external medians diverge by ${diff.toFixed(1)}%`)
      level = downgradeConfidence(level, 1)
    }
  } else if (fp.estimatedValue === null && hasExternal) {
    // External-only anchor — no independently-agreeing source, cannot exceed medium.
    level = levelMin(level, 'medium')
  }

  if (totalSoldSample < THIN_SAMPLE) {
    reasons.push(`Only ${totalSoldSample} completed sale(s) across all sources`)
  }

  // ── Explicit ceilings (can only lower `level`, never raise it) ──────────────────
  if (totalSoldSample < SAMPLE_CEILING_LOW) {
    reasons.push(`Fewer than ${SAMPLE_CEILING_LOW} completed sales — confidence capped at low`)
    level = levelMin(level, 'low')
  } else if (totalSoldSample < SAMPLE_CEILING_MEDIUM) {
    reasons.push(`Fewer than ${SAMPLE_CEILING_MEDIUM} completed sales — confidence capped at medium`)
    level = levelMin(level, 'medium')
  }

  if (dispersionRatio !== null && dispersionRatio > HIGH_DISPERSION_RATIO) {
    reasons.push('High price dispersion across combined evidence — confidence capped at medium')
    level = levelMin(level, 'medium')
  }

  if (ext.researchFreshness === 'stale') {
    reasons.push('External research data is stale (no observation in 30+ days) — confidence capped at medium')
    level = levelMin(level, 'medium')
  }

  if (fp.sampleCount > 0) {
    const outlierExclusionRatio = (fp.sampleCount - fp.effectiveSampleCount) / fp.sampleCount
    if (outlierExclusionRatio > HIGH_OUTLIER_EXCLUSION_RATIO) {
      reasons.push('A large share of first-party sales were excluded as price outliers — confidence capped at medium')
      level = levelMin(level, 'medium')
    }
  }

  // A valuation that materially relies on sales older than the primary window (24mo
  // first-party / 12mo external) is not "recent evidence" — cross-source agreement
  // cannot promote it past medium just because two dated estimates happen to agree.
  if (fp.extendedHistoryUsed || ext.soldSummary?.extendedHistoryUsed) {
    reasons.push('Relies on extended/older evidence outside the primary window — confidence capped at medium')
    level = levelMin(level, 'medium')
  }

  return { level, reasons }
}

// Deterministic 0-100 score, purely a function of level + sample depth — for sorting
// admin opportunity views, not a substitute for the human-readable level/reasons.
function confidenceScore(level: Confidence, totalSoldSample: number): number | null {
  if (level === 'insufficient') return null
  const base = { low: 25, medium: 55, high: 80 }[level]
  const sampleBonus = Math.min(15, totalSoldSample)
  return Math.min(99, base + sampleBonus)
}

// ── Market position ───────────────────────────────────────────────────────────────

function classifyAgainstReference(targetCents: number | null, referenceCents: number | null): 'below_market' | 'near_market' | 'above_market' | 'unavailable' {
  if (targetCents === null || referenceCents === null || referenceCents === 0) return 'unavailable'
  const diff = pctDiff(targetCents, referenceCents) / 100
  if (diff < -GUIDANCE_TOLERANCE_PCT) return 'below_market'
  if (diff > GUIDANCE_TOLERANCE_PCT) return 'above_market'
  return 'near_market'
}

export function classifyListingPosition(listingPriceCents: number, targetCents: number | null): ListingPositionClass {
  if (targetCents === null || targetCents <= 0) return 'unavailable'
  const diff = pctDiff(listingPriceCents, targetCents) / 100
  if (diff < -GUIDANCE_TOLERANCE_PCT) return 'below_guidance'
  if (diff > GUIDANCE_TOLERANCE_PCT) return 'above_guidance'
  return 'within_guidance'
}

export type ListingPriceComparison = {
  listingPriceCents: number
  targetCents: number | null
  absoluteDiffCents: number | null
  percentDiff: number | null
  classification: ListingPositionClass
}

export function compareListingToGuidance(listingPriceCents: number, targetCents: number | null): ListingPriceComparison {
  if (targetCents === null) {
    return { listingPriceCents, targetCents: null, absoluteDiffCents: null, percentDiff: null, classification: 'unavailable' }
  }
  return {
    listingPriceCents,
    targetCents,
    absoluteDiffCents: listingPriceCents - targetCents,
    percentDiff: pctDiff(listingPriceCents, targetCents),
    classification: classifyListingPosition(listingPriceCents, targetCents),
  }
}

// ── Explanation (deterministic facts only, no LLM) ────────────────────────────────

function usd(cents: number | null): string {
  return cents === null ? 'n/a' : `$${(cents / 100).toFixed(2)}`
}

function buildExplanation(params: {
  fpCount: number
  extCount: number
  blendedMedian: number | null
  fpMedian: number | null
  extMedian: number | null
  confidenceLevel: Confidence
  isAskOnly: boolean
  askCount: number
  extendedHistoryUsed: boolean
}): string {
  const { fpCount, extCount, blendedMedian, fpMedian, extMedian, confidenceLevel, isAskOnly, askCount, extendedHistoryUsed } = params

  if (isAskOnly) {
    return askCount > 0
      ? `No completed sales found. Guidance is based on ${askCount} current active market ask(s) only — ask-only context, not a sale-based valuation.`
      : 'No completed sales or active market asks found for this model. Insufficient evidence to produce guidance.'
  }

  if (blendedMedian === null) {
    return 'No completed sales (first-party or external) found for this model. Insufficient evidence to produce a valuation.'
  }

  const parts: string[] = []
  if (fpCount > 0) parts.push(`${fpCount} completed first-party sale${fpCount === 1 ? '' : 's'}`)
  if (extCount > 0) parts.push(`${extCount} external sold observation${extCount === 1 ? '' : 's'}`)
  const sourceSentence = parts.length > 0 ? `Target is based on ${parts.join(' and ')}.` : ''

  const medianSentence = fpMedian !== null && extMedian !== null
    ? ` The first-party median is ${usd(fpMedian)} and external median is ${usd(extMedian)}.`
    : ''

  // Extended-history evidence is materially older than the primary window — never
  // described as recent, always called out explicitly rather than left implicit.
  const extendedSentence = extendedHistoryUsed
    ? ' This relies in part on extended/older evidence outside the primary recent window, not recent sales alone.'
    : ''

  const confidenceSentence = ` This results in ${confidenceLevel} confidence.`

  return `${sourceSentence}${medianSentence}${extendedSentence}${confidenceSentence}`.trim()
}

// ── Main builder ───────────────────────────────────────────────────────────────────

export function buildPricingIntelligence(
  catalogModelId: string,
  matchLevel: MatchLevel,
  fp: AdvancedValuation,
  ext: ExternalMarketSummary,
  collectNTradesActiveAsk: { activeListingCount: number; lowestAskCents: number | null; medianAskCents: number | null; highestAskCents: number | null },
  asOf: Date,
): PricingIntelligenceResult {
  const warnings: string[] = []

  const totalSoldSample = fp.effectiveSampleCount + (ext.soldSummary?.sampleSize ?? 0)
  const hasAnySold = totalSoldSample > 0
  const hasAnyAsk = collectNTradesActiveAsk.activeListingCount > 0 || (ext.askSummary?.count ?? 0) > 0

  const isAskOnly = !hasAnySold && hasAnyAsk

  const blendedMedian = hasAnySold ? blendSoldMedian(fp, ext) : null
  const { low: blendedLow, high: blendedHigh } = hasAnySold ? blendedLowHigh(fp, ext) : { low: null, high: null }

  let lowCents: number | null = null
  let targetCents: number | null = null
  let highCents: number | null = null

  if (blendedMedian !== null) {
    targetCents = blendedMedian
    lowCents = blendedLow
    highCents = blendedHigh
    // Enforce low <= target <= high (deterministic clamp, same pattern as advancedValuation.ts).
    if (lowCents !== null && highCents !== null) {
      if (lowCents > highCents) { const tmp = lowCents; lowCents = highCents; highCents = tmp } // defensive: guarantee low <= high before clamping target
      targetCents = Math.max(lowCents, Math.min(highCents, targetCents))
    } else {
      // No p25/p75 available on the dominant source — derive a modest symmetric band.
      lowCents = Math.round(targetCents * 0.9)
      highCents = Math.round(targetCents * 1.1)
    }
  } else if (isAskOnly) {
    const askMedian = ext.askSummary?.medianCents ?? collectNTradesActiveAsk.medianAskCents
    const askLow = collectNTradesActiveAsk.lowestAskCents ?? ext.lowestActiveAskCents
    const askHigh = ext.askSummary?.highestActiveAskCents ?? collectNTradesActiveAsk.highestAskCents
    if (askMedian !== null && askMedian > 0) {
      targetCents = askMedian
      lowCents = askLow !== null ? Math.min(askLow, targetCents) : Math.round(targetCents * 0.9)
      highCents = askHigh !== null ? Math.max(askHigh, targetCents) : Math.round(targetCents * 1.1)
      warnings.push('Recommended range is based on active market asks only — no completed sales evidence exists yet.')
    }
  }

  if (targetCents !== null && targetCents <= 0) {
    // Never recommend a non-positive price — treat as no recommendation.
    lowCents = null; targetCents = null; highCents = null
  }

  // Dispersion of the SOLD-evidence range only — never computed from the ask-only
  // range, since ask spread reflects market variance, not sold-price uncertainty.
  const dispersionRatio = !isAskOnly && lowCents !== null && highCents !== null && targetCents !== null && targetCents > 0
    ? (highCents - lowCents) / targetCents
    : null

  const { level, reasons } = deriveConfidence({ fp, ext, totalSoldSample, blendedMedian, dispersionRatio, isAskOnly })
  const score = confidenceScore(level, totalSoldSample)

  if (fp.extendedHistoryUsed) warnings.push('First-party estimate used extended (all-time) history — fewer than 3 sales in the last 24 months.')
  if (ext.soldSummary?.extendedHistoryUsed) warnings.push('External sold evidence used extended (24-month) history — fewer than 3 sales in the last 12 months.')
  if (fp.outliersRemoved) warnings.push(`${fp.sampleCount - fp.effectiveSampleCount} first-party price outlier(s) excluded (IQR filter).`)
  if (matchLevel !== 'exact' && matchLevel !== 'insufficient') warnings.push(`No exact-model first-party comparables — using ${matchLevel} matches.`)
  if (ext.researchFreshness === 'stale') warnings.push('External market research has no observation in the last 30 days.')

  const referenceAsk = collectNTradesActiveAsk.medianAskCents ?? ext.askSummary?.medianCents ?? null
  const marketPositionClass = classifyAgainstReference(targetCents, referenceAsk)

  const explanation = buildExplanation({
    fpCount: fp.effectiveSampleCount,
    extCount: ext.soldSummary?.sampleSize ?? 0,
    blendedMedian,
    fpMedian: fp.unweightedMedian,
    extMedian: ext.soldSummary?.medianCents ?? null,
    confidenceLevel: level,
    isAskOnly,
    askCount: collectNTradesActiveAsk.activeListingCount + (ext.askSummary?.count ?? 0),
    extendedHistoryUsed: fp.extendedHistoryUsed || (ext.soldSummary?.extendedHistoryUsed ?? false),
  })

  return {
    catalogModelId,
    asOf: asOf.toISOString(),
    estimatedValueCents: hasAnySold ? blendedMedian : null,
    isAskOnly,
    recommendedListing: { lowCents, targetCents, highCents },
    confidence: { level, score, reasons },
    evidence: {
      firstPartySold: firstPartyEvidenceSummary(fp),
      externalSold: externalSoldEvidenceSummary(ext),
      activeAsks: externalActiveAskEvidenceSummary(ext),
    },
    marketPosition: {
      collectNTrades: collectNTradesActiveAsk,
      external: {
        activeAskCount: ext.askSummary?.count ?? ext.activeAskCount,
        lowestAskCents: ext.lowestActiveAskCents,
        medianAskCents: ext.askSummary?.medianCents ?? null,
        highestAskCents: ext.askSummary?.highestActiveAskCents ?? null,
      },
    },
    marketPositionClass,
    matchLevel,
    warnings,
    explanation,
  }
}
