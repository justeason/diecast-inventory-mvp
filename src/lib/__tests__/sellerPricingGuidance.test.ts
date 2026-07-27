import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  computeGuidance,
  isSubmissionPricingLocked,
  type GuidanceInput,
  type ConsignmentTerms,
} from '@/lib/sellerPricingGuidance'
import type { EstimateResult } from '@/lib/resaleEstimator'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEstimate(overrides: Partial<EstimateResult> = {}): EstimateResult {
  return {
    estimatedPrice: 1000,
    lowPrice: 800,
    highPrice: 1200,
    estimatedDaysToSell: 14,
    confidence: 'medium',
    matchLevel: 'exact',
    comparableCount: 5,
    comparables: [
      { orderItemId: 'oi-1', soldPriceCents: 800, daysToSell: 7 },
      { orderItemId: 'oi-2', soldPriceCents: 900, daysToSell: 10 },
      { orderItemId: 'oi-3', soldPriceCents: 1000, daysToSell: 14 },
      { orderItemId: 'oi-4', soldPriceCents: 1100, daysToSell: 21 },
      { orderItemId: 'oi-5', soldPriceCents: 1200, daysToSell: 30 },
    ],
    warnings: [],
    ...overrides,
  }
}

function noEstimate(): EstimateResult {
  return {
    estimatedPrice: null,
    lowPrice: null,
    highPrice: null,
    estimatedDaysToSell: null,
    confidence: 'insufficient',
    matchLevel: 'insufficient',
    comparableCount: 0,
    comparables: [],
    warnings: ['No comparable sales found.'],
  }
}

function consignment(overrides: Partial<ConsignmentTerms> = {}): ConsignmentTerms {
  return {
    commissionPercent: new Prisma.Decimal('0.20'),
    fixedFee: null,
    minimumSellerPayout: null,
    ...overrides,
  }
}

function input(overrides: Partial<GuidanceInput> = {}): GuidanceInput {
  return {
    strategy: 'sell_fast',
    estimateResult: makeEstimate(),
    ...overrides,
  }
}

// ── sell_fast strategy ────────────────────────────────────────────────────────

describe('sell_fast strategy', () => {
  it('uses lowPrice as target', () => {
    const result = computeGuidance(input({ strategy: 'sell_fast' }))
    expect(result.targetPriceCents).toBe(800)
  })

  it('derives days from comparables at or below lowPrice', () => {
    // Only soldPriceCents=800 (daysToSell=7) is <= 800
    const result = computeGuidance(input({ strategy: 'sell_fast' }))
    expect(result.estimatedDaysToSell).toBe(7)
  })

  it('falls back to overall estimatedDaysToSell if no band comps', () => {
    const er = makeEstimate({
      lowPrice: 500,
      comparables: [
        { orderItemId: 'oi-1', soldPriceCents: 800, daysToSell: 10 },
        { orderItemId: 'oi-2', soldPriceCents: 900, daysToSell: 20 },
      ],
      estimatedDaysToSell: 15,
    })
    const result = computeGuidance(input({ strategy: 'sell_fast', estimateResult: er }))
    expect(result.estimatedDaysToSell).toBe(15)
  })

  it('returns null targetPrice when estimate has no lowPrice', () => {
    const result = computeGuidance(input({ strategy: 'sell_fast', estimateResult: noEstimate() }))
    expect(result.targetPriceCents).toBeNull()
  })

  it('skips daysToSell nulls in band', () => {
    const er = makeEstimate({
      lowPrice: 900,
      comparables: [
        { orderItemId: 'oi-1', soldPriceCents: 800, daysToSell: null },
        { orderItemId: 'oi-2', soldPriceCents: 900, daysToSell: 12 },
      ],
      estimatedDaysToSell: 20,
    })
    const result = computeGuidance(input({ strategy: 'sell_fast', estimateResult: er }))
    expect(result.estimatedDaysToSell).toBe(12)
  })
})

// ── maximize_proceeds strategy ────────────────────────────────────────────────

describe('maximize_proceeds strategy', () => {
  it('uses highPrice as target', () => {
    const result = computeGuidance(input({ strategy: 'maximize_proceeds' }))
    expect(result.targetPriceCents).toBe(1200)
  })

  it('derives days from comparables at or above highPrice', () => {
    // Only soldPriceCents=1200 (daysToSell=30) is >= 1200
    const result = computeGuidance(input({ strategy: 'maximize_proceeds' }))
    expect(result.estimatedDaysToSell).toBe(30)
  })

  it('falls back to overall estimatedDaysToSell if no band comps', () => {
    const er = makeEstimate({
      highPrice: 9999_00,
      comparables: [
        { orderItemId: 'oi-1', soldPriceCents: 800, daysToSell: 5 },
      ],
      estimatedDaysToSell: 14,
    })
    const result = computeGuidance(input({ strategy: 'maximize_proceeds', estimateResult: er }))
    expect(result.estimatedDaysToSell).toBe(14)
  })

  it('returns null targetPrice when estimate has no highPrice', () => {
    const result = computeGuidance(input({ strategy: 'maximize_proceeds', estimateResult: noEstimate() }))
    expect(result.targetPriceCents).toBeNull()
  })
})

// ── custom strategy ───────────────────────────────────────────────────────────

describe('custom strategy', () => {
  it('uses customTargetCents as targetPriceCents', () => {
    const result = computeGuidance(input({ strategy: 'custom', customTargetCents: 950 }))
    expect(result.targetPriceCents).toBe(950)
  })

  it('returns targetPriceCents null when no customTargetCents provided', () => {
    const result = computeGuidance(input({ strategy: 'custom', customTargetCents: null }))
    expect(result.targetPriceCents).toBeNull()
  })

  it('warns when custom price is below comparable range', () => {
    const result = computeGuidance(input({ strategy: 'custom', customTargetCents: 100 }))
    expect(result.warnings.some((w) => w.includes('outside the observed comparable range'))).toBe(true)
  })

  it('warns when custom price is above comparable range', () => {
    const result = computeGuidance(input({ strategy: 'custom', customTargetCents: 9999_00 }))
    expect(result.warnings.some((w) => w.includes('outside the observed comparable range'))).toBe(true)
  })

  it('does not warn when custom price is within range', () => {
    const result = computeGuidance(input({ strategy: 'custom', customTargetCents: 1000 }))
    expect(result.warnings.some((w) => w.includes('outside the observed comparable range'))).toBe(false)
  })

  it('does not warn about range when no estimate exists', () => {
    const result = computeGuidance(input({
      strategy: 'custom',
      customTargetCents: 100,
      estimateResult: noEstimate(),
    }))
    expect(result.warnings.some((w) => w.includes('outside the observed comparable range'))).toBe(false)
  })

  it('derives days from nearest-price comparables', () => {
    // price=1000 → nearest 5 by abs distance: 800(d=7),900(d=10),1000(d=14),1100(d=21),1200(d=30)
    // median of [7,10,14,21,30] sorted = 14
    const result = computeGuidance(input({ strategy: 'custom', customTargetCents: 1000 }))
    expect(result.estimatedDaysToSell).toBe(14)
  })

  it('returns estimatedDaysToSell null when no comparables have daysToSell', () => {
    const er = makeEstimate({
      comparables: [
        { orderItemId: 'oi-1', soldPriceCents: 1000, daysToSell: null },
      ],
      estimatedDaysToSell: null,
    })
    const result = computeGuidance(input({
      strategy: 'custom',
      customTargetCents: 1000,
      estimateResult: er,
    }))
    expect(result.estimatedDaysToSell).toBeNull()
  })
})

// ── seller proceeds ───────────────────────────────────────────────────────────

describe('estimated seller proceeds', () => {
  it('computes proceeds for consignment with 20% commission', () => {
    // sell_fast target = lowPrice = 800 cents = $8.00, 20% commission → $8.00 * 0.80 = $6.40 = 640 cents
    const result = computeGuidance(input({
      strategy: 'sell_fast',
      consignmentTerms: consignment({ commissionPercent: new Prisma.Decimal('0.20') }),
    }))
    expect(result.estimatedSellerProceedsCents).toBe(640)
  })

  it('returns null proceeds when no consignment terms', () => {
    const result = computeGuidance(input({ strategy: 'sell_fast' }))
    expect(result.estimatedSellerProceedsCents).toBeNull()
  })

  it('returns null proceeds when consignmentTerms is null', () => {
    const result = computeGuidance(input({ strategy: 'sell_fast', consignmentTerms: null }))
    expect(result.estimatedSellerProceedsCents).toBeNull()
  })

  it('returns null proceeds when targetPriceCents is null', () => {
    const result = computeGuidance(input({
      strategy: 'sell_fast',
      estimateResult: noEstimate(),
      consignmentTerms: consignment(),
    }))
    expect(result.estimatedSellerProceedsCents).toBeNull()
  })

  it('does not produce $0.00 as a suggestion when targetPrice is valid', () => {
    const result = computeGuidance(input({
      strategy: 'sell_fast',
      consignmentTerms: consignment(),
    }))
    expect(result.estimatedSellerProceedsCents).toBeGreaterThan(0)
  })
})

// ── output shape ──────────────────────────────────────────────────────────────

describe('output shape', () => {
  it('does not include order/buyer/comparable details in output', () => {
    const result = computeGuidance(input())
    const keys = Object.keys(result)
    expect(keys).not.toContain('comparables')
    expect(keys).not.toContain('orderItemId')
    expect(keys).not.toContain('buyerProfileId')
    expect(keys).not.toContain('sku')
  })

  it('passes through confidence from estimateResult', () => {
    const result = computeGuidance(input({ estimateResult: makeEstimate({ confidence: 'high' }) }))
    expect(result.confidence).toBe('high')
  })

  it('passes through matchLevel from estimateResult', () => {
    const result = computeGuidance(input({ estimateResult: makeEstimate({ matchLevel: 'model_family' }) }))
    expect(result.matchLevel).toBe('model_family')
  })

  it('passes through comparableCount from estimateResult', () => {
    const result = computeGuidance(input({ estimateResult: makeEstimate({ comparableCount: 12 }) }))
    expect(result.comparableCount).toBe(12)
  })

  it('preserves estimateResult warnings', () => {
    const er = makeEstimate({ warnings: ['Extended history used.'] })
    const result = computeGuidance(input({ strategy: 'custom', customTargetCents: 100, estimateResult: er }))
    expect(result.warnings).toContain('Extended history used.')
  })
})

// ── isSubmissionPricingLocked ─────────────────────────────────────────────────

describe('isSubmissionPricingLocked', () => {
  it('returns false with no agreements and no intake drafts', () => {
    expect(isSubmissionPricingLocked({ agreements: [], intakeDrafts: [] })).toBe(false)
  })

  it('returns false when agreement exists but is not accepted', () => {
    expect(isSubmissionPricingLocked({
      agreements: [{ status: 'proposed' }],
      intakeDrafts: [],
    })).toBe(false)
  })

  it('returns false when intake draft has no converted item', () => {
    expect(isSubmissionPricingLocked({
      agreements: [],
      intakeDrafts: [{ convertedItemId: null }],
    })).toBe(false)
  })

  it('returns true when any agreement has status accepted', () => {
    expect(isSubmissionPricingLocked({
      agreements: [{ status: 'accepted' }],
      intakeDrafts: [],
    })).toBe(true)
  })

  it('returns true when any intake draft has a convertedItemId', () => {
    expect(isSubmissionPricingLocked({
      agreements: [],
      intakeDrafts: [{ convertedItemId: 'item-abc' }],
    })).toBe(true)
  })

  it('returns true when mixed: one accepted agreement among others', () => {
    expect(isSubmissionPricingLocked({
      agreements: [{ status: 'cancelled' }, { status: 'accepted' }],
      intakeDrafts: [],
    })).toBe(true)
  })

  it('returns true when both agreement and intake draft trigger lock', () => {
    expect(isSubmissionPricingLocked({
      agreements: [{ status: 'accepted' }],
      intakeDrafts: [{ convertedItemId: 'item-xyz' }],
    })).toBe(true)
  })

  // Documents the shared DB gate used by all three lock-acquiring actions:
  //   saveSellerPricingPreference  – locks then re-reads, aborts upsert if locked
  //   recordSellerAgreementAcceptance – locks then re-validates status, updates
  //   convertDraft                 – locks before commercial provenance + intakeDraft update
  // All three acquire: SELECT id FROM "SellerSubmission" WHERE id = ? FOR UPDATE
  // inside a $transaction, serializing concurrent writes on the same submission.

  it('lock gate: agreement acceptance committed concurrently makes state appear locked', () => {
    // State that arrives in the re-read after a concurrent acceptance commits
    expect(isSubmissionPricingLocked({
      agreements: [{ status: 'accepted' }],
      intakeDrafts: [],
    })).toBe(true)
  })

  it('lock gate: inventory conversion committed concurrently makes state appear locked', () => {
    // convertedItemId is non-null only when intakeDraft.update({ convertedItemId: item.id })
    // has committed — i.e., actual ItemInstance was created, not merely draft existence
    expect(isSubmissionPricingLocked({
      agreements: [],
      intakeDrafts: [{ convertedItemId: 'item-real-id' }],
    })).toBe(true)
  })

  it('lock gate: unconverted intake draft (convertedItemId null) does not block save', () => {
    // Draft exists but conversion has not completed — convertedItemId is still null
    expect(isSubmissionPricingLocked({
      agreements: [],
      intakeDrafts: [{ convertedItemId: null }],
    })).toBe(false)
  })

  it('detects acceptance committed between eager check and transaction (concurrent acceptance simulation)', () => {
    // Before acceptance: unlocked
    expect(isSubmissionPricingLocked({
      agreements: [{ status: 'proposed' }],
      intakeDrafts: [],
    })).toBe(false)
    // After concurrent acceptance committed: transaction re-read returns accepted → locked
    expect(isSubmissionPricingLocked({
      agreements: [{ status: 'accepted' }],
      intakeDrafts: [],
    })).toBe(true)
  })
})
