import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import {
  resolveConversionEligibility,
  validateConversionConfirmation,
  calculateConsignmentPreview,
} from '@/lib/sellerAgreementInventory'
import { calculateConsignmentPayoutSnapshot } from '@/lib/sellerPayoutCalculation'

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
// 31A hotfix: this function now delegates directly to the canonical
// calculateConsignmentPayoutSnapshot (sellerPayoutCalculation.ts) — the exact
// function actual settlement uses. These tests prove preview output equals
// what the canonical calculator would produce for the same inputs.

describe('calculateConsignmentPreview', () => {
  it('calculates standard 20% commission correctly', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000',
      commissionMinimumFee: null,
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
      commissionMinimumFee: null,
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
      commissionMinimumFee: null,
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
      commissionMinimumFee: null,
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
      commissionMinimumFee: null,
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
      commissionMinimumFee: null,
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(false)
  })

  it('returns invalid for zero price', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '0',
      commissionPercent: '0.2000',
      commissionMinimumFee: null,
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(false)
  })

  it('returns invalid for non-numeric price', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: 'abc',
      commissionPercent: '0.2000',
      commissionMinimumFee: null,
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(false)
  })

  // 31A hotfix: previously this incorrectly showed estimatedProceeds=80
  // (below the minimum) with belowMinimum=true — the legacy reimplementation
  // never applied the canonical top-up. The canonical calculator GUARANTEES
  // netAmount >= minimumSellerPayout, so proceeds are now correctly topped up
  // to the minimum itself; belowMinimum now means "the top-up was applied"
  // (market-derived proceeds fell short), not "final proceeds are below it"
  // (which can no longer happen once a minimum is set).
  it('tops proceeds up to the minimum when market-derived proceeds fall short, and flags belowMinimum', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000',
      commissionMinimumFee: null,
      fixedFee: null,
      minimumSellerPayout: '100.00',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedProceeds).toBe(100)
      expect(result.belowMinimum).toBe(true)
    }
  })

  it('sets belowMinimum false when proceeds equal the minimum (no top-up needed)', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000',
      commissionMinimumFee: null,
      fixedFee: null,
      minimumSellerPayout: '80.00',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedProceeds).toBe(80)
      expect(result.belowMinimum).toBe(false)
    }
  })

  it('sets belowMinimum false when no minimum payout is set', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '50',
      commissionPercent: '0.5000',
      commissionMinimumFee: null,
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
      commissionMinimumFee: null,
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

  // 31A hotfix: commissionMinimumFee was previously not accepted/applied at
  // all in the preview — this is the core divergence being fixed.
  it('applies commissionMinimumFee as a floor on commission, exactly like settlement', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '10', // 10% of $10 = $1 commission, below the $3 floor
      commissionPercent: '0.1000',
      commissionMinimumFee: '3.00',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedCommission).toBe(3)
      expect(result.estimatedProceeds).toBe(7)
    }
  })

  it('commissionMinimumFee has no effect when the percentage commission already exceeds it', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0.2000', // $20, already above a $3 floor
      commissionMinimumFee: '3.00',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedCommission).toBe(20)
    }
  })

  it('combined commissionMinimumFee + fixedFee + minimumSellerPayout matches canonical settlement', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '20',
      commissionPercent: '0.1000', // $2 commission, below the $5 floor
      commissionMinimumFee: '5.00',
      fixedFee: '2.00',
      minimumSellerPayout: '15.00', // base = 20 - 5 - 2 = 13, tops up to 15
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedCommission).toBe(5)
      expect(result.estimatedFixedFee).toBe(2)
      expect(result.estimatedProceeds).toBe(15)
      expect(result.belowMinimum).toBe(true)
    }
  })

  it('zero-value terms (0 commission, 0 fixed fee, 0 minimum payout) behave identically to unset terms', () => {
    const result = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0',
      commissionMinimumFee: '0',
      fixedFee: '0',
      minimumSellerPayout: '0',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.estimatedCommission).toBe(0)
      expect(result.estimatedFixedFee).toBe(0)
      expect(result.estimatedProceeds).toBe(100)
      expect(result.belowMinimum).toBe(false)
    }
  })
})

// ── preview <-> canonical settlement parity ─────────────────────────────────
// 31A hotfix: direct proof that the admin preview and the canonical settlement
// calculator produce IDENTICAL results for the same gross price + terms —
// the exact regression the divergence audit flagged.

describe('calculateConsignmentPreview <-> calculateConsignmentPayoutSnapshot parity', () => {
  it('percentage commission only', () => {
    const preview = calculateConsignmentPreview({
      listingPriceStr: '150',
      commissionPercent: '0.15',
      commissionMinimumFee: null,
      fixedFee: null,
      minimumSellerPayout: null,
    })
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: 150,
      commissionPercent: new Prisma.Decimal('0.15'),
      fixedFee: null,
      minimumSellerPayout: null,
      commissionMinimumFee: null,
    })
    expect(preview.valid).toBe(true)
    if (preview.valid) {
      expect(preview.estimatedCommission).toBe(snapshot.commissionAmount.toNumber())
      expect(preview.estimatedProceeds).toBe(snapshot.netAmount.toNumber())
    }
  })

  it('commission minimum fee active', () => {
    const preview = calculateConsignmentPreview({
      listingPriceStr: '10',
      commissionPercent: '0.10',
      commissionMinimumFee: '3.00',
      fixedFee: null,
      minimumSellerPayout: null,
    })
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: 10,
      commissionPercent: new Prisma.Decimal('0.10'),
      fixedFee: null,
      minimumSellerPayout: null,
      commissionMinimumFee: new Prisma.Decimal('3.00'),
    })
    expect(preview.valid).toBe(true)
    if (preview.valid) {
      expect(preview.estimatedCommission).toBe(snapshot.commissionAmount.toNumber())
      expect(preview.estimatedProceeds).toBe(snapshot.netAmount.toNumber())
    }
  })

  it('fixed fee', () => {
    const preview = calculateConsignmentPreview({
      listingPriceStr: '80',
      commissionPercent: '0.20',
      commissionMinimumFee: null,
      fixedFee: '4.50',
      minimumSellerPayout: null,
    })
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: 80,
      commissionPercent: new Prisma.Decimal('0.20'),
      fixedFee: new Prisma.Decimal('4.50'),
      minimumSellerPayout: null,
      commissionMinimumFee: null,
    })
    expect(preview.valid).toBe(true)
    if (preview.valid) {
      expect(preview.estimatedFixedFee).toBe(snapshot.fixedFee!.toNumber())
      expect(preview.estimatedProceeds).toBe(snapshot.netAmount.toNumber())
    }
  })

  it('minimumSellerPayout top-up', () => {
    const preview = calculateConsignmentPreview({
      listingPriceStr: '50',
      commissionPercent: '0.30',
      commissionMinimumFee: null,
      fixedFee: null,
      minimumSellerPayout: '40.00',
    })
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: 50,
      commissionPercent: new Prisma.Decimal('0.30'),
      fixedFee: null,
      minimumSellerPayout: new Prisma.Decimal('40.00'),
      commissionMinimumFee: null,
    })
    expect(preview.valid).toBe(true)
    if (preview.valid) {
      expect(preview.estimatedProceeds).toBe(snapshot.netAmount.toNumber())
      expect(snapshot.minimumAdjustment.greaterThan(0)).toBe(true)
      expect(preview.belowMinimum).toBe(true)
    }
  })

  it('combined commission minimum + fixed fee + minimum payout', () => {
    const preview = calculateConsignmentPreview({
      listingPriceStr: '20',
      commissionPercent: '0.10',
      commissionMinimumFee: '5.00',
      fixedFee: '2.00',
      minimumSellerPayout: '15.00',
    })
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: 20,
      commissionPercent: new Prisma.Decimal('0.10'),
      fixedFee: new Prisma.Decimal('2.00'),
      minimumSellerPayout: new Prisma.Decimal('15.00'),
      commissionMinimumFee: new Prisma.Decimal('5.00'),
    })
    expect(preview.valid).toBe(true)
    if (preview.valid) {
      expect(preview.estimatedCommission).toBe(snapshot.commissionAmount.toNumber())
      expect(preview.estimatedFixedFee).toBe(snapshot.fixedFee!.toNumber())
      expect(preview.estimatedProceeds).toBe(snapshot.netAmount.toNumber())
    }
  })

  it('zero-value terms', () => {
    const preview = calculateConsignmentPreview({
      listingPriceStr: '100',
      commissionPercent: '0',
      commissionMinimumFee: '0',
      fixedFee: '0',
      minimumSellerPayout: '0',
    })
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: 100,
      commissionPercent: new Prisma.Decimal('0'),
      fixedFee: new Prisma.Decimal('0'),
      minimumSellerPayout: new Prisma.Decimal('0'),
      commissionMinimumFee: new Prisma.Decimal('0'),
    })
    expect(preview.valid).toBe(true)
    if (preview.valid) {
      expect(preview.estimatedProceeds).toBe(snapshot.netAmount.toNumber())
    }
  })
})

// ── structural: no second independent commission formula ───────────────────

describe('31A hotfix: admin preview has no independent commission formula', () => {
  it('calculateConsignmentPreview delegates to the canonical calculateConsignmentPayoutSnapshot — no bare arithmetic on commissionPercent/listingPrice', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/sellerAgreementInventory.ts'), 'utf-8')
    const idx = src.indexOf('export function calculateConsignmentPreview')
    const block = src.slice(idx, src.indexOf('\n}', idx))
    expect(block).toContain('calculateConsignmentPayoutSnapshot(')
    // No second commission-percentage multiplication anywhere in the function.
    expect(block).not.toMatch(/\*\s*commission\b/)
    expect(block).not.toMatch(/listingPrice\s*-/)
  })

  it('imports the canonical function from sellerPayoutCalculation.ts, not a local reimplementation', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/sellerAgreementInventory.ts'), 'utf-8')
    expect(src).toContain("import { calculateConsignmentPayoutSnapshot } from '@/lib/sellerPayoutCalculation'")
  })
})
