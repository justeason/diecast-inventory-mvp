// 15K: versioned, effective-dated Auto-Listing policy config. Same pattern as 15F's
// RiskPolicyConfig (riskPolicy.ts) — a narrow, typed config, never a generic rule
// builder. This module owns NO persistence (see autoListingPolicyQuery.ts) and NO
// side effects. Pure validation only.

// 15K Part C section 6: only 'medium'/'high' are real 14C confidence levels safe
// enough to auto-list from. 'low'/'insufficient' are structurally excluded from this
// type — there is no way to construct a policy that allows them.
export const AUTO_LIST_MIN_CONFIDENCE_LEVELS = ['medium', 'high'] as const
export type AutoListMinConfidence = (typeof AUTO_LIST_MIN_CONFIDENCE_LEVELS)[number]

export function isValidAutoListMinConfidence(v: string): v is AutoListMinConfidence {
  return (AUTO_LIST_MIN_CONFIDENCE_LEVELS as readonly string[]).includes(v)
}

export function isValidPricePositionBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= 10_000
}

export type AutoListingPolicySnapshot = {
  version: number
  effectiveFrom: Date
  enabled: boolean
  minimumPricingConfidence: AutoListMinConfidence
  pricePositionBps: number
}
