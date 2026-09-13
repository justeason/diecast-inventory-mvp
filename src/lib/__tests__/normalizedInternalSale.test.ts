// 21C: query-layer normalization helper for Series 22. Reads only OrderItem's
// own fields + Order.completedAt — never current ItemInstance physical state.
import { describe, it, expect } from 'vitest'
import {
  normalizeInternalSale,
  isEligibleForVariantHistory,
  isEligibleForConditionHistory,
  isValidSnapshotProvenance,
  SNAPSHOT_PROVENANCE,
  type NormalizedInternalSaleInput,
} from '@/lib/normalizedInternalSale'

function input(overrides: Partial<NormalizedInternalSaleInput> = {}): NormalizedInternalSaleInput {
  return {
    id: 'oi1',
    catalogModelId: 'cat1',
    marketVariantId: 'v1',
    snapshotPackagingType: 'carded',
    snapshotCondition: 'mint',
    snapshotProvenance: 'sale_time',
    price: 10,
    order: { status: 'complete', completedAt: new Date('2026-01-01T00:00:00Z') },
    ...overrides,
  }
}

describe('SNAPSHOT_PROVENANCE — closed set', () => {
  it('is exactly the three documented values', () => {
    expect(SNAPSHOT_PROVENANCE).toEqual(['sale_time', 'intake_declared', 'legacy_model_only'])
  })
  it('isValidSnapshotProvenance rejects anything else, including a confidence-score-style value', () => {
    expect(isValidSnapshotProvenance('sale_time')).toBe(true)
    expect(isValidSnapshotProvenance('high_confidence')).toBe(false)
    expect(isValidSnapshotProvenance(null)).toBe(false)
    expect(isValidSnapshotProvenance(undefined)).toBe(false)
  })
})

describe('normalizeInternalSale — sale_time full sale', () => {
  it('maps a fully-populated 21B-native sale straight through', () => {
    const result = normalizeInternalSale(input())
    expect(result).toEqual({
      orderItemId: 'oi1',
      catalogModelId: 'cat1',
      marketVariantId: 'v1',
      packagingType: 'carded',
      condition: 'mint',
      snapshotProvenance: 'sale_time',
      price: 10,
      soldAt: new Date('2026-01-01T00:00:00Z'),
    })
  })

  it('soldAt comes from Order.completedAt, never a duplicated OrderItem column', () => {
    const result = normalizeInternalSale(input({ order: { status: 'complete', completedAt: new Date('2026-06-01T00:00:00Z') } }))
    expect(result?.soldAt).toEqual(new Date('2026-06-01T00:00:00Z'))
  })
})

describe('normalizeInternalSale — intake_declared', () => {
  it('full intake_declared sale passes through with provenance preserved', () => {
    const result = normalizeInternalSale(input({ snapshotProvenance: 'intake_declared' }))
    expect(result?.snapshotProvenance).toBe('intake_declared')
  })

  it('partial intake_declared sale (packaging known, condition unknown) is not rejected', () => {
    const result = normalizeInternalSale(input({ snapshotProvenance: 'intake_declared', snapshotCondition: null }))
    expect(result).not.toBeNull()
    expect(result?.packagingType).toBe('carded')
    expect(result?.condition).toBeNull()
  })
})

describe('normalizeInternalSale — legacy_model_only', () => {
  it('a model-only sale has null packaging/condition/variant but is still emitted', () => {
    const result = normalizeInternalSale(input({
      snapshotProvenance: 'legacy_model_only', marketVariantId: null, snapshotPackagingType: null, snapshotCondition: null,
    }))
    expect(result).not.toBeNull()
    expect(result?.marketVariantId).toBeNull()
    expect(result?.packagingType).toBeNull()
    expect(result?.condition).toBeNull()
    expect(result?.catalogModelId).toBe('cat1')
  })
})

describe('normalizeInternalSale — malformed rows are excluded (§35)', () => {
  it('rejects a non-complete order', () => {
    expect(normalizeInternalSale(input({ order: { status: 'paid', completedAt: null } }))).toBeNull()
  })
  it('rejects a complete order with null completedAt', () => {
    expect(normalizeInternalSale(input({ order: { status: 'complete', completedAt: null } }))).toBeNull()
  })
  it('rejects a null catalogModelId', () => {
    expect(normalizeInternalSale(input({ catalogModelId: null }))).toBeNull()
  })
  it('rejects non-positive price', () => {
    expect(normalizeInternalSale(input({ price: 0 }))).toBeNull()
    expect(normalizeInternalSale(input({ price: -1 }))).toBeNull()
  })
  it('rejects a null/invalid snapshotProvenance — not yet normalized rows are not silently treated as model-only', () => {
    expect(normalizeInternalSale(input({ snapshotProvenance: null }))).toBeNull()
    expect(normalizeInternalSale(input({ snapshotProvenance: 'garbage' }))).toBeNull()
  })
})

describe('normalizeInternalSale — never reads current ItemInstance (structural)', () => {
  it('the input type has no item/ItemInstance field at all', () => {
    const value = input()
    expect(Object.keys(value)).not.toContain('item')
    expect(Object.keys(value)).not.toContain('itemInstance')
  })
})

describe('variant/condition history eligibility (§36/§37)', () => {
  it('variant history requires BOTH marketVariantId and packagingType', () => {
    const full = normalizeInternalSale(input())!
    expect(isEligibleForVariantHistory(full)).toBe(true)

    const modelOnly = normalizeInternalSale(input({
      snapshotProvenance: 'legacy_model_only', marketVariantId: null, snapshotPackagingType: null, snapshotCondition: null,
    }))!
    expect(isEligibleForVariantHistory(modelOnly)).toBe(false)
  })

  it('condition history requires only snapshotCondition, independent of packaging', () => {
    const conditionOnly = normalizeInternalSale(input({
      snapshotProvenance: 'intake_declared', marketVariantId: null, snapshotPackagingType: null, snapshotCondition: 'good',
    }))!
    expect(isEligibleForConditionHistory(conditionOnly)).toBe(true)
    expect(isEligibleForVariantHistory(conditionOnly)).toBe(false)
  })

  it('both sale_time and intake_declared sales may satisfy variant/condition eligibility — provenance is exposed, not gate-kept here', () => {
    const saleTime = normalizeInternalSale(input({ snapshotProvenance: 'sale_time' }))!
    const declared = normalizeInternalSale(input({ snapshotProvenance: 'intake_declared' }))!
    expect(isEligibleForVariantHistory(saleTime)).toBe(true)
    expect(isEligibleForVariantHistory(declared)).toBe(true)
    expect(saleTime.snapshotProvenance).not.toBe(declared.snapshotProvenance)
  })
})
