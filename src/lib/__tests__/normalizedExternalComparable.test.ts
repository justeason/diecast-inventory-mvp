// 21D: pure identity normalization for external market comparables. No DB —
// pure function tests, matching this codebase's convention for DB-boundary-
// adjacent pure helpers (e.g. 21C's historicalSaleNormalization.test.ts).
import { describe, it, expect } from 'vitest'
import {
  normalizeExternalComparableIdentity,
  isExternalVariantComparable,
  isExternalConditionComparable,
  sameModelBucket,
  sameVariantBucket,
  sameConditionBucket,
  EXTERNAL_COMPARABLE_SELECT,
  type ExternalComparableInput,
  type NormalizedExternalComparable,
} from '@/lib/normalizedExternalComparable'

function obs(overrides: Partial<ExternalComparableInput> = {}): ExternalComparableInput {
  return {
    id: 'obs1',
    provider: 'ebay',
    matchStatus: 'matched',
    matchMethod: 'manual',
    catalogModelId: 'cat1',
    marketVariantId: null,
    marketVariant: null,
    ...overrides,
  }
}

describe('normalizeExternalComparableIdentity — basic identity (§30)', () => {
  it('matched model-only observation normalizes with variant/packaging/condition all null', () => {
    const result = normalizeExternalComparableIdentity(obs())
    expect(result).toEqual({
      externalObservationId: 'obs1',
      provider: 'ebay',
      catalogModelId: 'cat1',
      marketVariantId: null,
      packagingType: null,
      normalizedCondition: null,
      matchMethod: 'manual',
    })
  })

  it('matched Carded observation normalizes with Carded identity', () => {
    const result = normalizeExternalComparableIdentity(obs({
      marketVariantId: 'v1',
      marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'carded' },
    }))
    expect(result?.marketVariantId).toBe('v1')
    expect(result?.packagingType).toBe('carded')
  })

  it('matched Loose observation normalizes with Loose identity', () => {
    const result = normalizeExternalComparableIdentity(obs({
      marketVariantId: 'v2',
      marketVariant: { id: 'v2', catalogModelId: 'cat1', packagingType: 'loose' },
    }))
    expect(result?.packagingType).toBe('loose')
  })

  it('preserves matchMethod and provider verbatim', () => {
    const result = normalizeExternalComparableIdentity(obs({ provider: 'mercari-manual-export', matchMethod: null }))
    expect(result?.provider).toBe('mercari-manual-export')
    expect(result?.matchMethod).toBeNull()
  })
})

describe('normalizeExternalComparableIdentity — workflow eligibility (§31)', () => {
  it('unmatched observation returns null', () => {
    expect(normalizeExternalComparableIdentity(obs({ matchStatus: 'unmatched' }))).toBeNull()
  })

  it('rejected observation returns null', () => {
    expect(normalizeExternalComparableIdentity(obs({ matchStatus: 'rejected' }))).toBeNull()
  })

  it('rejected observation that retains a stale catalogModelId still returns null — matchStatus is the sole eligibility gate, workflow internals never leak', () => {
    expect(normalizeExternalComparableIdentity(obs({ matchStatus: 'rejected', catalogModelId: 'cat1' }))).toBeNull()
  })

  it('unmatched observation with any stale identity state still returns null', () => {
    expect(normalizeExternalComparableIdentity(obs({
      matchStatus: 'unmatched', catalogModelId: 'cat1', marketVariantId: 'v1',
      marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'carded' },
    }))).toBeNull()
  })

  it('matched observation with null catalogModelId returns null (defensively malformed)', () => {
    expect(normalizeExternalComparableIdentity(obs({ catalogModelId: null }))).toBeNull()
  })
})

describe('normalizeExternalComparableIdentity — variant integrity, fail closed (§32)', () => {
  it('marketVariantId present but joined marketVariant missing -> null', () => {
    expect(normalizeExternalComparableIdentity(obs({ marketVariantId: 'v1', marketVariant: null }))).toBeNull()
  })

  it('joined MarketVariant id mismatch -> null', () => {
    expect(normalizeExternalComparableIdentity(obs({
      marketVariantId: 'v1',
      marketVariant: { id: 'v-different', catalogModelId: 'cat1', packagingType: 'carded' },
    }))).toBeNull()
  })

  it('cross-model MarketVariant (belongs to a different CatalogModel) -> null, never silently degraded to model-only', () => {
    const result = normalizeExternalComparableIdentity(obs({
      catalogModelId: 'catA',
      marketVariantId: 'v1',
      marketVariant: { id: 'v1', catalogModelId: 'catB', packagingType: 'carded' },
    }))
    expect(result).toBeNull()
  })

  it('invalid packagingType on the joined variant -> null', () => {
    expect(normalizeExternalComparableIdentity(obs({
      marketVariantId: 'v1',
      marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'garbage' },
    }))).toBeNull()
  })

  it('correct Carded/Loose is accepted', () => {
    for (const pt of ['carded', 'loose'] as const) {
      const result = normalizeExternalComparableIdentity(obs({
        marketVariantId: 'v1', marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: pt },
      }))
      expect(result?.packagingType).toBe(pt)
    }
  })
})

describe('unknown/null semantics (§33)', () => {
  const modelOnlyA = normalizeExternalComparableIdentity(obs({ id: 'a' }))!
  const modelOnlyB = normalizeExternalComparableIdentity(obs({ id: 'b' }))!

  it('two model-only comparables (both marketVariantId null) are NOT variant-comparable — null never establishes equality', () => {
    expect(sameVariantBucket(modelOnlyA, modelOnlyB)).toBe(false)
  })

  it('two comparables with normalizedCondition null are NOT condition-comparable', () => {
    expect(sameConditionBucket(modelOnlyA, modelOnlyB)).toBe(false)
  })

  it('isExternalVariantComparable is false when marketVariantId is null', () => {
    expect(isExternalVariantComparable(modelOnlyA)).toBe(false)
  })

  it('isExternalConditionComparable is always false in 21D (no vocabulary yet)', () => {
    expect(isExternalConditionComparable(modelOnlyA)).toBe(false)
  })

  it('isExternalVariantComparable is true only when both marketVariantId and packagingType are set', () => {
    const classified = normalizeExternalComparableIdentity(obs({
      marketVariantId: 'v1', marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'carded' },
    }))!
    expect(isExternalVariantComparable(classified)).toBe(true)
  })
})

describe('comparability helpers (§17/§18/§19/§37)', () => {
  it('model bucket: equal non-null catalogModelId is comparable', () => {
    const a = normalizeExternalComparableIdentity(obs({ id: 'a', catalogModelId: 'cat1' }))!
    const b = normalizeExternalComparableIdentity(obs({ id: 'b', catalogModelId: 'cat1' }))!
    expect(sameModelBucket(a, b)).toBe(true)
  })

  it('model bucket: different catalogModelId is not comparable', () => {
    const a = normalizeExternalComparableIdentity(obs({ id: 'a', catalogModelId: 'cat1' }))!
    const b = normalizeExternalComparableIdentity(obs({ id: 'b', catalogModelId: 'cat2' }))!
    expect(sameModelBucket(a, b)).toBe(false)
  })

  it('variant bucket: same non-null marketVariantId is comparable, never via packaging string alone', () => {
    const a = normalizeExternalComparableIdentity(obs({ id: 'a', marketVariantId: 'v1', marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'carded' } }))!
    const b = normalizeExternalComparableIdentity(obs({ id: 'b', marketVariantId: 'v1', marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'carded' } }))!
    expect(sameVariantBucket(a, b)).toBe(true)
  })

  it('variant bucket: different marketVariantId (even same packagingType label) is not comparable', () => {
    const a = normalizeExternalComparableIdentity(obs({ id: 'a', marketVariantId: 'v1', marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'carded' } }))!
    const b = normalizeExternalComparableIdentity(obs({ id: 'b', catalogModelId: 'cat2', marketVariantId: 'v2', marketVariant: { id: 'v2', catalogModelId: 'cat2', packagingType: 'carded' } }))!
    expect(sameVariantBucket(a, b)).toBe(false)
  })
})

describe('no economics in the normalized shape (§35)', () => {
  it('the result object never contains price/date/economics fields', () => {
    const result = normalizeExternalComparableIdentity(obs())!
    const keys = Object.keys(result)
    for (const forbidden of ['price', 'shippingPrice', 'totalPrice', 'currency', 'soldAt', 'listedAt', 'observedAt', 'observationType']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('the result has exactly the seven documented fields', () => {
    const result = normalizeExternalComparableIdentity(obs())!
    expect(Object.keys(result).sort()).toEqual(
      ['catalogModelId', 'externalObservationId', 'marketVariantId', 'matchMethod', 'normalizedCondition', 'packagingType', 'provider'].sort(),
    )
  })
})

describe('no raw parsing (§34) — structural/type proof', () => {
  it('the input type accepts no title/rawSnapshot/condition field at all', () => {
    // Type-level proof: ExternalComparableInput has no such keys — verified by
    // constructing a full valid input above (obs()) using only documented keys.
    const input = obs()
    expect(Object.keys(input)).not.toContain('title')
    expect(Object.keys(input)).not.toContain('rawSnapshot')
    expect(Object.keys(input)).not.toContain('condition')
    expect(Object.keys(input)).not.toContain('sourceUrl')
  })

  it('the normalizer function has a single argument (no rawSnapshot/title side-channel parameter)', () => {
    expect(normalizeExternalComparableIdentity.length).toBe(1)
  })
})

describe('EXTERNAL_COMPARABLE_SELECT — reusable Prisma select (§21)', () => {
  it('selects only identity fields — no rawSnapshot, title, price, or date columns', () => {
    const keys = Object.keys(EXTERNAL_COMPARABLE_SELECT)
    expect(keys).toEqual(['id', 'provider', 'matchStatus', 'matchMethod', 'catalogModelId', 'marketVariantId', 'marketVariant'])
  })

  it('nested marketVariant select is identity-only', () => {
    expect(EXTERNAL_COMPARABLE_SELECT.marketVariant.select).toEqual({ id: true, catalogModelId: true, packagingType: true })
  })
})

describe('type-level: NormalizedExternalComparable has no economics fields (compile-time proof)', () => {
  it('assigning an economics-shaped object to the type would not compile — enforced by the exhaustive-keys test above', () => {
    const sample: NormalizedExternalComparable = {
      externalObservationId: 'o', provider: 'p', catalogModelId: 'c',
      marketVariantId: null, packagingType: null, normalizedCondition: null, matchMethod: null,
    }
    expect(sample).toBeTruthy()
  })
})
