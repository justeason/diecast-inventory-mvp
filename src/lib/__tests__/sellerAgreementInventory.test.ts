import { describe, it, expect } from 'vitest'
import {
  resolveConversionEligibility,
  validateConversionConfirmation,
  calculateConsignmentPreview,
} from '@/lib/sellerAgreementInventory'

// ── resolveConversionEligibility ──────────────────────────────────────────────

describe('resolveConversionEligibility', () => {
  it('returns company_owned when no sellerSubmissionId', () => {
    const result = resolveConversionEligibility(null, [])
    expect(result.eligible).toBe(true)
    if (result.eligible) {
      expect(result.sourceType).toBe('company_owned')
      expect(result.acceptedAgreementId).toBeNull()
    }
  })

  it('blocks when seller-sourced with no agreements at all', () => {
    const result = resolveConversionEligibility('sub_1', [])
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).toMatch(/required/)
  })

  it('blocks when only cancelled agreements exist', () => {
    const result = resolveConversionEligibility('sub_1', [
      { id: 'a1', type: 'buyout', status: 'cancelled' },
    ])
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).toMatch(/cancelled/)
  })

  it('blocks when agreement is draft', () => {
    const result = resolveConversionEligibility('sub_1', [
      { id: 'a1', type: 'buyout', status: 'draft' },
    ])
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).toMatch(/draft/)
  })

  it('blocks when agreement is proposed', () => {
    const result = resolveConversionEligibility('sub_1', [
      { id: 'a1', type: 'consignment', status: 'proposed' },
    ])
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).toMatch(/acceptance/)
  })

  it('blocks when multiple active agreements exist', () => {
    const result = resolveConversionEligibility('sub_1', [
      { id: 'a1', type: 'buyout', status: 'accepted' },
      { id: 'a2', type: 'consignment', status: 'proposed' },
    ])
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).toMatch(/Multiple/)
  })

  it('blocks when agreement type is unsupported', () => {
    const result = resolveConversionEligibility('sub_1', [
      { id: 'a1', type: 'unknown_type', status: 'accepted' },
    ])
    expect(result.eligible).toBe(false)
    if (!result.eligible) expect(result.reason).toMatch(/Unsupported/)
  })

  it('returns buyout sourceType for accepted buyout agreement', () => {
    const result = resolveConversionEligibility('sub_1', [
      { id: 'a1', type: 'buyout', status: 'accepted' },
    ])
    expect(result.eligible).toBe(true)
    if (result.eligible) {
      expect(result.sourceType).toBe('buyout')
      expect(result.acceptedAgreementId).toBe('a1')
    }
  })

  it('returns consignment sourceType for accepted consignment agreement', () => {
    const result = resolveConversionEligibility('sub_1', [
      { id: 'a2', type: 'consignment', status: 'accepted' },
    ])
    expect(result.eligible).toBe(true)
    if (result.eligible) {
      expect(result.sourceType).toBe('consignment')
      expect(result.acceptedAgreementId).toBe('a2')
    }
  })
})

// ── validateConversionConfirmation ────────────────────────────────────────────

describe('validateConversionConfirmation', () => {
  it('company_owned requires no confirmation', () => {
    const result = validateConversionConfirmation('company_owned', null, null)
    expect(result.valid).toBe(true)
  })

  it('buyout blocks when confirmation missing', () => {
    const result = validateConversionConfirmation('buyout', null, null)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toMatch(/buyout amount/)
  })

  it('buyout passes when confirmation present', () => {
    const result = validateConversionConfirmation('buyout', 'on', null)
    expect(result.valid).toBe(true)
  })

  it('consignment blocks when confirmation missing', () => {
    const result = validateConversionConfirmation('consignment', null, null)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toMatch(/seller-owned/)
  })

  it('consignment passes when confirmation present', () => {
    const result = validateConversionConfirmation('consignment', null, 'on')
    expect(result.valid).toBe(true)
  })
})

// ── calculateConsignmentPreview ───────────────────────────────────────────────

describe('calculateConsignmentPreview', () => {
  it('calculates standard 20% commission correctly', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.listingPrice).toBe(100)
      expect(result.estimatedCommission).toBe(20)
      expect(result.estimatedFixedFee).toBe(0)
      expect(result.estimatedProceeds).toBe(80)
      expect(result.belowMinimum).toBe(false)
    }
  })

  it('deducts fixed fee from proceeds', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000',
      fixedFee: '5.00',
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedFixedFee).toBe(5)
      expect(result.estimatedProceeds).toBe(75)
    }
  })

  it('handles zero commission', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.0000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedCommission).toBe(0)
      expect(result.estimatedProceeds).toBe(100)
    }
  })

  it('handles 100% commission', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '1.0000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedProceeds).toBe(0)
    }
  })

  it('rounds to currency cents', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '9.99',
      commissionPercent: '0.1000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedCommission).toBe(1)
      expect(result.estimatedProceeds).toBe(8.99)
    }
  })

  it('returns invalid for blank price', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '',
      commissionPercent: '0.2000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(false)
  })

  it('returns invalid for zero price', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '0',
      commissionPercent: '0.2000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(false)
  })

  it('returns invalid for non-numeric price', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: 'abc',
      commissionPercent: '0.2000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(false)
  })

  it('sets belowMinimum true when proceeds are below the minimum', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000',
      fixedFee: null,
      minimumSellerPayout: '100.00',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedProceeds).toBe(80)
      expect(result.belowMinimum).toBe(true)
    }
  })

  it('sets belowMinimum false when proceeds equal the minimum', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000',
      fixedFee: null,
      minimumSellerPayout: '80.00',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.belowMinimum).toBe(false)
    }
  })

  it('sets belowMinimum false when no minimum payout is set', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '50',
      commissionPercent: '0.5000',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.belowMinimum).toBe(false)
    }
  })

  it('handles large amounts correctly', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '10000',
      commissionPercent: '0.2500',
      fixedFee: '50.00',
      minimumSellerPayout: '7000.00',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedCommission).toBe(2500)
      expect(result.estimatedFixedFee).toBe(50)
      expect(result.estimatedProceeds).toBe(7450)
      expect(result.belowMinimum).toBe(false)
    }
  })
})
