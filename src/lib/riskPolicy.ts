// 15F: central, pure, deterministic risk policy engine. No randomness, no LLM, no
// external API — same (action, context, policy version, asOf) always returns the
// same RiskDecision. This module owns NO persistence and NO side effects; see
// riskPolicyQuery.ts (reads) and actions/riskApprovals.ts (approval lifecycle) for
// the DB boundary. All money/percentage math is integer cents/bps, never floats.
import crypto from 'crypto'

// ── Action taxonomy — only actions that correspond to real, existing workflows
// (confirmed by code inspection; see 15F final report for what was intentionally
// left out and why). ─────────────────────────────────────────────────────────────
export const RISK_ACTIONS = [
  'agreement_commission_override',
  'seller_commission_override',
  'listing_activation',
  'listing_price_change',
  'seller_payout_mark_paid',
  'item_catalog_reassignment',
  // 15F-review (catalog-merge pass): ONE administrative action covering a whole
  // duplicate-CatalogModel merge (reassigns every dependent record + deletes the
  // duplicate row) — never routed through item_catalog_reassignment once per
  // affected ItemInstance.
  'catalog_model_merge',
] as const
export type RiskAction = (typeof RISK_ACTIONS)[number]

export function isKnownRiskAction(action: string): action is RiskAction {
  return (RISK_ACTIONS as readonly string[]).includes(action)
}

export type RiskDecision =
  | { outcome: 'allow'; reasons: string[] }
  | { outcome: 'require_approval'; riskLevel: 'medium' | 'high'; reasons: string[]; policyCode: string }
  | { outcome: 'deny'; reasons: string[]; policyCode: string }

export type RiskPolicySnapshot = {
  version: number
  highValueReviewThresholdCents: number
  veryHighValueThresholdCents: number
  payoutApprovalThresholdCents: number
  priceDeviationToleranceBps: number
  destructiveActionsRequireApproval: boolean
  commercialOverridesRequireApproval: boolean
}

// ── Money helpers — integer cents/bps only, single rounding step, no accumulation. ──

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  return `${sign}$${(abs / 100).toFixed(2)}`
}

export type ItemValueInputs = {
  completedSaleAmountCents?: number | null
  currentListingPriceCents?: number | null
  estimatedValueCents?: number | null
  // Only relevant when the item is the sole unit under a buyout agreement
  // (acceptedItemCount === 1) — never summed with anything else.
  agreementBuyoutTotalCents?: number | null
}

export type ResolvedItemValue = { valueCents: number | null; source: string | null }

// Authoritative value hierarchy (15F section 8): a completed sale is realized money,
// outranking every advisory/proposed figure; a current listing price is the seller's
// live commercial position; 14C's estimate is advisory; an item-level buyout total is
// last because it only applies in the narrow single-item-agreement case. Never summed.
export function resolveAuthoritativeItemValueCents(inputs: ItemValueInputs): ResolvedItemValue {
  if (inputs.completedSaleAmountCents != null) return { valueCents: inputs.completedSaleAmountCents, source: 'completed_sale' }
  if (inputs.currentListingPriceCents != null) return { valueCents: inputs.currentListingPriceCents, source: 'current_listing_price' }
  if (inputs.estimatedValueCents != null) return { valueCents: inputs.estimatedValueCents, source: 'pricing_intelligence_estimate' }
  if (inputs.agreementBuyoutTotalCents != null) return { valueCents: inputs.agreementBuyoutTotalCents, source: 'agreement_buyout_total' }
  return { valueCents: null, source: null }
}

export type PriceDeviationClass = 'within_range' | 'moderate_deviation' | 'extreme_deviation'

// toleranceBps expands the [low, high] guidance band symmetrically before comparing;
// "extreme" is a proposed price beyond 2x that expanded band. Integer bps math,
// single division + round per bound — no accumulated float error.
export function classifyPriceDeviation(
  proposedCents: number,
  lowCents: number,
  highCents: number,
  toleranceBps: number,
): PriceDeviationClass {
  const tolLow = Math.round((lowCents * (10_000 - toleranceBps)) / 10_000)
  const tolHigh = Math.round((highCents * (10_000 + toleranceBps)) / 10_000)
  if (proposedCents >= tolLow && proposedCents <= tolHigh) return 'within_range'
  const extLow = Math.round((lowCents * (10_000 - 2 * toleranceBps)) / 10_000)
  const extHigh = Math.round((highCents * (10_000 + 2 * toleranceBps)) / 10_000)
  if (proposedCents < extLow || proposedCents > extHigh) return 'extreme_deviation'
  return 'moderate_deviation'
}

// Signed percent deviation from the nearer guidance bound, for explainable reasons
// only (never used for the allow/deny decision itself — classifyPriceDeviation is).
export function percentDeviationFromRange(proposedCents: number, lowCents: number, highCents: number): number {
  if (proposedCents < lowCents) return Math.round(((lowCents - proposedCents) * 100) / lowCents)
  if (proposedCents > highCents) return Math.round(((proposedCents - highCents) * 100) / highCents)
  return 0
}

// ── Per-action context shapes ────────────────────────────────────────────────────

export type AgreementCommissionOverrideContext = {
  agreementId: string
  commissionBps: number
  minimumFeeCents: number
  reason: string
  acceptedItemCount: number | null
}

export type SellerCommissionOverrideContext = {
  sellerProfileId: string
  commissionBps: number | null
  minimumFeeCents: number | null
  reason: string
  // 15F-review section 5: bound into the fingerprint (not read by the engine logic
  // itself, which always requires approval regardless) so an approval requested for
  // one effective window can never authorize a request whose dates were since edited.
  effectiveFromIso: string
  effectiveToIso: string | null
}

export type ListingActivationContext = {
  itemId: string
  catalogModelId: string
  proposedPriceCents: number
} & ItemValueInputs

export type PricingGuidance = {
  isAskOnly: boolean
  confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient'
  estimatedValueCents: number | null
  recommendedLowCents: number | null
  recommendedHighCents: number | null
} | null

export type ListingPriceChangeContext = {
  listingId: string
  oldPriceCents: number
  proposedPriceCents: number
  pricing: PricingGuidance
}

export type SellerPayoutMarkPaidContext = {
  payoutId: string
  totalAmountCents: number
  // 15F-review section 5: bound into the fingerprint for staleness/completeness (the
  // threshold decision itself only depends on totalAmountCents) — a payout that has
  // since moved out of 'approved' status, or whose payment-reference inputs changed,
  // can no longer be authorized by an approval requested against the earlier state.
  payoutStatus: string
  paymentMethod: string
  paymentReference: string
}

export type ItemCatalogReassignmentContext = {
  itemId: string
  oldCatalogModelId: string
  newCatalogModelId: string
  hasCompletedSale: boolean
} & ItemValueInputs

// 15F-review (catalog-merge pass): one administrative action, potentially many
// dependent records — never per-ItemInstance. Every count here is something
// catalogDataQualityQuery.ts's computeImpactCounts already authoritatively
// calculates (see MergeImpactSummary); none invented. hasCompletedSale-style denial
// deliberately does NOT apply here (section 5) — a merge can correct duplicate
// master data while preserving the same real-world product identity, so sold
// history affected escalates risk level rather than denying outright.
export type CatalogModelMergeContext = {
  sourceCatalogModelId: string
  canonicalCatalogModelId: string
  affectedItemCount: number
  soldItemCount: number
  activeListingCount: number
  affectedCollectionCount: number
  affectedWantedCount: number
  affectedSellerSubmissionCount: number
  affectedPhotoCount: number
  affectedFingerprintCount: number
  affectedExternalObservationCount: number
}

export type RiskContextFor<A extends RiskAction> = A extends 'agreement_commission_override'
  ? AgreementCommissionOverrideContext
  : A extends 'seller_commission_override'
    ? SellerCommissionOverrideContext
    : A extends 'listing_activation'
      ? ListingActivationContext
      : A extends 'listing_price_change'
        ? ListingPriceChangeContext
        : A extends 'seller_payout_mark_paid'
          ? SellerPayoutMarkPaidContext
          : A extends 'item_catalog_reassignment'
            ? ItemCatalogReassignmentContext
            : A extends 'catalog_model_merge'
              ? CatalogModelMergeContext
              : never

export type EvaluateRiskPolicyInput<A extends RiskAction = RiskAction> = {
  action: A
  context: RiskContextFor<A>
  policy: RiskPolicySnapshot
  asOf: Date
}

function evaluateAgreementCommissionOverride(context: AgreementCommissionOverrideContext, policy: RiskPolicySnapshot): RiskDecision {
  if (!policy.commercialOverridesRequireApproval) {
    return { outcome: 'allow', reasons: ['Commercial-override approval gating is currently disabled by policy config.'] }
  }
  return {
    outcome: 'require_approval',
    riskLevel: 'high',
    policyCode: 'commercial_override_requires_approval',
    reasons: [
      'Seller commission terms are being manually overridden from the active policy at the moment of signing.',
      `Override: ${(context.commissionBps / 100).toFixed(2)}% commission, ${formatCents(context.minimumFeeCents)} minimum fee.`,
      context.reason ? `Stated reason: ${context.reason}` : 'No override reason was provided.',
    ],
  }
}

function evaluateSellerCommissionOverride(context: SellerCommissionOverrideContext, policy: RiskPolicySnapshot): RiskDecision {
  if (!policy.commercialOverridesRequireApproval) {
    return { outcome: 'allow', reasons: ['Commercial-override approval gating is currently disabled by policy config.'] }
  }
  return {
    outcome: 'require_approval',
    riskLevel: 'medium',
    policyCode: 'commercial_override_requires_approval',
    reasons: [
      'A seller-specific preferential commission override is being created — this is a manual exception, never an automatic volume-tier resolution.',
      context.reason ? `Stated reason: ${context.reason}` : 'No override reason was provided.',
    ],
  }
}

function evaluateListingActivation(context: ListingActivationContext, policy: RiskPolicySnapshot): RiskDecision {
  const { valueCents, source } = resolveAuthoritativeItemValueCents(context)
  if (valueCents == null) {
    return { outcome: 'allow', reasons: ['No authoritative value signal available; activation proceeds — absence of valuation is never treated as unsafe by itself.'] }
  }
  if (valueCents >= policy.veryHighValueThresholdCents) {
    return {
      outcome: 'require_approval',
      riskLevel: 'high',
      policyCode: 'listing_high_value_activation',
      reasons: [`Item value ${formatCents(valueCents)} (source: ${source}) is at or above the very-high-value threshold (${formatCents(policy.veryHighValueThresholdCents)}).`],
    }
  }
  if (valueCents >= policy.highValueReviewThresholdCents) {
    return {
      outcome: 'require_approval',
      riskLevel: 'medium',
      policyCode: 'listing_high_value_activation',
      reasons: [`Item value ${formatCents(valueCents)} (source: ${source}) is at or above the high-value review threshold (${formatCents(policy.highValueReviewThresholdCents)}).`],
    }
  }
  return { outcome: 'allow', reasons: [`Item value ${formatCents(valueCents)} is below the high-value review threshold; activation proceeds automatically.`] }
}

function evaluateListingPriceChange(context: ListingPriceChangeContext, policy: RiskPolicySnapshot): RiskDecision {
  const { pricing, proposedPriceCents } = context
  if (!pricing || pricing.recommendedLowCents == null || pricing.recommendedHighCents == null) {
    return { outcome: 'allow', reasons: ['No 14C recommended range is available for this catalog model; price change accepted without a deviation check.'] }
  }
  const { recommendedLowCents: lowCents, recommendedHighCents: highCents, isAskOnly, confidenceLevel, estimatedValueCents } = pricing
  const cls = classifyPriceDeviation(proposedPriceCents, lowCents, highCents, policy.priceDeviationToleranceBps)
  const authorityNote = isAskOnly ? ' Guidance is ask-only (derived from active asking prices, not confirmed sales) and is never treated as authoritative fair value.' : ''
  if (cls === 'within_range') {
    return { outcome: 'allow', reasons: [`Proposed price ${formatCents(proposedPriceCents)} is within the recommended range (${formatCents(lowCents)}–${formatCents(highCents)}).${authorityNote}`] }
  }
  const pct = percentDeviationFromRange(proposedPriceCents, lowCents, highCents)
  const direction = proposedPriceCents < lowCents ? 'below the recommended low' : 'above the recommended high'
  const reasons = [
    `Proposed listing price is ${pct}% ${direction} of the recommended range.${authorityNote}`,
    `Estimated value: ${estimatedValueCents != null ? formatCents(estimatedValueCents) : 'unavailable'}. Recommended range: ${formatCents(lowCents)}–${formatCents(highCents)}. Proposed price: ${formatCents(proposedPriceCents)}.`,
  ]
  // Low-confidence or ask-only guidance is never authoritative enough to justify the
  // highest risk tier by itself — capped at medium regardless of deviation magnitude.
  const lowAuthority = isAskOnly || confidenceLevel === 'low' || confidenceLevel === 'insufficient'
  if (cls === 'extreme_deviation' && !lowAuthority) {
    return { outcome: 'require_approval', riskLevel: 'high', policyCode: 'price_deviation_extreme', reasons }
  }
  return { outcome: 'require_approval', riskLevel: 'medium', policyCode: 'price_deviation_exceeds_tolerance', reasons }
}

function evaluatePayoutMarkPaid(context: SellerPayoutMarkPaidContext, policy: RiskPolicySnapshot): RiskDecision {
  if (context.totalAmountCents >= policy.payoutApprovalThresholdCents) {
    return {
      outcome: 'require_approval',
      riskLevel: 'high',
      policyCode: 'payout_above_threshold',
      reasons: [`Payout total ${formatCents(context.totalAmountCents)} is at or above the configured approval threshold (${formatCents(policy.payoutApprovalThresholdCents)}).`],
    }
  }
  return { outcome: 'allow', reasons: [`Payout total ${formatCents(context.totalAmountCents)} is within the configured threshold; existing reconciliation and confirmation checkbox suffice.`] }
}

function evaluateItemCatalogReassignment(context: ItemCatalogReassignmentContext, policy: RiskPolicySnapshot): RiskDecision {
  if (context.hasCompletedSale) {
    return {
      outcome: 'deny',
      policyCode: 'item_reassignment_after_sale_denied',
      reasons: ['This item has a completed sale on record. Catalog identity cannot be reassigned through this workflow once financial history exists — the one-physical-item identity invariant must remain intact.'],
    }
  }
  if (!policy.destructiveActionsRequireApproval) {
    return { outcome: 'allow', reasons: ['Destructive/ownership-adjacent action approval gating is currently disabled by policy config.'] }
  }
  const { valueCents, source } = resolveAuthoritativeItemValueCents(context)
  if (valueCents != null && valueCents >= policy.veryHighValueThresholdCents) {
    return {
      outcome: 'require_approval',
      riskLevel: 'high',
      policyCode: 'item_high_value_reassignment',
      reasons: [`Item value ${formatCents(valueCents)} (source: ${source}) is at or above the very-high-value threshold; catalog reassignment requires approval.`],
    }
  }
  if (valueCents != null && valueCents >= policy.highValueReviewThresholdCents) {
    return {
      outcome: 'require_approval',
      riskLevel: 'medium',
      policyCode: 'item_high_value_reassignment',
      reasons: [`Item value ${formatCents(valueCents)} (source: ${source}) is at or above the high-value review threshold; catalog reassignment requires approval.`],
    }
  }
  return { outcome: 'allow', reasons: ['Routine catalog correction on an unsold, non-high-value item.'] }
}

// 15F-review (catalog-merge pass) section 4/5: a merge unconditionally deletes the
// duplicate CatalogModel row — irreversible regardless of how many records it
// affects — so it is treated as destructive whenever the destructive-approvals gate
// is enabled, never merely "allow" for a low-impact merge. Sold-history involvement
// escalates risk level (never denies — see CatalogModelMergeContext doc comment).
function evaluateCatalogModelMerge(context: CatalogModelMergeContext, policy: RiskPolicySnapshot): RiskDecision {
  if (!policy.destructiveActionsRequireApproval) {
    return {
      outcome: 'allow',
      reasons: ['Destructive-action approval gating is currently disabled by policy config; the existing merge safety validations (locks, stale-preview check, integrity check) still apply unconditionally.'],
    }
  }
  const base = `Merging catalog model ${context.sourceCatalogModelId} into ${context.canonicalCatalogModelId} would reassign ${context.affectedItemCount} physical item(s) and permanently delete the duplicate catalog model record.`
  if (context.soldItemCount > 0) {
    return {
      outcome: 'require_approval',
      riskLevel: 'high',
      policyCode: 'catalog_merge_affects_sold_history',
      reasons: [base, `${context.soldItemCount} of those items have completed sale history — the merge changes their CatalogModel relationship, never their sale amount, SKU, or order/payout identity.`],
    }
  }
  return {
    outcome: 'require_approval',
    riskLevel: 'medium',
    policyCode: 'catalog_merge_requires_approval',
    reasons: [base],
  }
}

export function evaluateRiskPolicy<A extends RiskAction>(input: EvaluateRiskPolicyInput<A>): RiskDecision {
  switch (input.action) {
    case 'agreement_commission_override':
      return evaluateAgreementCommissionOverride(input.context as AgreementCommissionOverrideContext, input.policy)
    case 'seller_commission_override':
      return evaluateSellerCommissionOverride(input.context as SellerCommissionOverrideContext, input.policy)
    case 'listing_activation':
      return evaluateListingActivation(input.context as ListingActivationContext, input.policy)
    case 'listing_price_change':
      return evaluateListingPriceChange(input.context as ListingPriceChangeContext, input.policy)
    case 'seller_payout_mark_paid':
      return evaluatePayoutMarkPaid(input.context as SellerPayoutMarkPaidContext, input.policy)
    case 'item_catalog_reassignment':
      return evaluateItemCatalogReassignment(input.context as ItemCatalogReassignmentContext, input.policy)
    case 'catalog_model_merge':
      return evaluateCatalogModelMerge(input.context as CatalogModelMergeContext, input.policy)
    default: {
      const _exhaustive: never = input.action
      throw new Error(`Unknown risk action: ${_exhaustive}`)
    }
  }
}

// ── Context fingerprint — deterministic binding of an approval request to the exact
// proposed change (section 17). Recursive key-sorted JSON, sha256 hex. Pure. ────────

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) sorted[key] = sortKeysDeep(obj[key])
    return sorted
  }
  return value
}

export function computeContextFingerprint(action: string, targetId: string, context: Record<string, unknown>): string {
  const stable = JSON.stringify(sortKeysDeep({ action, targetId, context }))
  return crypto.createHash('sha256').update(stable).digest('hex')
}
