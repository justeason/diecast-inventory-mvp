// 15A: Commission Policy Engine — pure resolution logic. No DB access (see
// commissionPolicyQuery.ts for that boundary). Integer basis points (bps) and
// integer cents throughout — no JS Float financial arithmetic anywhere.
//
// Resolution precedence (highest wins):
//   agreement override  >  seller override  >  volume tier  >  policy default
//
// Volume-tier denominator for 15A: the linked SellerSubmission's declared item
// quantity (SellerSubmission.quantity), NOT a count of converted ItemInstance rows.
// This is a deliberate, documented limitation of the current schema: ItemInstance
// only gets `sellerAgreementId` set during intake conversion, which itself requires
// the agreement to already be status='accepted' (see resolveConversionEligibility in
// actions/intake.ts) — so a physically-converted "accepted item count" is
// structurally always 0 at or before acceptance time and cannot be used to tier a
// signed agreement. SellerSubmission.quantity is the cleanest agreement-scoped
// equivalent available today. 15B's Portfolio can later supply a real accepted-item
// count without changing any function signature here (the resolver takes a plain
// `acceptedItemCount: number`, not a submission or portfolio object).

export type ResolutionSource = 'agreement_override' | 'seller_override' | 'policy_tier' | 'policy_default'

export type CommissionTierDef = {
  id: string
  minItems: number
  commissionBps: number
  minimumFeeCents: number | null // null = inherit policy default
}

export type CommissionPolicyDef = {
  id: string
  name: string
  defaultCommissionBps: number
  minimumFeeCents: number
  tiers: CommissionTierDef[]
}

export type SellerOverrideDef = {
  id: string
  commissionBps: number | null
  minimumFeeCents: number | null
  effectiveFrom: Date
  effectiveTo: Date | null
}

export type AgreementOverrideDef = {
  commissionBps: number
  minimumFeeCents: number
  reason: string
}

export type CommissionResolution = {
  commissionBps: number
  minimumFeeCents: number
  source: ResolutionSource
  policyId: string | null
  tierId: string | null
  acceptedItemCount: number
  explanation: string
}

// ── Validation (section 18) ───────────────────────────────────────────────────────

export type ValidationResult = { valid: true } | { valid: false; error: string }

export function validateCommissionRate(bps: number, label = 'Commission rate'): ValidationResult {
  if (!Number.isInteger(bps)) return { valid: false, error: `${label} must be an integer number of basis points.` }
  if (bps < 0) return { valid: false, error: `${label} cannot be negative.` }
  if (bps > 10_000) return { valid: false, error: `${label} cannot exceed 100% (10000 bps).` }
  return { valid: true }
}

export function validateMinimumFee(cents: number, label = 'Minimum fee'): ValidationResult {
  if (!Number.isInteger(cents)) return { valid: false, error: `${label} must be an integer number of cents.` }
  if (cents < 0) return { valid: false, error: `${label} cannot be negative.` }
  return { valid: true }
}

// Tiers are floor-only (minItems), so overlap/gaps are impossible by construction —
// the only invalid configurations are duplicate/inverted boundaries or bad rates.
export function validateTiers(
  tiers: Array<{ minItems: number; commissionBps: number; minimumFeeCents: number | null }>,
): ValidationResult {
  if (tiers.length === 0) return { valid: true }
  const sorted = [...tiers].sort((a, b) => a.minItems - b.minItems)
  if (sorted[0].minItems < 1) {
    return { valid: false, error: 'The lowest tier must start at item count 1 or greater.' }
  }
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]
    const rate = validateCommissionRate(t.commissionBps, `Tier starting at ${t.minItems} items: commission rate`)
    if (!rate.valid) return rate
    if (t.minimumFeeCents !== null) {
      const fee = validateMinimumFee(t.minimumFeeCents, `Tier starting at ${t.minItems} items: minimum fee`)
      if (!fee.valid) return fee
    }
    if (i > 0 && sorted[i - 1].minItems === t.minItems) {
      return { valid: false, error: `Duplicate tier boundary at ${t.minItems} items — each tier must start at a distinct item count.` }
    }
  }
  return { valid: true }
}

export function validatePolicy(policy: {
  defaultCommissionBps: number
  minimumFeeCents: number
  effectiveFrom: Date
  effectiveTo: Date | null
  tiers: Array<{ minItems: number; commissionBps: number; minimumFeeCents: number | null }>
}): ValidationResult {
  const rate = validateCommissionRate(policy.defaultCommissionBps, 'Default commission rate')
  if (!rate.valid) return rate
  const fee = validateMinimumFee(policy.minimumFeeCents, 'Default minimum fee')
  if (!fee.valid) return fee
  if (policy.effectiveTo !== null && policy.effectiveTo.getTime() <= policy.effectiveFrom.getTime()) {
    return { valid: false, error: 'Policy effectiveTo must be after effectiveFrom.' }
  }
  return validateTiers(policy.tiers)
}

// Two ACTIVE policies with overlapping [effectiveFrom, effectiveTo) windows would
// make resolution ambiguous — reject rather than silently pick one (section 18).
export function validateNoOverlappingActivePolicies(
  policies: Array<{ id: string; effectiveFrom: Date; effectiveTo: Date | null }>,
): ValidationResult {
  const sorted = [...policies].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const prevEnd = prev.effectiveTo?.getTime() ?? Infinity
    if (prevEnd > cur.effectiveFrom.getTime()) {
      return { valid: false, error: `Policy "${prev.id}" and "${cur.id}" have overlapping effective windows.` }
    }
  }
  return { valid: true }
}

// 15A-review section 3: same reasoning as validateNoOverlappingActivePolicies, applied
// to one seller's SellerCommissionOverride rows (which have no status field — every
// row is "live" over its own window). Two overrides for the SAME seller with
// overlapping [effectiveFrom, effectiveTo) windows would make fetchActiveSellerOverride
// ambiguous (findFirst would pick an arbitrary row) — reject rather than silently pick
// one. Adjacent windows ([Jan 1, Feb 1) and [Feb 1, Mar 1)) are valid, matching the
// half-open-interval semantics used everywhere else in this file.
export function validateNoOverlappingSellerOverrides(
  overrides: Array<{ id: string; effectiveFrom: Date; effectiveTo: Date | null }>,
): ValidationResult {
  const sorted = [...overrides].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const prevEnd = prev.effectiveTo?.getTime() ?? Infinity
    if (prevEnd > cur.effectiveFrom.getTime()) {
      return { valid: false, error: `Seller override "${prev.id}" and "${cur.id}" have overlapping effective windows for this seller.` }
    }
  }
  return { valid: true }
}

// ── Tier selection ────────────────────────────────────────────────────────────────

export function selectTier(tiers: CommissionTierDef[], acceptedItemCount: number): CommissionTierDef | null {
  let best: CommissionTierDef | null = null
  for (const t of tiers) {
    if (t.minItems <= acceptedItemCount && (best === null || t.minItems > best.minItems)) best = t
  }
  return best
}

// ── Commission amount (section 4; rounding verified 15A-review section 6) ─────────
// commission = min(max(round(salePriceCents * commissionBps / 10000), minimumFeeCents), salePriceCents)
// i.e. the minimum-fee floor wins when it's larger than the computed percentage
// commission, but the result is always capped at the gross sale price it's taken
// from — commission can never exceed the sale.
//
// Rounding rule: the percentage commission is rounded to the nearest whole cent
// using round-half-up (Math.round — ties round away from zero; all inputs here are
// non-negative, so this is equivalent to "round half up"). This is a SINGLE
// multiply-divide-round on integers — salePriceCents and commissionBps are both
// integers no larger than a few million, so salePriceCents * commissionBps stays
// far below Number.MAX_SAFE_INTEGER (2^53) and the division is exact IEEE-754
// arithmetic; there is no repeated/accumulated floating-point arithmetic, so the same
// inputs always produce the same cents. sellerPayoutCalculation.ts's
// calculateConsignmentPayoutSnapshot independently applies the identical rounding
// rule (round-half-up to 2 decimal places) via Prisma.Decimal for the live payout
// path — both are covered by boundary tests asserting they agree.
export function computeCommissionCents(salePriceCents: number, commissionBps: number, minimumFeeCents: number): number {
  const pct = Math.round((salePriceCents * commissionBps) / 10_000)
  const withMinimum = Math.max(pct, minimumFeeCents)
  return Math.min(withMinimum, Math.max(salePriceCents, 0))
}

// ── Explanation (deterministic facts only, no LLM) ────────────────────────────────

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function pctLabel(bps: number): string {
  const pct = bps / 100
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`
}

function buildExplanation(params: {
  source: ResolutionSource
  commissionBps: number
  minimumFeeCents: number
  policyName: string | null
  tier: CommissionTierDef | null
  acceptedItemCount: number
  overrideReason: string | null
}): string {
  const { source, commissionBps, minimumFeeCents, policyName, tier, acceptedItemCount, overrideReason } = params
  const rateStr = pctLabel(commissionBps)
  const feeStr = usd(minimumFeeCents)

  if (source === 'agreement_override') {
    return `${rateStr} commission manually set for this agreement${overrideReason ? ` (${overrideReason})` : ''}. Minimum commission is ${feeStr} per sold item.`
  }
  if (source === 'seller_override') {
    return `${rateStr} commission applied from a seller-specific override. Minimum commission is ${feeStr} per sold item.`
  }
  if (source === 'policy_tier' && tier) {
    return `${rateStr} commission selected from ${policyName ?? 'the active policy'} because this agreement contains ${acceptedItemCount} accepted item${acceptedItemCount === 1 ? '' : 's'} (tier starting at ${tier.minItems} items). Minimum commission is ${feeStr} per sold item.`
  }
  return `${rateStr} default commission from ${policyName ?? 'the active policy'} (${acceptedItemCount} accepted item${acceptedItemCount === 1 ? '' : 's'} did not meet any volume tier). Minimum commission is ${feeStr} per sold item.`
}

// ── Main resolver (section 5) ─────────────────────────────────────────────────────

export function resolveCommissionTerms(params: {
  agreementOverride?: AgreementOverrideDef | null
  sellerOverride?: SellerOverrideDef | null
  policy: CommissionPolicyDef
  acceptedItemCount: number
  asOf: Date
}): CommissionResolution {
  const { agreementOverride, sellerOverride, policy, acceptedItemCount, asOf } = params

  if (agreementOverride) {
    return {
      commissionBps: agreementOverride.commissionBps,
      minimumFeeCents: agreementOverride.minimumFeeCents,
      source: 'agreement_override',
      policyId: policy.id,
      tierId: null,
      acceptedItemCount,
      explanation: buildExplanation({
        source: 'agreement_override',
        commissionBps: agreementOverride.commissionBps,
        minimumFeeCents: agreementOverride.minimumFeeCents,
        policyName: policy.name,
        tier: null,
        acceptedItemCount,
        overrideReason: agreementOverride.reason,
      }),
    }
  }

  const overrideActive = sellerOverride
    && sellerOverride.effectiveFrom.getTime() <= asOf.getTime()
    && (sellerOverride.effectiveTo === null || sellerOverride.effectiveTo.getTime() > asOf.getTime())

  if (overrideActive && sellerOverride) {
    const commissionBps = sellerOverride.commissionBps ?? policy.defaultCommissionBps
    const minimumFeeCents = sellerOverride.minimumFeeCents ?? policy.minimumFeeCents
    return {
      commissionBps,
      minimumFeeCents,
      source: 'seller_override',
      policyId: policy.id,
      tierId: null,
      acceptedItemCount,
      explanation: buildExplanation({
        source: 'seller_override',
        commissionBps,
        minimumFeeCents,
        policyName: policy.name,
        tier: null,
        acceptedItemCount,
        overrideReason: null,
      }),
    }
  }

  const tier = selectTier(policy.tiers, acceptedItemCount)
  if (tier) {
    const minimumFeeCents = tier.minimumFeeCents ?? policy.minimumFeeCents
    return {
      commissionBps: tier.commissionBps,
      minimumFeeCents,
      source: 'policy_tier',
      policyId: policy.id,
      tierId: tier.id,
      acceptedItemCount,
      explanation: buildExplanation({
        source: 'policy_tier',
        commissionBps: tier.commissionBps,
        minimumFeeCents,
        policyName: policy.name,
        tier,
        acceptedItemCount,
        overrideReason: null,
      }),
    }
  }

  return {
    commissionBps: policy.defaultCommissionBps,
    minimumFeeCents: policy.minimumFeeCents,
    source: 'policy_default',
    policyId: policy.id,
    tierId: null,
    acceptedItemCount,
    explanation: buildExplanation({
      source: 'policy_default',
      commissionBps: policy.defaultCommissionBps,
      minimumFeeCents: policy.minimumFeeCents,
      policyName: policy.name,
      tier: null,
      acceptedItemCount,
      overrideReason: null,
    }),
  }
}
