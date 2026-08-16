// 15K: pure auto-listing decision logic. No DB access (see autoListingExecution.ts
// for that boundary), no randomness. Consumes 15J's ReadyToListOutcome and 14C's
// pricing output as authoritative inputs — never reimplements readiness or pricing.
//
// This module answers "given a 15J-ready candidate, is it ALSO eligible for fully
// automatic listing under the current auto-listing policy, and if so, at what exact
// price?" It is deliberately STRICTER than 15J: 15J's `ready` already excludes hard
// blockers, but ask-only / low-confidence pricing can still be `ready` under 15J
// (pricing readiness is advisory there, never a blocker — see readyToList.ts). 15K
// treats those exact same conditions as automatic-listing-ineligible (Part C).

import { CONFIDENCE_ORDER, type Confidence } from '@/lib/resaleEstimator'
import type { AutoListingPolicySnapshot } from '@/lib/autoListingPolicy'

// Reasons a `ready` candidate is NOT automatically listable — decided purely from
// policy + pricing + catalog fields, before any 15F/DB involvement. The execution
// boundary (autoListingExecution.ts) adds its own DB/risk-derived reason codes
// (readiness_changed, risk_approval_required, risk_denied, already_listed,
// concurrent_state_change, execution_failed) — those cannot be decided here.
export type AutoListIneligibleReasonCode =
  | 'policy_disabled'
  | 'reactivation_requires_manual_review'
  | 'pricing_ask_only'
  | 'pricing_evidence_missing'
  | 'pricing_confidence_below_policy'
  | 'pricing_range_invalid'
  | 'required_listing_field_missing'

export type AutoListPricingInput = {
  isAskOnly: boolean
  confidenceLevel: Confidence
  recommendedLowCents: number | null
  recommendedHighCents: number | null
} | null // null = 14C produced no result at all for this catalog model

export type AutoListCatalogInput = { brand: string; name: string; year: number | null }

export type AutoListCandidateInput = {
  policy: AutoListingPolicySnapshot
  listingPath: 'create' | 'reactivate'
  pricing: AutoListPricingInput
  catalog: AutoListCatalogInput
}

export type AutoListCandidateResult =
  | { eligible: true; proposedPriceCents: number; title: string }
  | { eligible: false; reasonCode: AutoListIneligibleReasonCode }

// ── Deterministic price (Part D) ──────────────────────────────────────────────────
//
// price = low + roundHalfUp(range * pricePositionBps / 10000), integer-cents-exact
// via BigInt (no JS float financial math), then defensively clamped to [low, high].
export type AutoListPriceResult = { ok: true; priceCents: number } | { ok: false }

export function computeAutoListPriceCents(
  lowCents: number | null,
  highCents: number | null,
  pricePositionBps: number,
): AutoListPriceResult {
  if (lowCents == null || highCents == null) return { ok: false }
  if (!Number.isInteger(lowCents) || !Number.isInteger(highCents)) return { ok: false }
  if (lowCents <= 0 || highCents < lowCents) return { ok: false }

  const range = BigInt(highCents - lowCents)
  const bps = BigInt(pricePositionBps)
  const numerator = range * bps
  const quotient = numerator / 10_000n
  const remainder = numerator % 10_000n
  const offset = remainder * 2n >= 10_000n ? quotient + 1n : quotient // round-half-up, single step

  const priceCents = lowCents + Number(offset)
  // Unconditional defensive clamp (Part D section 10) — the arithmetic above cannot
  // exceed [low, high] for any pricePositionBps already validated to [0, 10000], but
  // the clamp never depends on that being true.
  return { ok: true, priceCents: Math.min(highCents, Math.max(lowCents, priceCents)) }
}

// ── Deterministic title (Part E) ──────────────────────────────────────────────────
//
// Authoritative CatalogModel fields only — brand/name/year, exactly as stored. No
// LLM copy, no condition claims, no invented emphasis. brand/name are NOT NULL
// columns (schema-enforced) so the null-guard below is defensive, not expected to
// ever fire in practice — same "don't assume, still check" posture as 15J's own
// documented structurally-impossible cases.
export function deriveListingTitle(catalog: AutoListCatalogInput): string | null {
  const brand = catalog.brand?.trim()
  const name = catalog.name?.trim()
  if (!brand || !name) return null
  return catalog.year ? `${catalog.year} ${brand} ${name}` : `${brand} ${name}`
}

// ── Candidate eligibility (Part C) ────────────────────────────────────────────────
export function evaluateAutoListCandidate(input: AutoListCandidateInput): AutoListCandidateResult {
  if (!input.policy.enabled) return { eligible: false, reasonCode: 'policy_disabled' }

  // Part F: first-version scope is listingPath 'create' only — 'reactivate' always
  // goes to manual review regardless of how strong the pricing evidence is.
  if (input.listingPath !== 'create') return { eligible: false, reasonCode: 'reactivation_requires_manual_review' }

  const p = input.pricing
  // Part C/7: explicit ask-only check, even though 14C's own deriveConfidence
  // already reports isAskOnly as confidenceLevel='insufficient' (so this is also
  // caught below) — checked first and separately so ask-only is never auto-listable
  // for any reason OTHER than a coincidental confidence-level correlation.
  if (p?.isAskOnly) return { eligible: false, reasonCode: 'pricing_ask_only' }
  if (!p || p.confidenceLevel === 'insufficient') return { eligible: false, reasonCode: 'pricing_evidence_missing' }
  if (CONFIDENCE_ORDER.indexOf(p.confidenceLevel) < CONFIDENCE_ORDER.indexOf(input.policy.minimumPricingConfidence)) {
    return { eligible: false, reasonCode: 'pricing_confidence_below_policy' }
  }

  const priceResult = computeAutoListPriceCents(p.recommendedLowCents, p.recommendedHighCents, input.policy.pricePositionBps)
  if (!priceResult.ok) return { eligible: false, reasonCode: 'pricing_range_invalid' }

  const title = deriveListingTitle(input.catalog)
  if (!title) return { eligible: false, reasonCode: 'required_listing_field_missing' }

  return { eligible: true, proposedPriceCents: priceResult.priceCents, title }
}
