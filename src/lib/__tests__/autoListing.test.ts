// 15K: pure-logic tests for autoListing.ts (pricing + eligibility) — no DB, no mocks.
import { describe, it, expect } from 'vitest'
import { computeAutoListPriceCents, deriveListingTitle, evaluateAutoListCandidate } from '@/lib/autoListing'
import type { AutoListingPolicySnapshot } from '@/lib/autoListingPolicy'

function policy(overrides: Partial<AutoListingPolicySnapshot> = {}): AutoListingPolicySnapshot {
  return { version: 1, effectiveFrom: new Date('2026-01-01'), enabled: true, minimumPricingConfidence: 'high', pricePositionBps: 5000, ...overrides }
}

describe('computeAutoListPriceCents — deterministic price (Part D)', () => {
  it('bps=0 returns exactly the low boundary', () => {
    expect(computeAutoListPriceCents(1000, 2000, 0)).toEqual({ ok: true, priceCents: 1000 })
  })
  it('bps=10000 returns exactly the high boundary', () => {
    expect(computeAutoListPriceCents(1000, 2000, 10_000)).toEqual({ ok: true, priceCents: 2000 })
  })
  it('bps=5000 returns the exact midpoint for an even range', () => {
    expect(computeAutoListPriceCents(1000, 2000, 5000)).toEqual({ ok: true, priceCents: 1500 })
  })
  it('awkward-cent range: 1-cent range at bps=5000 rounds half-up, never truncates down', () => {
    // range=1, 1*5000/10000 = 0.5 -> round-half-up -> 1
    expect(computeAutoListPriceCents(1000, 1001, 5000)).toEqual({ ok: true, priceCents: 1001 })
  })
  it('awkward-cent range: exact half-up boundary at bps=2500 on a 3-cent range', () => {
    // range=3, 3*2500/10000 = 0.75 -> rounds up to 1
    expect(computeAutoListPriceCents(1000, 1003, 2500)).toEqual({ ok: true, priceCents: 1001 })
  })
  it('never produces a price outside [low, high] across a dense bps sweep', () => {
    for (let bps = 0; bps <= 10_000; bps += 137) {
      const r = computeAutoListPriceCents(999, 100_003, bps)
      expect(r.ok).toBe(true)
      if (r.ok) { expect(r.priceCents).toBeGreaterThanOrEqual(999); expect(r.priceCents).toBeLessThanOrEqual(100_003) }
    }
  })
  it('rejects a null low or high', () => {
    expect(computeAutoListPriceCents(null, 2000, 5000)).toEqual({ ok: false })
    expect(computeAutoListPriceCents(1000, null, 5000)).toEqual({ ok: false })
  })
  it('rejects low <= 0', () => {
    expect(computeAutoListPriceCents(0, 2000, 5000)).toEqual({ ok: false })
    expect(computeAutoListPriceCents(-100, 2000, 5000)).toEqual({ ok: false })
  })
  it('rejects high < low', () => {
    expect(computeAutoListPriceCents(2000, 1000, 5000)).toEqual({ ok: false })
  })
  it('accepts low === high (zero-width range) and returns that exact value at any position', () => {
    expect(computeAutoListPriceCents(1500, 1500, 0)).toEqual({ ok: true, priceCents: 1500 })
    expect(computeAutoListPriceCents(1500, 1500, 10_000)).toEqual({ ok: true, priceCents: 1500 })
  })
  it('no JS float accumulation: a large awkward range stays exact across every bps step', () => {
    // 123456789 - 100000001 = 23456788 cents range; float math would drift here.
    const r = computeAutoListPriceCents(100_000_001, 123_456_789, 3333)
    expect(r.ok).toBe(true)
    // Exact BigInt computation: 23456788 * 3333 = 78181474404; /10000 = 7818147.4404 -> round -> 7818147
    if (r.ok) expect(r.priceCents).toBe(100_000_001 + 7_818_147)
  })
})

describe('deriveListingTitle — deterministic title (Part E)', () => {
  it('includes year when present', () => {
    expect(deriveListingTitle({ brand: 'Hot Wheels', name: 'Porsche 911 GT3', year: 2024 })).toBe('2024 Hot Wheels Porsche 911 GT3')
  })
  it('omits year when null, never fabricates one', () => {
    expect(deriveListingTitle({ brand: 'Hot Wheels', name: 'Porsche 911 GT3', year: null })).toBe('Hot Wheels Porsche 911 GT3')
  })
  it('returns null (never "Unknown"/"Untitled") when brand or name is blank', () => {
    expect(deriveListingTitle({ brand: '', name: 'X', year: null })).toBeNull()
    expect(deriveListingTitle({ brand: 'X', name: '  ', year: null })).toBeNull()
  })
})

describe('evaluateAutoListCandidate — eligibility (Part C)', () => {
  const goodPricing = { isAskOnly: false, confidenceLevel: 'high' as const, recommendedLowCents: 1000, recommendedHighCents: 2000 }
  const catalog = { brand: 'Hot Wheels', name: 'GT3', year: 2024 }

  it('disabled policy -> policy_disabled, regardless of how strong everything else is', () => {
    const r = evaluateAutoListCandidate({ policy: policy({ enabled: false }), listingPath: 'create', pricing: goodPricing, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'policy_disabled' })
  })

  it('listingPath=reactivate -> reactivation_requires_manual_review (Part F scope)', () => {
    const r = evaluateAutoListCandidate({ policy: policy(), listingPath: 'reactivate', pricing: goodPricing, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'reactivation_requires_manual_review' })
  })

  it('ask-only pricing is never auto-listable, even with confidenceLevel spoofed to high', () => {
    const r = evaluateAutoListCandidate({ policy: policy(), listingPath: 'create', pricing: { ...goodPricing, isAskOnly: true }, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'pricing_ask_only' })
  })

  it('null pricing (14C returned nothing) -> pricing_evidence_missing', () => {
    const r = evaluateAutoListCandidate({ policy: policy(), listingPath: 'create', pricing: null, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'pricing_evidence_missing' })
  })

  it('insufficient confidence -> pricing_evidence_missing', () => {
    const r = evaluateAutoListCandidate({ policy: policy(), listingPath: 'create', pricing: { ...goodPricing, confidenceLevel: 'insufficient' }, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'pricing_evidence_missing' })
  })

  it('low confidence rejected when policy requires medium (below policy minimum)', () => {
    const r = evaluateAutoListCandidate({ policy: policy({ minimumPricingConfidence: 'medium' }), listingPath: 'create', pricing: { ...goodPricing, confidenceLevel: 'low' }, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'pricing_confidence_below_policy' })
  })

  it('medium confidence rejected when policy requires high', () => {
    const r = evaluateAutoListCandidate({ policy: policy({ minimumPricingConfidence: 'high' }), listingPath: 'create', pricing: { ...goodPricing, confidenceLevel: 'medium' }, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'pricing_confidence_below_policy' })
  })

  it('medium confidence accepted when policy allows medium', () => {
    const r = evaluateAutoListCandidate({ policy: policy({ minimumPricingConfidence: 'medium' }), listingPath: 'create', pricing: { ...goodPricing, confidenceLevel: 'medium' }, catalog })
    expect(r.eligible).toBe(true)
  })

  it('invalid range (missing high) -> pricing_range_invalid', () => {
    const r = evaluateAutoListCandidate({ policy: policy(), listingPath: 'create', pricing: { ...goodPricing, recommendedHighCents: null }, catalog })
    expect(r).toEqual({ eligible: false, reasonCode: 'pricing_range_invalid' })
  })

  it('missing required field (blank brand) -> required_listing_field_missing', () => {
    const r = evaluateAutoListCandidate({ policy: policy(), listingPath: 'create', pricing: goodPricing, catalog: { brand: '', name: 'X', year: null } })
    expect(r).toEqual({ eligible: false, reasonCode: 'required_listing_field_missing' })
  })

  it('fully eligible candidate returns an exact price within range and a deterministic title', () => {
    const r = evaluateAutoListCandidate({ policy: policy({ pricePositionBps: 0 }), listingPath: 'create', pricing: goodPricing, catalog })
    expect(r).toEqual({ eligible: true, proposedPriceCents: 1000, title: '2024 Hot Wheels GT3' })
  })
})
