import { describe, it, expect } from 'vitest'
import {
  evaluateRiskPolicy,
  resolveAuthoritativeItemValueCents,
  classifyPriceDeviation,
  computeContextFingerprint,
  formatCents,
  type RiskPolicySnapshot,
} from '@/lib/riskPolicy'

const policy: RiskPolicySnapshot = {
  version: 1,
  highValueReviewThresholdCents: 20_000,
  veryHighValueThresholdCents: 100_000,
  payoutApprovalThresholdCents: 100_000,
  priceDeviationToleranceBps: 1500, // 15%
  destructiveActionsRequireApproval: true,
  commercialOverridesRequireApproval: true,
}

describe('resolveAuthoritativeItemValueCents (section 8) — hierarchy, never summed', () => {
  it('a completed sale outranks everything else', () => {
    const r = resolveAuthoritativeItemValueCents({ completedSaleAmountCents: 500, currentListingPriceCents: 900, estimatedValueCents: 100, agreementBuyoutTotalCents: 50 })
    expect(r).toEqual({ valueCents: 500, source: 'completed_sale' })
  })

  it('falls back to current listing price when no completed sale', () => {
    const r = resolveAuthoritativeItemValueCents({ completedSaleAmountCents: null, currentListingPriceCents: 900, estimatedValueCents: 100 })
    expect(r).toEqual({ valueCents: 900, source: 'current_listing_price' })
  })

  it('falls back to 14C estimate when no sale or listing', () => {
    const r = resolveAuthoritativeItemValueCents({ estimatedValueCents: 100, agreementBuyoutTotalCents: 50 })
    expect(r).toEqual({ valueCents: 100, source: 'pricing_intelligence_estimate' })
  })

  it('falls back to agreement buyout total only as a last resort', () => {
    const r = resolveAuthoritativeItemValueCents({ agreementBuyoutTotalCents: 50 })
    expect(r).toEqual({ valueCents: 50, source: 'agreement_buyout_total' })
  })

  it('null when nothing is available — never fabricated, never summed', () => {
    expect(resolveAuthoritativeItemValueCents({})).toEqual({ valueCents: null, source: null })
  })
})

describe('classifyPriceDeviation — integer bps math, no float accumulation', () => {
  it('within the tolerance-expanded band is within_range', () => {
    expect(classifyPriceDeviation(10_000, 10_000, 12_000, 1500)).toBe('within_range')
    expect(classifyPriceDeviation(9_000, 10_000, 12_000, 1500)).toBe('within_range') // 10% below low, within 15% tolerance
  })

  it('beyond tolerance but within 2x tolerance is moderate_deviation', () => {
    expect(classifyPriceDeviation(8_000, 10_000, 12_000, 1500)).toBe('moderate_deviation') // 20% below low
  })

  it('beyond 2x tolerance is extreme_deviation', () => {
    expect(classifyPriceDeviation(6_400, 10_000, 12_000, 1500)).toBe('extreme_deviation') // 36% below low
  })

  it('awkward cents (e.g. $119.99 guidance) still classify deterministically', () => {
    expect(classifyPriceDeviation(11_999, 11_000, 13_500, 1500)).toBe('within_range')
    expect(classifyPriceDeviation(1, 11_999, 13_501, 1500)).toBe('extreme_deviation')
  })
})

describe('evaluateRiskPolicy — agreement_commission_override (section 6)', () => {
  it('always requires HIGH approval when the gate is enabled', () => {
    const d = evaluateRiskPolicy({
      action: 'agreement_commission_override',
      context: { agreementId: 'a1', commissionBps: 500, minimumFeeCents: 1000, reason: 'VIP seller', acceptedItemCount: 5 },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('require_approval')
    if (d.outcome !== 'require_approval') throw new Error('unreachable')
    expect(d.riskLevel).toBe('high')
    expect(d.reasons.join(' ')).toMatch(/manually overridden/)
  })

  it('allows when commercialOverridesRequireApproval is disabled by config', () => {
    const d = evaluateRiskPolicy({
      action: 'agreement_commission_override',
      context: { agreementId: 'a1', commissionBps: 500, minimumFeeCents: 0, reason: 'x', acceptedItemCount: 1 },
      policy: { ...policy, commercialOverridesRequireApproval: false }, asOf: new Date(),
    })
    expect(d.outcome).toBe('allow')
  })
})

describe('evaluateRiskPolicy — seller_commission_override (section 6)', () => {
  it('requires MEDIUM approval — a manual exception, never automatic volume-tier resolution', () => {
    const d = evaluateRiskPolicy({
      action: 'seller_commission_override',
      context: { sellerProfileId: 's1', commissionBps: 800, minimumFeeCents: null, reason: 'loyalty', effectiveFromIso: '2026-01-01T00:00:00.000Z', effectiveToIso: null },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('require_approval')
    if (d.outcome !== 'require_approval') throw new Error('unreachable')
    expect(d.riskLevel).toBe('medium')
  })
})

describe('evaluateRiskPolicy — listing_activation (section 8)', () => {
  it('allows a normal-value item automatically', () => {
    const d = evaluateRiskPolicy({
      action: 'listing_activation',
      context: { itemId: 'i1', catalogModelId: 'c1', proposedPriceCents: 5_000, estimatedValueCents: 5_000 },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('allow')
  })

  it('requires medium approval at the high-value threshold, high approval at the very-high-value threshold', () => {
    const medium = evaluateRiskPolicy({
      action: 'listing_activation',
      context: { itemId: 'i1', catalogModelId: 'c1', proposedPriceCents: 20_000, estimatedValueCents: 20_000 },
      policy, asOf: new Date(),
    })
    expect(medium.outcome).toBe('require_approval')
    if (medium.outcome !== 'require_approval') throw new Error('unreachable')
    expect(medium.riskLevel).toBe('medium')

    const high = evaluateRiskPolicy({
      action: 'listing_activation',
      context: { itemId: 'i1', catalogModelId: 'c1', proposedPriceCents: 100_000, estimatedValueCents: 100_000 },
      policy, asOf: new Date(),
    })
    expect(high.outcome).toBe('require_approval')
    if (high.outcome !== 'require_approval') throw new Error('unreachable')
    expect(high.riskLevel).toBe('high')
  })

  it('never blocks merely because no valuation is available (section 7)', () => {
    const d = evaluateRiskPolicy({
      action: 'listing_activation',
      context: { itemId: 'i1', catalogModelId: 'c1', proposedPriceCents: 5_000 },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('allow')
  })
})

describe('evaluateRiskPolicy — listing_price_change (section 7)', () => {
  const guidance = { isAskOnly: false, confidenceLevel: 'high' as const, estimatedValueCents: 12_000, recommendedLowCents: 11_000, recommendedHighCents: 13_500 }

  it('allows a price within the recommended range', () => {
    const d = evaluateRiskPolicy({
      action: 'listing_price_change',
      context: { listingId: 'l1', oldPriceCents: 12_000, proposedPriceCents: 12_500, pricing: guidance },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('allow')
  })

  it('requires approval when materially outside guidance', () => {
    const d = evaluateRiskPolicy({
      action: 'listing_price_change',
      context: { listingId: 'l1', oldPriceCents: 12_000, proposedPriceCents: 6_400, pricing: guidance },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('require_approval')
  })

  it('never treats ask-only guidance as authoritative — caps at medium even for an extreme deviation', () => {
    const askOnly = { ...guidance, isAskOnly: true }
    const d = evaluateRiskPolicy({
      action: 'listing_price_change',
      context: { listingId: 'l1', oldPriceCents: 12_000, proposedPriceCents: 1, pricing: askOnly },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('require_approval')
    if (d.outcome !== 'require_approval') throw new Error('unreachable')
    expect(d.riskLevel).toBe('medium')
    expect(d.reasons.join(' ')).toMatch(/ask-only/)
  })

  it('low/insufficient confidence also caps at medium', () => {
    const low = { ...guidance, confidenceLevel: 'insufficient' as const }
    const d = evaluateRiskPolicy({
      action: 'listing_price_change',
      context: { listingId: 'l1', oldPriceCents: 12_000, proposedPriceCents: 1, pricing: low },
      policy, asOf: new Date(),
    })
    if (d.outcome !== 'require_approval') throw new Error('unreachable')
    expect(d.riskLevel).toBe('medium')
  })

  it('no valuation available never fabricates a block', () => {
    const d = evaluateRiskPolicy({
      action: 'listing_price_change',
      context: { listingId: 'l1', oldPriceCents: 12_000, proposedPriceCents: 999, pricing: null },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('allow')
  })
})

describe('evaluateRiskPolicy — seller_payout_mark_paid (section 9)', () => {
  it('allows below the configured threshold', () => {
    const d = evaluateRiskPolicy({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 50_000, payoutStatus: 'approved', paymentMethod: 'wire', paymentReference: 'ref-1' }, policy, asOf: new Date() })
    expect(d.outcome).toBe('allow')
  })

  it('requires HIGH approval at or above the threshold', () => {
    const d = evaluateRiskPolicy({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 100_000, payoutStatus: 'approved', paymentMethod: 'wire', paymentReference: 'ref-1' }, policy, asOf: new Date() })
    expect(d.outcome).toBe('require_approval')
    if (d.outcome !== 'require_approval') throw new Error('unreachable')
    expect(d.riskLevel).toBe('high')
  })

  it('awkward cents boundary ($999.99 vs $1000.00 threshold) is exact, no float drift', () => {
    const below = evaluateRiskPolicy({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 99_999, payoutStatus: 'approved', paymentMethod: 'wire', paymentReference: 'ref-1' }, policy, asOf: new Date() })
    expect(below.outcome).toBe('allow')
  })
})

describe('evaluateRiskPolicy — item_catalog_reassignment (section 10)', () => {
  it('denies outright when the item has a completed sale — never an approval bypass', () => {
    const d = evaluateRiskPolicy({
      action: 'item_catalog_reassignment',
      context: { itemId: 'i1', oldCatalogModelId: 'c1', newCatalogModelId: 'c2', hasCompletedSale: true, completedSaleAmountCents: 5000 },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('deny')
    if (d.outcome !== 'deny') throw new Error('unreachable')
    expect(d.policyCode).toBe('item_reassignment_after_sale_denied')
  })

  it('allows a routine correction on an unsold, non-high-value item', () => {
    const d = evaluateRiskPolicy({
      action: 'item_catalog_reassignment',
      context: { itemId: 'i1', oldCatalogModelId: 'c1', newCatalogModelId: 'c2', hasCompletedSale: false, estimatedValueCents: 1_000 },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('allow')
  })

  it('requires approval for a high-value unsold item, scaling to high risk at the very-high-value threshold', () => {
    const medium = evaluateRiskPolicy({
      action: 'item_catalog_reassignment',
      context: { itemId: 'i1', oldCatalogModelId: 'c1', newCatalogModelId: 'c2', hasCompletedSale: false, estimatedValueCents: 20_000 },
      policy, asOf: new Date(),
    })
    if (medium.outcome !== 'require_approval') throw new Error('unreachable')
    expect(medium.riskLevel).toBe('medium')

    const high = evaluateRiskPolicy({
      action: 'item_catalog_reassignment',
      context: { itemId: 'i1', oldCatalogModelId: 'c1', newCatalogModelId: 'c2', hasCompletedSale: false, estimatedValueCents: 100_000 },
      policy, asOf: new Date(),
    })
    if (high.outcome !== 'require_approval') throw new Error('unreachable')
    expect(high.riskLevel).toBe('high')
  })
})

describe('evaluateRiskPolicy — determinism (section 2)', () => {
  it('same action + context + policy + asOf always returns the same decision', () => {
    const asOf = new Date('2026-06-01T00:00:00Z')
    const context = { payoutId: 'p1', totalAmountCents: 150_000, payoutStatus: 'approved', paymentMethod: 'wire', paymentReference: 'ref-1' }
    const a = evaluateRiskPolicy({ action: 'seller_payout_mark_paid', context, policy, asOf })
    const b = evaluateRiskPolicy({ action: 'seller_payout_mark_paid', context, policy, asOf })
    expect(a).toEqual(b)
  })

  it('reasons are plain explainable strings, never an opaque numeric score', () => {
    const d = evaluateRiskPolicy({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 150_000, payoutStatus: 'approved', paymentMethod: 'wire', paymentReference: 'ref-1' }, policy, asOf: new Date() })
    expect(d.reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true)
    expect(JSON.stringify(d)).not.toMatch(/riskScore|"score":\s*\d+/)
  })
})

describe('computeContextFingerprint (section 17) — deterministic binding', () => {
  it('is stable regardless of key insertion order', () => {
    const a = computeContextFingerprint('listing_price_change', 'l1', { proposedPriceCents: 1500, oldPriceCents: 2000 })
    const b = computeContextFingerprint('listing_price_change', 'l1', { oldPriceCents: 2000, proposedPriceCents: 1500 })
    expect(a).toBe(b)
  })

  it('changes when the proposed value changes — a stale approval can never authorize a different outcome', () => {
    const a = computeContextFingerprint('listing_price_change', 'l1', { oldPriceCents: 2000, proposedPriceCents: 1500 })
    const b = computeContextFingerprint('listing_price_change', 'l1', { oldPriceCents: 2000, proposedPriceCents: 500 })
    expect(a).not.toBe(b)
  })

  it('changes when the target id changes', () => {
    const a = computeContextFingerprint('listing_price_change', 'l1', { oldPriceCents: 2000, proposedPriceCents: 1500 })
    const b = computeContextFingerprint('listing_price_change', 'l2', { oldPriceCents: 2000, proposedPriceCents: 1500 })
    expect(a).not.toBe(b)
  })
})

describe('formatCents — no JS float accumulation, single rounding step', () => {
  it('formats awkward cents exactly', () => {
    expect(formatCents(1)).toBe('$0.01')
    expect(formatCents(100_000)).toBe('$1000.00')
    expect(formatCents(0)).toBe('$0.00')
  })
})

describe('15F-review section 5: per-action fingerprint completeness — a changed material input always invalidates the approval', () => {
  it('listing_price_change: worked example — $20→$15 does not authorize $18→$15 (old price changed)', () => {
    const original = computeContextFingerprint('listing_price_change', 'l1', { listingId: 'l1', oldPriceCents: 2000, proposedPriceCents: 1500, pricing: null })
    const changedOld = computeContextFingerprint('listing_price_change', 'l1', { listingId: 'l1', oldPriceCents: 1800, proposedPriceCents: 1500, pricing: null })
    expect(original).not.toBe(changedOld)
  })

  it('listing_price_change: worked example — $20→$15 does not authorize $20→$5 (proposed price changed)', () => {
    const original = computeContextFingerprint('listing_price_change', 'l1', { listingId: 'l1', oldPriceCents: 2000, proposedPriceCents: 1500, pricing: null })
    const changedProposed = computeContextFingerprint('listing_price_change', 'l1', { listingId: 'l1', oldPriceCents: 2000, proposedPriceCents: 500, pricing: null })
    expect(original).not.toBe(changedProposed)
  })

  it('listing_price_change: a changed valuation/guidance snapshot also invalidates the approval (same prices, different 14C guidance)', () => {
    const guidanceA = { isAskOnly: false, confidenceLevel: 'high' as const, estimatedValueCents: 12_000, recommendedLowCents: 11_000, recommendedHighCents: 13_000 }
    const guidanceB = { ...guidanceA, recommendedLowCents: 9_000 }
    const a = computeContextFingerprint('listing_price_change', 'l1', { listingId: 'l1', oldPriceCents: 2000, proposedPriceCents: 1500, pricing: guidanceA })
    const b = computeContextFingerprint('listing_price_change', 'l1', { listingId: 'l1', oldPriceCents: 2000, proposedPriceCents: 1500, pricing: guidanceB })
    expect(a).not.toBe(b)
  })

  it('listing_activation: a changed proposed price invalidates the approval', () => {
    const a = computeContextFingerprint('listing_activation', 'item1', { itemId: 'item1', catalogModelId: 'c1', proposedPriceCents: 30_000, estimatedValueCents: 30_000 })
    const b = computeContextFingerprint('listing_activation', 'item1', { itemId: 'item1', catalogModelId: 'c1', proposedPriceCents: 25_000, estimatedValueCents: 30_000 })
    expect(a).not.toBe(b)
  })

  it('listing_activation: a changed valuation input invalidates the approval even at the same proposed price', () => {
    const a = computeContextFingerprint('listing_activation', 'item1', { itemId: 'item1', catalogModelId: 'c1', proposedPriceCents: 30_000, estimatedValueCents: 30_000 })
    const b = computeContextFingerprint('listing_activation', 'item1', { itemId: 'item1', catalogModelId: 'c1', proposedPriceCents: 30_000, estimatedValueCents: 90_000 })
    expect(a).not.toBe(b)
  })

  it('agreement_commission_override: a changed override rate, minimum fee, or accepted quantity each invalidate the approval', () => {
    const base = { agreementId: 'a1', commissionBps: 500, minimumFeeCents: 1000, reason: 'VIP', acceptedItemCount: 5 }
    const fpBase = computeContextFingerprint('agreement_commission_override', 'a1', base)
    expect(computeContextFingerprint('agreement_commission_override', 'a1', { ...base, commissionBps: 600 })).not.toBe(fpBase)
    expect(computeContextFingerprint('agreement_commission_override', 'a1', { ...base, minimumFeeCents: 1500 })).not.toBe(fpBase)
    expect(computeContextFingerprint('agreement_commission_override', 'a1', { ...base, acceptedItemCount: 6 })).not.toBe(fpBase)
  })

  it('seller_commission_override: a changed effective date range invalidates the approval, even with identical rate/fee/reason', () => {
    const base = { sellerProfileId: 's1', commissionBps: 800, minimumFeeCents: null, reason: 'loyalty', effectiveFromIso: '2026-01-01T00:00:00.000Z', effectiveToIso: null }
    const fpBase = computeContextFingerprint('seller_commission_override', 's1', base)
    const changedFrom = computeContextFingerprint('seller_commission_override', 's1', { ...base, effectiveFromIso: '2026-02-01T00:00:00.000Z' })
    const changedTo = computeContextFingerprint('seller_commission_override', 's1', { ...base, effectiveToIso: '2026-06-01T00:00:00.000Z' })
    expect(changedFrom).not.toBe(fpBase)
    expect(changedTo).not.toBe(fpBase)
  })

  it('seller_payout_mark_paid: a changed amount OR a changed current status each invalidate the approval', () => {
    const base = { payoutId: 'p1', totalAmountCents: 150_000, payoutStatus: 'approved', paymentMethod: 'wire', paymentReference: 'ref-1' }
    const fpBase = computeContextFingerprint('seller_payout_mark_paid', 'p1', base)
    expect(computeContextFingerprint('seller_payout_mark_paid', 'p1', { ...base, totalAmountCents: 200_000 })).not.toBe(fpBase)
    expect(computeContextFingerprint('seller_payout_mark_paid', 'p1', { ...base, payoutStatus: 'paid' })).not.toBe(fpBase)
  })

  it('item_catalog_reassignment: a changed proposed catalog OR a changed current catalog each invalidate the approval', () => {
    const base = { itemId: 'i1', oldCatalogModelId: 'c1', newCatalogModelId: 'c2', hasCompletedSale: false, estimatedValueCents: 30_000 }
    const fpBase = computeContextFingerprint('item_catalog_reassignment', 'i1', base)
    expect(computeContextFingerprint('item_catalog_reassignment', 'i1', { ...base, newCatalogModelId: 'c3' })).not.toBe(fpBase)
    expect(computeContextFingerprint('item_catalog_reassignment', 'i1', { ...base, oldCatalogModelId: 'c9' })).not.toBe(fpBase)
  })

  it('catalog_model_merge: an approval for A→B does not authorize A→C or D→B (worked example from section 8)', () => {
    const base = { sourceCatalogModelId: 'A', canonicalCatalogModelId: 'B', affectedItemCount: 43, soldItemCount: 2, activeListingCount: 1, affectedCollectionCount: 0, affectedWantedCount: 0, affectedSellerSubmissionCount: 0, affectedPhotoCount: 0, affectedFingerprintCount: 0, affectedExternalObservationCount: 0 }
    const fpAB = computeContextFingerprint('catalog_model_merge', 'A', base)
    const fpAC = computeContextFingerprint('catalog_model_merge', 'A', { ...base, canonicalCatalogModelId: 'C' })
    const fpDB = computeContextFingerprint('catalog_model_merge', 'D', { ...base, sourceCatalogModelId: 'D' })
    expect(fpAB).not.toBe(fpAC)
    expect(fpAB).not.toBe(fpDB)
  })

  it('catalog_model_merge: worked example — a changed affectedItemCount (43→47) or soldItemCount (2→4) invalidates the approval', () => {
    const base = { sourceCatalogModelId: 'A', canonicalCatalogModelId: 'B', affectedItemCount: 43, soldItemCount: 2, activeListingCount: 1, affectedCollectionCount: 0, affectedWantedCount: 0, affectedSellerSubmissionCount: 0, affectedPhotoCount: 0, affectedFingerprintCount: 0, affectedExternalObservationCount: 0 }
    const fpBase = computeContextFingerprint('catalog_model_merge', 'A', base)
    expect(computeContextFingerprint('catalog_model_merge', 'A', { ...base, affectedItemCount: 47 })).not.toBe(fpBase)
    expect(computeContextFingerprint('catalog_model_merge', 'A', { ...base, soldItemCount: 4 })).not.toBe(fpBase)
  })

  it('catalog_model_merge: any other material affected-record count change also invalidates the approval', () => {
    const base = { sourceCatalogModelId: 'A', canonicalCatalogModelId: 'B', affectedItemCount: 43, soldItemCount: 2, activeListingCount: 1, affectedCollectionCount: 3, affectedWantedCount: 1, affectedSellerSubmissionCount: 2, affectedPhotoCount: 5, affectedFingerprintCount: 5, affectedExternalObservationCount: 0 }
    const fpBase = computeContextFingerprint('catalog_model_merge', 'A', base)
    expect(computeContextFingerprint('catalog_model_merge', 'A', { ...base, affectedCollectionCount: 4 })).not.toBe(fpBase)
    expect(computeContextFingerprint('catalog_model_merge', 'A', { ...base, activeListingCount: 2 })).not.toBe(fpBase)
  })
})

describe('evaluateRiskPolicy — catalog_model_merge (15F-review catalog-merge pass, section 1/4/5)', () => {
  const mergeContext = {
    sourceCatalogModelId: 'A', canonicalCatalogModelId: 'B',
    affectedItemCount: 43, soldItemCount: 0, activeListingCount: 1,
    affectedCollectionCount: 0, affectedWantedCount: 0, affectedSellerSubmissionCount: 0,
    affectedPhotoCount: 0, affectedFingerprintCount: 0, affectedExternalObservationCount: 0,
  }

  it('requires approval whenever destructiveActionsRequireApproval is enabled, even with zero affected records — the merge itself (deleting the duplicate row) is irreversible', () => {
    const d = evaluateRiskPolicy({
      action: 'catalog_model_merge',
      context: { ...mergeContext, affectedItemCount: 0 },
      policy, asOf: new Date(),
    })
    expect(d.outcome).toBe('require_approval')
  })

  it('sold-item impact escalates risk level to high; unsold-only impact is medium', () => {
    const unsold = evaluateRiskPolicy({ action: 'catalog_model_merge', context: mergeContext, policy, asOf: new Date() })
    if (unsold.outcome !== 'require_approval') throw new Error('unreachable')
    expect(unsold.riskLevel).toBe('medium')

    const sold = evaluateRiskPolicy({ action: 'catalog_model_merge', context: { ...mergeContext, soldItemCount: 2 }, policy, asOf: new Date() })
    if (sold.outcome !== 'require_approval') throw new Error('unreachable')
    expect(sold.riskLevel).toBe('high')
  })

  it('reasons are explainable prose naming the source/canonical ids and counts, never an opaque score', () => {
    const d = evaluateRiskPolicy({ action: 'catalog_model_merge', context: { ...mergeContext, soldItemCount: 2 }, policy, asOf: new Date() })
    if (d.outcome !== 'require_approval') throw new Error('unreachable')
    expect(d.reasons.join(' ')).toMatch(/43 physical item/)
    expect(d.reasons.join(' ')).toMatch(/2 of those items have completed sale history/)
    expect(JSON.stringify(d)).not.toMatch(/"score":\s*\d+/)
  })

  it('never denies solely for completed-sale involvement — a merge can correct duplicate master data while preserving real-world product identity (section 5)', () => {
    const d = evaluateRiskPolicy({ action: 'catalog_model_merge', context: { ...mergeContext, soldItemCount: 10 }, policy, asOf: new Date() })
    expect(d.outcome).not.toBe('deny')
  })

  it('when destructiveActionsRequireApproval is disabled, the engine allows — existing merge safety validations are documented as still applying unconditionally at the mutation layer', () => {
    const d = evaluateRiskPolicy({
      action: 'catalog_model_merge', context: mergeContext,
      policy: { ...policy, destructiveActionsRequireApproval: false }, asOf: new Date(),
    })
    expect(d.outcome).toBe('allow')
  })

  it('determinism: same context + policy + asOf always returns the same decision', () => {
    const asOf = new Date('2026-06-01T00:00:00Z')
    const a = evaluateRiskPolicy({ action: 'catalog_model_merge', context: mergeContext, policy, asOf })
    const b = evaluateRiskPolicy({ action: 'catalog_model_merge', context: mergeContext, policy, asOf })
    expect(a).toEqual(b)
  })
})
