import { describe, it, expect } from 'vitest'
import {
  resolveCommissionTerms,
  selectTier,
  computeCommissionCents,
  validateCommissionRate,
  validateMinimumFee,
  validateTiers,
  validatePolicy,
  validateNoOverlappingActivePolicies,
} from '@/lib/commissionPolicy'
import type { CommissionPolicyDef, SellerOverrideDef, AgreementOverrideDef } from '@/lib/commissionPolicy'

const ASOF = new Date('2026-08-01T00:00:00.000Z')

const STANDARD_POLICY: CommissionPolicyDef = {
  id: 'pol1',
  name: 'Standard Consignment',
  defaultCommissionBps: 2000, // 20%
  minimumFeeCents: 250, // $2.50
  tiers: [
    { id: 't1', minItems: 1, commissionBps: 2000, minimumFeeCents: null },
    { id: 't20', minItems: 20, commissionBps: 1700, minimumFeeCents: null },
    { id: 't200', minItems: 200, commissionBps: 1500, minimumFeeCents: null },
  ],
}

// ── Policy resolution ──────────────────────────────────────────────────────────────

describe('commissionPolicy: tier selection (boundaries)', () => {
  it('19 items -> 1-19 tier (20%)', () => {
    const t = selectTier(STANDARD_POLICY.tiers, 19)
    expect(t?.id).toBe('t1')
    expect(t?.commissionBps).toBe(2000)
  })
  it('20 items -> 20-199 tier (17%)', () => {
    const t = selectTier(STANDARD_POLICY.tiers, 20)
    expect(t?.id).toBe('t20')
  })
  it('199 items -> 20-199 tier (17%)', () => {
    const t = selectTier(STANDARD_POLICY.tiers, 199)
    expect(t?.id).toBe('t20')
  })
  it('200 items -> 200+ tier (15%)', () => {
    const t = selectTier(STANDARD_POLICY.tiers, 200)
    expect(t?.id).toBe('t200')
  })
  it('0 items -> no tier matches (below the lowest floor)', () => {
    const t = selectTier(STANDARD_POLICY.tiers, 0)
    expect(t).toBeNull()
  })
})

// 15A-review section 1's worked example: seller submits 250, CollectNTrades accepts a
// different quantity — the tier must reflect the ACCEPTED count, never the submitted
// count. selectTier/resolveCommissionTerms only ever see acceptedItemCount, so the
// submitted quantity of 250 never appears in these calls at all.
describe('commissionPolicy: submitted-vs-accepted worked example (250 submitted)', () => {
  it('250 submitted, 75 accepted -> 20-199 tier (17%), not the 200+ tier the submitted count would imply', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 75, asOf: ASOF })
    expect(r.acceptedItemCount).toBe(75)
    expect(r.commissionBps).toBe(1700)
    const tier = selectTier(STANDARD_POLICY.tiers, 75)
    expect(tier?.id).toBe('t20')
  })

  it('250 submitted, 200 accepted -> 200+ tier (15%)', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 200, asOf: ASOF })
    expect(r.acceptedItemCount).toBe(200)
    expect(r.commissionBps).toBe(1500)
  })
})

describe('commissionPolicy: resolveCommissionTerms — default/tier resolution', () => {
  it('default rate applies when no tiers exist', () => {
    const r = resolveCommissionTerms({ policy: { ...STANDARD_POLICY, tiers: [] }, acceptedItemCount: 500, asOf: ASOF })
    expect(r.source).toBe('policy_default')
    expect(r.commissionBps).toBe(2000)
    expect(r.minimumFeeCents).toBe(250)
  })

  it('minimum fee comes from the policy default when a tier has no override', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    expect(r.minimumFeeCents).toBe(250)
  })

  it('a tier-specific minimum fee overrides the policy default', () => {
    const policy: CommissionPolicyDef = {
      ...STANDARD_POLICY,
      tiers: [{ id: 't1', minItems: 1, commissionBps: 2000, minimumFeeCents: 500 }],
    }
    const r = resolveCommissionTerms({ policy, acceptedItemCount: 5, asOf: ASOF })
    expect(r.minimumFeeCents).toBe(500)
  })

  it('volume tier selects 17% for 53 accepted items (matches the worked example)', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    expect(r.commissionBps).toBe(1700)
    expect(r.source).toBe('policy_tier')
    expect(r.explanation).toContain('17%')
    expect(r.explanation).toContain('53 accepted items')
    expect(r.explanation).toContain('Standard Consignment')
  })

  it('no ambiguous policy: a single resolution call always returns exactly one deterministic result', () => {
    const r1 = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    const r2 = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    expect(r1).toEqual(r2)
  })

  it('correct asOf policy: identical inputs at the same asOf always produce the same resolution (determinism)', () => {
    const results = Array.from({ length: 5 }, () => resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 199, asOf: ASOF }))
    for (const r of results) expect(r).toEqual(results[0])
  })
})

// ── Override precedence ────────────────────────────────────────────────────────────

describe('commissionPolicy: seller override precedence', () => {
  const activeOverride: SellerOverrideDef = {
    id: 'ov1', commissionBps: 1200, minimumFeeCents: 300,
    effectiveFrom: new Date('2026-01-01'), effectiveTo: null,
  }

  it('seller override beats tier/default', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: activeOverride, acceptedItemCount: 53, asOf: ASOF })
    expect(r.commissionBps).toBe(1200)
    expect(r.minimumFeeCents).toBe(300)
    expect(r.source).toBe('seller_override')
  })

  it('expired seller override (effectiveTo in the past) is ignored — falls back to tier', () => {
    const expired: SellerOverrideDef = { ...activeOverride, effectiveTo: new Date('2026-01-15') }
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: expired, acceptedItemCount: 53, asOf: ASOF })
    expect(r.source).toBe('policy_tier')
  })

  it('future seller override (effectiveFrom after asOf) is ignored', () => {
    const future: SellerOverrideDef = { ...activeOverride, effectiveFrom: new Date('2027-01-01') }
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: future, acceptedItemCount: 53, asOf: ASOF })
    expect(r.source).toBe('policy_tier')
  })

  it('an override effective exactly at asOf (inclusive start) applies', () => {
    const startsToday: SellerOverrideDef = { ...activeOverride, effectiveFrom: ASOF }
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: startsToday, acceptedItemCount: 53, asOf: ASOF })
    expect(r.source).toBe('seller_override')
  })

  it('an override ending exactly at asOf (exclusive end) does not apply', () => {
    const endsToday: SellerOverrideDef = { ...activeOverride, effectiveTo: ASOF }
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: endsToday, acceptedItemCount: 53, asOf: ASOF })
    expect(r.source).toBe('policy_tier')
  })

  it('a partial seller override (bps only) inherits the policy default minimum fee', () => {
    const partial: SellerOverrideDef = { id: 'ov2', commissionBps: 1000, minimumFeeCents: null, effectiveFrom: new Date('2026-01-01'), effectiveTo: null }
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: partial, acceptedItemCount: 53, asOf: ASOF })
    expect(r.commissionBps).toBe(1000)
    expect(r.minimumFeeCents).toBe(250) // policy default
  })

  it('same asOf produces same result for override resolution (determinism)', () => {
    const r1 = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: activeOverride, acceptedItemCount: 53, asOf: ASOF })
    const r2 = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride: activeOverride, acceptedItemCount: 53, asOf: ASOF })
    expect(r1).toEqual(r2)
  })
})

describe('commissionPolicy: agreement override precedence (highest)', () => {
  const agreementOverride: AgreementOverrideDef = { commissionBps: 500, minimumFeeCents: 100, reason: 'VIP negotiated deal' }
  const sellerOverride: SellerOverrideDef = { id: 'ov1', commissionBps: 1200, minimumFeeCents: 300, effectiveFrom: new Date('2026-01-01'), effectiveTo: null }

  it('agreement override beats seller override', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, agreementOverride, sellerOverride, acceptedItemCount: 53, asOf: ASOF })
    expect(r.commissionBps).toBe(500)
    expect(r.source).toBe('agreement_override')
  })

  it('agreement override beats tier/default even with no seller override present', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, agreementOverride, acceptedItemCount: 53, asOf: ASOF })
    expect(r.commissionBps).toBe(500)
  })

  it('override reason/audit required: explanation includes the reason', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, agreementOverride, acceptedItemCount: 53, asOf: ASOF })
    expect(r.explanation).toContain('VIP negotiated deal')
  })

  it('full precedence chain: agreement > seller > tier > default', () => {
    const withAll = resolveCommissionTerms({ policy: STANDARD_POLICY, agreementOverride, sellerOverride, acceptedItemCount: 53, asOf: ASOF })
    const withSellerOnly = resolveCommissionTerms({ policy: STANDARD_POLICY, sellerOverride, acceptedItemCount: 53, asOf: ASOF })
    const withTierOnly = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    const withDefaultOnly = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 0, asOf: ASOF })
    expect(withAll.source).toBe('agreement_override')
    expect(withSellerOnly.source).toBe('seller_override')
    expect(withTierOnly.source).toBe('policy_tier')
    expect(withDefaultOnly.source).toBe('policy_default')
  })
})

// ── Commission amount computation ──────────────────────────────────────────────────

describe('commissionPolicy: computeCommissionCents', () => {
  it('$8 sale, 20%, min $2.50 -> $2.50 (minimum wins)', () => {
    expect(computeCommissionCents(800, 2000, 250)).toBe(250)
  })
  it('$40 sale, 20%, min $2.50 -> $8.00 (percentage wins)', () => {
    expect(computeCommissionCents(4000, 2000, 250)).toBe(800)
  })
  it('minimum fee exceeding sale price caps at gross sale price', () => {
    expect(computeCommissionCents(500, 2000, 1000)).toBe(500)
  })
  it('awkward cents: $0.01, $0.10, $19.99 at 20%', () => {
    expect(computeCommissionCents(1, 2000, 0)).toBe(0) // 0.2 cents rounds to 0
    expect(computeCommissionCents(10, 2000, 0)).toBe(2)
    expect(computeCommissionCents(1999, 2000, 0)).toBe(400) // 399.8 rounds to 400
  })
  it('all results are integers — no JS Float drift', () => {
    for (const price of [1, 10, 800, 1999, 4000]) {
      expect(Number.isInteger(computeCommissionCents(price, 2000, 250))).toBe(true)
    }
  })

  // 15A-review section 6: fractional-cent boundary cases, no minimum fee floor
  // interference (minimumFeeCents: 0) so the raw round-half-up rule is exercised.
  describe('fractional-cent boundary cases (round-half-up to the nearest cent)', () => {
    it('$0.99 x 17% -> 16.83 cents rounds up to 17 cents', () => {
      expect(computeCommissionCents(99, 1700, 0)).toBe(17)
    })
    it('$19.99 x 17% -> 339.83 cents rounds up to 340 cents', () => {
      expect(computeCommissionCents(1999, 1700, 0)).toBe(340)
    })
    it('$19.99 x 15% -> 299.85 cents rounds up to 300 cents', () => {
      expect(computeCommissionCents(1999, 1500, 0)).toBe(300)
    })
    it('same inputs always produce the same cents (deterministic, no accumulation drift)', () => {
      const results = new Set(
        Array.from({ length: 20 }, () => computeCommissionCents(1999, 1500, 0)),
      )
      expect(results.size).toBe(1)
      expect([...results][0]).toBe(300)
    })
  })
})

// ── Validation (section 18) ─────────────────────────────────────────────────────────

describe('commissionPolicy: validation', () => {
  it('rejects negative commission rate', () => {
    expect(validateCommissionRate(-1).valid).toBe(false)
  })
  it('rejects rate over 100% (>10000 bps)', () => {
    expect(validateCommissionRate(10_001).valid).toBe(false)
  })
  it('accepts exactly 100% (10000 bps)', () => {
    expect(validateCommissionRate(10_000).valid).toBe(true)
  })
  it('rejects negative minimum fee', () => {
    expect(validateMinimumFee(-1).valid).toBe(false)
  })
  it('accepts zero minimum fee', () => {
    expect(validateMinimumFee(0).valid).toBe(true)
  })

  it('no overlapping tiers possible by construction — duplicate boundaries are rejected explicitly', () => {
    const result = validateTiers([
      { minItems: 1, commissionBps: 2000, minimumFeeCents: null },
      { minItems: 1, commissionBps: 1500, minimumFeeCents: null },
    ])
    expect(result.valid).toBe(false)
  })

  it('rejects a tier starting below item 1', () => {
    const result = validateTiers([{ minItems: 0, commissionBps: 2000, minimumFeeCents: null }])
    expect(result.valid).toBe(false)
  })

  it('accepts the worked example tiers (1, 20, 200) with no gaps/overlap concerns', () => {
    expect(validateTiers(STANDARD_POLICY.tiers).valid).toBe(true)
  })

  it('accepts an empty tier list (default-only policy)', () => {
    expect(validateTiers([]).valid).toBe(true)
  })

  it('validatePolicy rejects effectiveTo before effectiveFrom', () => {
    const result = validatePolicy({
      defaultCommissionBps: 2000, minimumFeeCents: 250,
      effectiveFrom: new Date('2026-06-01'), effectiveTo: new Date('2026-01-01'),
      tiers: [],
    })
    expect(result.valid).toBe(false)
  })

  it('validateNoOverlappingActivePolicies rejects two policies with overlapping windows', () => {
    const result = validateNoOverlappingActivePolicies([
      { id: 'a', effectiveFrom: new Date('2026-01-01'), effectiveTo: new Date('2026-06-01') },
      { id: 'b', effectiveFrom: new Date('2026-03-01'), effectiveTo: null },
    ])
    expect(result.valid).toBe(false)
  })

  it('validateNoOverlappingActivePolicies accepts sequential, non-overlapping policies', () => {
    const result = validateNoOverlappingActivePolicies([
      { id: 'a', effectiveFrom: new Date('2026-01-01'), effectiveTo: new Date('2026-06-01') },
      { id: 'b', effectiveFrom: new Date('2026-06-01'), effectiveTo: null },
    ])
    expect(result.valid).toBe(true)
  })

  it('does not silently choose an arbitrary policy row on overlap — reports a clear error', () => {
    const result = validateNoOverlappingActivePolicies([
      { id: 'a', effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
      { id: 'b', effectiveFrom: new Date('2026-01-15'), effectiveTo: null },
    ])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error.length).toBeGreaterThan(0)
  })
})

// ── Explainability ────────────────────────────────────────────────────────────────

describe('commissionPolicy: explanation is deterministic facts only', () => {
  it('explanation cites the item count, tier boundary, and minimum fee', () => {
    const r = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    expect(r.explanation).toBe(
      '17% commission selected from Standard Consignment because this agreement contains 53 accepted items (tier starting at 20 items). Minimum commission is $2.50 per sold item.',
    )
  })

  it('same inputs always produce the same explanation string', () => {
    const r1 = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    const r2 = resolveCommissionTerms({ policy: STANDARD_POLICY, acceptedItemCount: 53, asOf: ASOF })
    expect(r1.explanation).toBe(r2.explanation)
  })
})
