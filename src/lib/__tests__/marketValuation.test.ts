// 23B: Valuation Engine V1 orchestration. Mocks 22B's getMarketSaleHistory and
// the one marketVariant validation lookup — matching this codebase's
// established convention for testing query-orchestration functions.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { marketVariant: { findUnique: vi.fn() } },
}))
vi.mock('@/lib/marketSaleQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/marketSaleQuery')>()
  return { ...actual, getMarketSaleHistory: vi.fn() }
})

import { prisma } from '@/lib/prisma'
import { getMarketSaleHistory, type MarketSaleObservation } from '@/lib/marketSaleQuery'
import { getValuation } from '@/lib/marketValuation'

function internalObs(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'internal' }>> = {}): MarketSaleObservation {
  return {
    observationId: `internal:${overrides.sourceRecordId ?? 'oi1'}`, sourceType: 'internal', sourceRecordId: 'oi1',
    catalogModelId: 'cat1', marketVariantId: 'v1', packagingType: 'carded', condition: 'mint',
    snapshotProvenance: 'sale_time', priceCents: 1000, currency: 'USD', soldAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

function externalObs(overrides: Partial<Extract<MarketSaleObservation, { sourceType: 'external' }>> = {}): MarketSaleObservation {
  return {
    observationId: `external:${overrides.sourceRecordId ?? 'obs1'}`, sourceType: 'external', sourceRecordId: 'obs1',
    provider: 'ebay', matchMethod: 'manual', catalogModelId: 'cat1', marketVariantId: null,
    packagingType: null, condition: null, priceCents: 1000, currency: 'USD', soldAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

const ASOF = new Date('2026-06-01T00:00:00Z')

function mockPrimary(observations: MarketSaleObservation[], hasMore = false) {
  ;(getMarketSaleHistory as Mock).mockResolvedValueOnce({ observations, hasMore })
}
function mockExtended(observations: MarketSaleObservation[], hasMore = false) {
  ;(getMarketSaleHistory as Mock).mockResolvedValueOnce({ observations, hasMore })
}
// Alias for readability when a test issues 3+ sequential getMarketSaleHistory
// calls (broad, then one or more targeted tier-verification queries).
const mockNextCall = mockExtended

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.marketVariant.findUnique as Mock).mockResolvedValue({ catalogModelId: 'cat1' })
})

// ── §61: full request ──

describe('full request (catalogModelId + marketVariantId + condition) (§61)', () => {
  it('uses exact tier even with only 1 qualifying observation — never broadens for a prettier sample', async () => {
    mockPrimary([
      internalObs({ sourceRecordId: 'exact1' }),
      ...Array.from({ length: 20 }, (_, i) => internalObs({ sourceRecordId: `v${i}`, condition: 'good' })),
    ])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') {
      expect(result.specificity).toBe('model_variant_condition')
      expect(result.rawSampleCount).toBe(1)
      expect(result.fallbackReason).toBeNull()
    }
  })

  it('zero exact -> falls back to model_variant tier', async () => {
    mockPrimary([internalObs({ condition: 'good' }), internalObs({ sourceRecordId: 'oi2', condition: 'good' })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') {
      expect(result.specificity).toBe('model_variant')
      expect(result.fallbackReason).toBe('no_sales_at_requested_specificity')
    }
  })

  it('zero exact AND zero variant -> falls back to model tier', async () => {
    mockPrimary([internalObs({ marketVariantId: 'other-variant', condition: 'mint' })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') expect(result.specificity).toBe('model')
  })
})

// ── §62: variant-only request ──

describe('variant-only request (§62)', () => {
  it('variant evidence exists -> used', async () => {
    mockPrimary([internalObs()])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') expect(result.specificity).toBe('model_variant')
  })

  it('zero variant evidence -> falls back to model', async () => {
    mockPrimary([internalObs({ marketVariantId: 'other-variant' })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') expect(result.specificity).toBe('model')
  })

  it('an unknown-variant (null) observation never counts as exact variant', async () => {
    mockPrimary([internalObs({ marketVariantId: null })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') expect(result.specificity).toBe('model')
  })
})

// ── §63: model-only request ──

describe('model-only request (§63)', () => {
  it('all same-model observations participate regardless of variant/condition knowledge', async () => {
    mockPrimary([
      internalObs({ marketVariantId: 'v1', condition: 'mint' }),
      internalObs({ sourceRecordId: 'oi2', marketVariantId: null, condition: null }),
      externalObs(),
    ])
    const result = await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') {
      expect(result.specificity).toBe('model')
      expect(result.rawSampleCount).toBe(3)
    }
  })

  it('queries getMarketSaleHistory scoped to exactly the requested catalogModelId — no broader/unscoped query', async () => {
    mockPrimary([])
    mockExtended([])
    await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    for (const call of (getMarketSaleHistory as Mock).mock.calls) {
      expect(call[0].catalogModelId).toBe('cat1')
    }
  })
})

// ── §64: recent vs historical ──

describe('recent evidence beats ancient narrower evidence (§64)', () => {
  it('zero exact-condition sales in 24m, several variant-level recent sales, one ancient exact sale -> uses recent variant tier, never extends', async () => {
    mockPrimary([
      internalObs({ sourceRecordId: 'r1', condition: 'good' }),
      internalObs({ sourceRecordId: 'r2', condition: 'good' }),
      internalObs({ sourceRecordId: 'r3', condition: 'good' }),
    ])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') {
      expect(result.specificity).toBe('model_variant')
      expect(result.extendedHistoryUsed).toBe(false)
    }
    // Only ONE getMarketSaleHistory call — the ancient exact sale was never queried/considered.
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(1)
  })
})

// ── §65: extended history ──

describe('extended history (§65)', () => {
  it('zero same-model sales at any tier in 24m, but historical sales exist -> extendedHistoryUsed=true, low confidence', async () => {
    mockPrimary([])
    mockExtended([internalObs({ soldAt: new Date('2020-01-01T00:00:00Z') })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    expect(result.status).toBe('valued')
    if (result.status === 'valued') {
      expect(result.extendedHistoryUsed).toBe(true)
      expect(result.confidence).toBe('low')
      expect(result.fallbackReason).toBe('no_recent_sales')
    }
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(2)
  })

  it('the extended query has no startDate (all-time) but the same endDate=asOf', async () => {
    mockPrimary([])
    mockExtended([])
    await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    const extendedCall = (getMarketSaleHistory as Mock).mock.calls[1][0]
    expect(extendedCall.startDate).toBeUndefined()
    expect(extendedCall.endDate).toEqual(ASOF)
  })

  it('maximum 2 history calls ever — never one query per tier', async () => {
    mockPrimary([])
    mockExtended([])
    await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(2)
  })
})

// ── §66: zero sales ──

describe('zero sales (§66)', () => {
  it('no recent or historical same-model sales -> insufficient_data / no_sales', async () => {
    mockPrimary([])
    mockExtended([])
    const result = await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    expect(result).toMatchObject({ status: 'insufficient_data', catalogModelId: 'cat1', reason: 'no_sales' })
  })
})

// ── §67: small N ──

describe('small N (§67)', () => {
  it('N=1: estimate yes, range null, confidence low', async () => {
    mockPrimary([internalObs()])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.estimatedValueCents).toBe(1000)
    expect(result.marketRangeLowCents).toBeNull()
    expect(result.confidence).toBe('low')
  })

  it('N=2: estimate yes, range null, confidence low', async () => {
    mockPrimary([internalObs({ priceCents: 1000 }), internalObs({ sourceRecordId: 'oi2', priceCents: 2000 })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.estimatedValueCents).toBe(1500)
    expect(result.marketRangeLowCents).toBeNull()
    expect(result.confidence).toBe('low')
  })

  it('N=3: estimate + medium confidence (recent), range still null', async () => {
    const obs = [1000, 2000, 3000].map((p, i) => internalObs({ sourceRecordId: `oi${i}`, priceCents: p }))
    mockPrimary(obs)
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.marketRangeLowCents).toBeNull()
    expect(result.confidence).toBe('medium')
  })

  it('N>=5: range available, outlier method active', async () => {
    const obs = [1000, 2000, 3000, 4000, 5000].map((p, i) => internalObs({ sourceRecordId: `oi${i}`, priceCents: p }))
    mockPrimary(obs)
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.marketRangeLowCents).not.toBeNull()
    expect(result.outlierMethod).toBe('iqr_1_5')
  })
})

// ── §70: source mix ──

describe('source mix (§70)', () => {
  it('internal only', async () => {
    mockPrimary([internalObs(), internalObs({ sourceRecordId: 'oi2' })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result).toMatchObject({ internalSampleCount: 2, externalSampleCount: 0 })
  })

  it('external only', async () => {
    mockPrimary([externalObs(), externalObs({ sourceRecordId: 'obs2' })])
    const result = await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result).toMatchObject({ internalSampleCount: 0, externalSampleCount: 2 })
  })

  it('mixed — counts preserved, internal+external === usedSampleCount, no weighting', async () => {
    mockPrimary([internalObs(), externalObs(), externalObs({ sourceRecordId: 'obs2' })])
    const result = await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.internalSampleCount + result.externalSampleCount).toBe(result.usedSampleCount)
    expect(result).toMatchObject({ internalSampleCount: 1, externalSampleCount: 2 })
  })
})

// ── §71: provenance ──

describe('provenance (§71)', () => {
  it('sale_time enters exact tier', async () => {
    mockPrimary([internalObs({ snapshotProvenance: 'sale_time' })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model_variant_condition')
  })

  it('intake_declared enters exact tier when its variant/condition fields qualify', async () => {
    mockPrimary([internalObs({ snapshotProvenance: 'intake_declared' })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model_variant_condition')
  })

  it('legacy_model_only never satisfies variant/condition tiers, model tier only', async () => {
    mockPrimary([internalObs({ snapshotProvenance: 'legacy_model_only', marketVariantId: null, condition: null })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model')
  })
})

// ── §72: external condition ──

describe('external condition gap (§72)', () => {
  it('external observations (condition always null) never enter the full condition tier, but may enter variant/model tiers', async () => {
    mockPrimary([externalObs({ marketVariantId: 'v1' })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model_variant') // fell back, external counted here
  })
})

// ── §73: cross-model exclusion ──

describe('cross-model exclusion (§73)', () => {
  it('same brand/name/series/year but different catalogModelId is impossible to leak in — the engine only ever fetches by exact catalogModelId, no fuzzy fallback', async () => {
    // The 22B mock is scoped by catalogModelId itself (it is the WHERE filter);
    // proving the orchestration only ever requests catalogModelId='cat1' is the
    // structural guarantee that a different model's sales can never appear.
    mockPrimary([internalObs()])
    await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    const call = (getMarketSaleHistory as Mock).mock.calls[0][0]
    expect(call.catalogModelId).toBe('cat1')
    expect(Object.keys(call)).not.toContain('brand')
    expect(Object.keys(call)).not.toContain('series')
    expect(Object.keys(call)).not.toContain('year')
  })
})

// ── §74/§75: input validation ──

describe('input validation (§74/§75)', () => {
  it('condition without marketVariantId is rejected as an input error', async () => {
    const result = await getValuation({ catalogModelId: 'cat1', condition: 'mint', asOf: ASOF })
    expect(result.status).toBe('input_error')
    expect(getMarketSaleHistory).not.toHaveBeenCalled()
  })

  it('an invalid condition value is rejected', async () => {
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'pristine', asOf: ASOF })
    expect(result.status).toBe('input_error')
  })

  it('a marketVariantId belonging to a different CatalogModel is an input error, never insufficient_data', async () => {
    ;(prisma.marketVariant.findUnique as Mock).mockResolvedValue({ catalogModelId: 'OTHER_MODEL' })
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v-from-other-model', asOf: ASOF })
    expect(result.status).toBe('input_error')
    expect(getMarketSaleHistory).not.toHaveBeenCalled()
  })

  it('a nonexistent marketVariantId is an input error', async () => {
    ;(prisma.marketVariant.findUnique as Mock).mockResolvedValue(null)
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'nope', asOf: ASOF })
    expect(result.status).toBe('input_error')
  })

  it('validates the variant via exactly one query — no per-observation lookups', async () => {
    mockPrimary([internalObs()])
    await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    expect(prisma.marketVariant.findUnique).toHaveBeenCalledTimes(1)
  })
})

// ── §76: asOf ──

describe('asOf (§76)', () => {
  it('passes asOf as the exclusive endDate to the primary query', async () => {
    mockPrimary([])
    mockExtended([])
    await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    expect((getMarketSaleHistory as Mock).mock.calls[0][0].endDate).toEqual(ASOF)
  })

  it('same input/asOf/data produces the same result deterministically', async () => {
    const fixture = [internalObs({ priceCents: 1234 })]
    mockPrimary(fixture)
    const first = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    mockPrimary(fixture)
    const second = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    expect(first).toEqual(second)
  })

  it('defaults asOf to now when omitted', async () => {
    mockPrimary([])
    mockExtended([])
    const before = Date.now()
    const result = await getValuation({ catalogModelId: 'cat1' })
    const after = Date.now()
    if (result.status === 'input_error') throw new Error('expected non-input_error result')
    expect(result.asOf.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.asOf.getTime()).toBeLessThanOrEqual(after)
  })
})

// ── §77: sample truncation ──

describe('sample truncation (§77)', () => {
  it('model-only request, hasMore=true -> sampleTruncated=true, no targeted query issued (nothing narrower to check)', async () => {
    mockPrimary([internalObs()], true)
    const result = await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.sampleTruncated).toBe(true)
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(1)
  })

  it('hasMore=false -> sampleTruncated=false', async () => {
    mockPrimary([internalObs()], false)
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.sampleTruncated).toBe(false)
  })

  it('requests the canonical 22B bound (500)', async () => {
    mockPrimary([])
    mockExtended([])
    await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    expect((getMarketSaleHistory as Mock).mock.calls[0][0].limit).toBe(500)
  })
})

// ── 23B follow-up: truncated broad-query tier correctness (§7 A-H) ──

describe('truncated broad query cannot hide a narrower same-model tier (follow-up §7)', () => {
  it('A. FULL request: broad truncated + top-500 has no exact-condition rows + targeted exact query finds some -> chooses model_variant_condition', async () => {
    mockPrimary([internalObs({ condition: 'good' })], true) // broad top-500: truncated, no exact-condition rows visible
    mockNextCall([internalObs({ sourceRecordId: 'exact1', condition: 'mint' })], false) // targeted model_variant_condition query
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model_variant_condition')
    expect(result.rawSampleCount).toBe(1)
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(2)
    const targetedCall = (getMarketSaleHistory as Mock).mock.calls[1][0]
    expect(targetedCall.marketVariantId).toBe('v1')
    expect(targetedCall.condition).toBe('mint')
  })

  it('B. FULL request: targeted exact zero, targeted variant finds rows -> chooses model_variant', async () => {
    mockPrimary([internalObs({ condition: 'good' })], true)
    mockNextCall([], false) // targeted model_variant_condition: zero
    mockNextCall([internalObs({ sourceRecordId: 'variant1', condition: 'good' })], false) // targeted model_variant: found
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model_variant')
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(3)
    const secondTargeted = (getMarketSaleHistory as Mock).mock.calls[2][0]
    expect(secondTargeted.marketVariantId).toBe('v1')
    expect(secondTargeted.condition).toBeUndefined()
  })

  it('C. FULL request: targeted exact zero, targeted variant zero -> broad model fallback', async () => {
    mockPrimary([internalObs({ marketVariantId: 'other-variant' })], true)
    mockNextCall([], false) // targeted model_variant_condition: zero
    mockNextCall([], false) // targeted model_variant: zero
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model')
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(3)
  })

  it('D. VARIANT request: truncated broad sample hides variant rows -> targeted variant query wins', async () => {
    mockPrimary([internalObs({ marketVariantId: 'other-variant' })], true) // broad top-500 shows no v1 rows
    mockNextCall([internalObs({ sourceRecordId: 'hidden1', marketVariantId: 'v1' })], false) // targeted finds it
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model_variant')
    expect(result.rawSampleCount).toBe(1)
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(2)
  })

  it('E. MODEL-only request: hasMore=true -> no unnecessary narrower/targeted query at all', async () => {
    mockPrimary([internalObs()], true)
    const result = await getValuation({ catalogModelId: 'cat1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model')
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(1)
  })

  it('F. the chosen targeted query itself has hasMore=true -> sampleTruncated=true', async () => {
    mockPrimary([internalObs({ marketVariantId: 'other-variant' })], true)
    mockNextCall([internalObs({ sourceRecordId: 'hidden1' })], true) // targeted variant query is ITSELF truncated
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.sampleTruncated).toBe(true)
  })

  it('G. broad query hasMore=true but the chosen targeted query hasMore=false -> sampleTruncated=false for the actual chosen sample', async () => {
    mockPrimary([internalObs({ marketVariantId: 'other-variant' })], true)
    mockNextCall([internalObs({ sourceRecordId: 'hidden1' })], false) // targeted query is fully complete
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.sampleTruncated).toBe(false)
  })

  it('H. extended-history equivalent: truncated all-time broad sample cannot falsely erase an available narrower tier', async () => {
    mockPrimary([], false) // primary window: genuinely zero same-model sales at any tier
    mockNextCall([internalObs({ marketVariantId: 'other-variant', soldAt: new Date('2019-01-01T00:00:00Z') })], true) // extended broad: truncated, no v1 rows visible in top-500
    mockNextCall([internalObs({ sourceRecordId: 'ancient-hidden', marketVariantId: 'v1', soldAt: new Date('2018-01-01T00:00:00Z') })], false) // targeted extended query finds it
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    if (result.status !== 'valued') throw new Error('expected valued')
    expect(result.specificity).toBe('model_variant')
    expect(result.extendedHistoryUsed).toBe(true)
    expect(getMarketSaleHistory).toHaveBeenCalledTimes(3)
    // The targeted extended query must still carry no startDate (all-time) — same-CatalogModel only.
    const targetedExtendedCall = (getMarketSaleHistory as Mock).mock.calls[2][0]
    expect(targetedExtendedCall.startDate).toBeUndefined()
    expect(targetedExtendedCall.marketVariantId).toBe('v1')
  })
})

// ── §78: ask separation (structural) ──

describe('ask separation (§78/§40/§41)', () => {
  it('marketValuation.ts never imports/calls ask primitives or getLatestSale', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketValuation.ts'), 'utf-8')
    expect(src).not.toMatch(/getLowestAsk|getInternalAsks|getExternalAsks|getLatestSale/)
  })

  it('the ValuationResult shape never includes an ask/price-context field', async () => {
    mockPrimary([internalObs({ priceCents: 3000 })])
    const result = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', asOf: ASOF })
    expect(Object.keys(result)).not.toContain('lowestAskCents')
    expect(Object.keys(result)).not.toContain('activeAskContext')
  })
})

// ── §79: no raw DB bypass (structural) ──

describe('no raw DB bypass (§79)', () => {
  it('marketValuation.ts never references orderItem/order/externalMarketObservation directly', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketValuation.ts'), 'utf-8')
    expect(src).not.toMatch(/prisma\.orderItem|prisma\.order\.|prisma\.externalMarketObservation/)
  })

  it('marketValuationMath.ts imports no Prisma value (only type-only imports allowed)', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketValuationMath.ts'), 'utf-8')
    expect(src).not.toMatch(/^import (?!type)/m)
    expect(src).not.toContain("from '@prisma/client'")
  })
})

// ── §80: no financial signals (structural) ──

describe('no financial signals (§80)', () => {
  it('neither module contains forecast/target/expected-return/investment/momentum logic', async () => {
    const fs = await import('fs')
    const path = await import('path')
    for (const file of ['src/lib/marketValuation.ts', 'src/lib/marketValuationMath.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), file), 'utf-8')
      const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      expect(code).not.toMatch(/forecast|targetPrice|expectedReturn|investmentScore|momentum|volatility|sellerOffer/i)
    }
  })
})

// ── §81: legacy engine unchanged (structural regression) ──

describe('legacy engine untouched (§81)', () => {
  const consumers = [
    'src/lib/advancedValuation.ts',
    'src/lib/advancedValuationQuery.ts',
    'src/lib/resaleEstimator.ts',
    'src/lib/resaleEstimatorQuery.ts',
    'src/lib/pricingIntelligence.ts',
    'src/lib/pricingIntelligenceQuery.ts',
  ]
  for (const file of consumers) {
    it(`${file} does not import the new 23B modules`, async () => {
      const fs = await import('fs')
      const path = await import('path')
      const src = fs.readFileSync(path.join(process.cwd(), file), 'utf-8')
      expect(src).not.toMatch(/marketValuation|marketValuationMath/)
    })
  }
})
