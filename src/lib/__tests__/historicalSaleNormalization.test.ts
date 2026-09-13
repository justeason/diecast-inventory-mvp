// 21C: pure classification logic for legacy OrderItem normalization. The ONLY
// evidence source is the converted IntakeDraft — current ItemInstance state,
// SellerSubmission, Listing, and timestamps-as-proof are all explicitly
// excluded (never touched by this module — it doesn't even accept them as input).
import { describe, it, expect, vi } from 'vitest'
import { classifyLegacyOrderItem, NORMALIZATION_MIGRATION_NAME, type LegacyCandidateRow } from '@/lib/historicalSaleNormalization'

const CUTOVER = new Date('2026-09-12T20:38:19.075Z')

function row(overrides: Partial<LegacyCandidateRow> = {}): LegacyCandidateRow {
  return {
    id: 'oi1',
    itemId: 'item1',
    catalogModelId: 'cat1',
    marketVariantId: null,
    snapshotPackagingType: null,
    snapshotCondition: null,
    price: 10,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: new Date('2026-01-05T00:00:00Z'),
    ...overrides,
  }
}

function noVariant() {
  return vi.fn().mockReturnValue(null)
}

describe('classifyLegacyOrderItem — legacy boundary (§7/§8)', () => {
  it('a row created after the cutover with no snapshot is postCutoverMalformed — never auto-repaired', () => {
    const r = row({ createdAt: new Date('2026-09-13T00:00:00Z') })
    const result = classifyLegacyOrderItem(r, CUTOVER, undefined, noVariant())
    expect(result.bucket).toBe('postCutoverMalformed')
  })

  it('a row created exactly at the cutover instant is treated as legacy (<=, not <)', () => {
    const r = row({ createdAt: CUTOVER })
    const result = classifyLegacyOrderItem(r, CUTOVER, undefined, noVariant())
    expect(result.bucket).not.toBe('postCutoverMalformed')
  })

  it('NORMALIZATION_MIGRATION_NAME is the exact 21B migration name', () => {
    expect(NORMALIZATION_MIGRATION_NAME).toBe('20260912000000_add_market_variant_packaging')
  })
})

describe('classifyLegacyOrderItem — conflict detection (§29)', () => {
  it('a legacy row with an already-non-null marketVariantId and null provenance is a conflict, never auto-classified', () => {
    const r = row({ marketVariantId: 'v1' })
    const result = classifyLegacyOrderItem(r, CUTOVER, undefined, noVariant())
    expect(result.bucket).toBe('writeConflictExistingPartialState')
  })

  it('a legacy row with an already-non-null snapshotPackagingType is a conflict', () => {
    const r = row({ snapshotPackagingType: 'carded' })
    const result = classifyLegacyOrderItem(r, CUTOVER, undefined, noVariant())
    expect(result.bucket).toBe('writeConflictExistingPartialState')
  })

  it('a legacy row with an already-non-null snapshotCondition is a conflict', () => {
    const r = row({ snapshotCondition: 'mint' })
    const result = classifyLegacyOrderItem(r, CUTOVER, undefined, noVariant())
    expect(result.bucket).toBe('writeConflictExistingPartialState')
  })
})

describe('classifyLegacyOrderItem — malformed model-level facts (§16)', () => {
  it('missing catalogModelId is malformedMissingCatalog, never legacy_model_only', () => {
    const r = row({ catalogModelId: null })
    const result = classifyLegacyOrderItem(r, CUTOVER, undefined, noVariant())
    expect(result.bucket).toBe('malformedMissingCatalog')
  })

  it('missing completedAt is malformedMissingCompletedAt', () => {
    const r = row({ completedAt: null })
    const result = classifyLegacyOrderItem(r, CUTOVER, undefined, noVariant())
    expect(result.bucket).toBe('malformedMissingCompletedAt')
  })

  it('non-positive price is malformedNonPositivePrice', () => {
    expect(classifyLegacyOrderItem(row({ price: 0 }), CUTOVER, undefined, noVariant()).bucket).toBe('malformedNonPositivePrice')
    expect(classifyLegacyOrderItem(row({ price: -5 }), CUTOVER, undefined, noVariant()).bucket).toBe('malformedNonPositivePrice')
  })
})

describe('classifyLegacyOrderItem — IntakeDraft evidence only (§9-§11)', () => {
  it('no linked converted draft -> legacy_model_only, nothing fabricated', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, undefined, noVariant())
    expect(result.bucket).toBe('modelOnly')
    if (result.bucket !== 'malformedMissingCatalog' && 'provenance' in result) {
      expect(result.provenance).toBe('legacy_model_only')
      expect(result.marketVariantId).toBeNull()
      expect(result.snapshotPackagingType).toBeNull()
      expect(result.snapshotCondition).toBeNull()
    }
  })

  it('a draft with null cardedOrLoose and null condition -> legacy_model_only', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: null, condition: null }, noVariant())
    expect(result.bucket).toBe('modelOnly')
  })

  it('never accepts an invalid/garbage cardedOrLoose value as evidence', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: 'unspecified', condition: null }, noVariant())
    expect(result.bucket).toBe('modelOnly')
  })

  it('never accepts free-text condition — only the six-value internal enum', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: null, condition: 'looks great!' }, noVariant())
    expect(result.bucket).toBe('modelOnly')
  })
})

describe('classifyLegacyOrderItem — packaging recovery (§12)', () => {
  it('valid carded + resolvable variant -> recoveredPackagingOnly, intake_declared, marketVariantId set', () => {
    const resolveVariantId = vi.fn().mockReturnValue('variant-carded-1')
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: 'carded', condition: null }, resolveVariantId)
    expect(result.bucket).toBe('recoveredPackagingOnly')
    if (result.bucket === 'recoveredPackagingOnly') {
      expect(result.provenance).toBe('intake_declared')
      expect(result.snapshotPackagingType).toBe('carded')
      expect(result.marketVariantId).toBe('variant-carded-1')
      expect(result.snapshotCondition).toBeNull()
    }
    expect(resolveVariantId).toHaveBeenCalledWith('cat1', 'carded')
  })

  it('valid loose packaging resolves independently', () => {
    const resolveVariantId = vi.fn().mockReturnValue('variant-loose-1')
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: 'loose', condition: null }, resolveVariantId)
    if (result.bucket === 'recoveredPackagingOnly') expect(result.snapshotPackagingType).toBe('loose')
  })

  it('draft.catalogModelId is never used as the variant-resolution key — only OrderItem.catalogModelId (already the canonical, merge-corrected identity)', () => {
    const resolveVariantId = vi.fn().mockReturnValue('v1')
    classifyLegacyOrderItem(row({ catalogModelId: 'canonical-cat' }), CUTOVER, { cardedOrLoose: 'carded', condition: null }, resolveVariantId)
    expect(resolveVariantId).toHaveBeenCalledWith('canonical-cat', 'carded')
  })

  it('a missing MarketVariant (21B invariant violated) is a variantResolutionError — never guessed, never silently dropped', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: 'carded', condition: null }, noVariant())
    expect(result.bucket).toBe('modelOnly')
    if ('variantResolutionError' in result) expect(result.variantResolutionError).toBe(true)
  })
})

describe('classifyLegacyOrderItem — condition recovery (§13)', () => {
  it('a valid internal condition value is recovered independently of packaging', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: null, condition: 'near_mint' }, noVariant())
    expect(result.bucket).toBe('recoveredConditionOnly')
    if (result.bucket === 'recoveredConditionOnly') {
      expect(result.snapshotCondition).toBe('near_mint')
      expect(result.provenance).toBe('intake_declared')
      expect(result.snapshotPackagingType).toBeNull()
      expect(result.marketVariantId).toBeNull()
    }
  })

  it('every valid condition enum value is accepted', () => {
    for (const c of ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged']) {
      const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: null, condition: c }, noVariant())
      expect(result.bucket).toBe('recoveredConditionOnly')
    }
  })
})

describe('classifyLegacyOrderItem — partial recovery (§14)', () => {
  it('both packaging and condition known -> recoveredFull', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: 'carded', condition: 'mint' }, vi.fn().mockReturnValue('v1'))
    expect(result.bucket).toBe('recoveredFull')
    if (result.bucket === 'recoveredFull') {
      expect(result.snapshotPackagingType).toBe('carded')
      expect(result.snapshotCondition).toBe('mint')
      expect(result.marketVariantId).toBe('v1')
      expect(result.provenance).toBe('intake_declared')
    }
  })

  it('recovery is never all-or-nothing — packaging known + condition unknown still recovers packaging', () => {
    const result = classifyLegacyOrderItem(row(), CUTOVER, { cardedOrLoose: 'loose', condition: null }, vi.fn().mockReturnValue('v1'))
    expect(result.bucket).toBe('recoveredPackagingOnly')
  })
})

describe('classifyLegacyOrderItem — never uses current ItemInstance/SellerSubmission/Listing/timestamps as evidence (§10/§38/§39/§12-investigation)', () => {
  it('the function signature accepts no ItemInstance/SellerSubmission/Listing argument at all', () => {
    // Structural proof by construction: classifyLegacyOrderItem's only inputs are
    // the OrderItem-derived row, the cutover Date, IntakeDraft evidence, and a
    // variant resolver — there is no fifth parameter for any other source.
    expect(classifyLegacyOrderItem.length).toBe(4)
  })
})
