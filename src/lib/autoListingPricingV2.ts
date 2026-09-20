// 31B: canonical Pricing Intelligence V2 — Automation Pricing Decision. Pure,
// deterministic, no DB access (see pricingContext.ts for that boundary).
// Consumes ONLY a canonical PricingContext — never the legacy 14C pricing
// stack. This is the hard policy/eligibility layer described in the 31A
// audit's required architecture:
//
//   Canonical Market Facts -> Pricing Context -> Automation Policy/Eligibility
//   -> Automation Pricing Decision
//
// V2 safety invariants are HARD-CODED, never policy-configurable (31A §56):
// different-CatalogModel evidence is structurally impossible (getValuation
// never crosses models); external asks never influence candidate price
// (PricingContext never composes them); exact requested specificity is
// required (no within-model fallback tolerated for automation, unlike a
// possible future admin display); the canonical safety floor is always at
// least Medium confidence, regardless of how policy is configured.
import { computeAutoListPriceCents } from '@/lib/autoListing'
import { RANGE_MIN_SAMPLE } from '@/lib/marketValuationMath'
import type { PricingContext } from '@/lib/pricingContext'

export type PricingDecisionReason =
  | 'eligible'
  | 'valuation_insufficient'
  | 'confidence_below_medium'
  | 'policy_requires_high_confidence'
  | 'specificity_fallback'
  | 'extended_history'
  | 'market_range_unavailable'
  | 'invalid_policy'
  | 'candidate_price_invalid'

export type AutoListingPricingDecision =
  | { eligible: true; candidatePriceCents: number; decisionReasons: PricingDecisionReason[]; pricingContext: PricingContext }
  | { eligible: false; candidatePriceCents: null; decisionReasons: PricingDecisionReason[]; pricingContext: PricingContext }

// 31A §18: AutoListingPolicyConfig.minimumPricingConfidence is read from the
// DB as a plain string (autoListingPolicyQuery.ts casts it, unchecked, to the
// narrower AutoListMinConfidence type) — treat it defensively as any of the
// legacy 4-value vocabulary, or invalid. Policy can only ever make automation
// STRICTER than the canonical Medium floor, never weaker: 'low'/'insufficient'
// (and any value that predates the current 'medium'|'high'-only UI
// validation) still requires at least Medium; only 'high' raises the bar
// further. An unrecognized value fails closed.
function mapPolicyToRequiredConfidence(policyMinimumConfidence: string): 'medium' | 'high' | null {
  if (policyMinimumConfidence === 'high') return 'high'
  if (policyMinimumConfidence === 'medium' || policyMinimumConfidence === 'low' || policyMinimumConfidence === 'insufficient') {
    return 'medium'
  }
  return null
}

function ineligible(reason: PricingDecisionReason, context: PricingContext): AutoListingPricingDecision {
  return { eligible: false, candidatePriceCents: null, decisionReasons: [reason], pricingContext: context }
}

export function evaluateAutoListingPricingV2(
  context: PricingContext,
  policy: { pricePositionBps: number; minimumPricingConfidence: string },
): AutoListingPricingDecision {
  const { valuation } = context

  // §57 (=31B §14/§16): valued + exact requested specificity — the ONLY
  // fallback-tolerant path in this codebase is a possible future admin
  // display; automation never accepts a within-model broadened tier, and
  // cross-model evidence is structurally impossible from getValuation itself.
  if (valuation.status !== 'valued') return ineligible('valuation_insufficient', context)
  if (valuation.specificity !== valuation.primarySpecificity) return ineligible('specificity_fallback', context)

  // §19: all-time extended history is never a clean "current market" read for
  // an automated decision.
  if (valuation.extendedHistoryUsed) return ineligible('extended_history', context)

  // §17/§18: canonical floor is always Medium; policy can only raise it.
  if (valuation.confidence === 'low') return ineligible('confidence_below_medium', context)
  const requiredConfidence = mapPolicyToRequiredConfidence(policy.minimumPricingConfidence)
  if (requiredConfidence === null) return ineligible('invalid_policy', context)
  if (requiredConfidence === 'high' && valuation.confidence !== 'high') {
    return ineligible('policy_requires_high_confidence', context)
  }

  // Follow-up hotfix: pricePositionBps must be explicitly validated BEFORE
  // interpolation — never rely on computeAutoListPriceCents's own defensive
  // clamp to silently absorb corrupt policy data. That clamp exists only to
  // bound its internal arithmetic once input is already known valid; it is
  // not a substitute for this gate.
  if (!Number.isInteger(policy.pricePositionBps) || policy.pricePositionBps < 0 || policy.pricePositionBps > 10_000) {
    return ineligible('invalid_policy', context)
  }

  // §20/§21: candidate price requires a real canonical Market Range — never
  // substituted with EMV alone, Lowest Ask, or any ask evidence. Follow-up
  // hotfix: a present range must also be internally consistent — canonical
  // computeMarketRange (marketValuationMath.ts) only ever returns a non-null
  // range when usedSampleCount >= RANGE_MIN_SAMPLE, so a range present
  // alongside a lower sample count indicates a malformed PricingContext, not
  // real canonical evidence — never trusted, regardless of caller.
  if (
    valuation.marketRangeLowCents === null ||
    valuation.marketRangeHighCents === null ||
    valuation.usedSampleCount < RANGE_MIN_SAMPLE
  ) {
    return ineligible('market_range_unavailable', context)
  }

  // §22: reuse the existing bounded integer-cent interpolation verbatim — no
  // second formula.
  const priceResult = computeAutoListPriceCents(valuation.marketRangeLowCents, valuation.marketRangeHighCents, policy.pricePositionBps)
  if (!priceResult.ok) return ineligible('candidate_price_invalid', context)

  return { eligible: true, candidatePriceCents: priceResult.priceCents, decisionReasons: ['eligible'], pricingContext: context }
}
