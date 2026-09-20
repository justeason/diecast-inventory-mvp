// 31B: canonical Pricing Intelligence V2 — Automation Pricing Decision. Pure
// function, no mocking needed beyond constructing PricingContext fixtures.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { evaluateAutoListingPricingV2 } from '@/lib/autoListingPricingV2'
import { RANGE_MIN_SAMPLE } from '@/lib/marketValuationMath'
import type { PricingContext } from '@/lib/pricingContext'
import type { ValuationResult } from '@/lib/marketValuation'

const ASOF = new Date('2026-06-01T00:00:00Z')

function valued(overrides: Partial<Extract<ValuationResult, { status: 'valued' }>> = {}): Extract<ValuationResult, { status: 'valued' }> {
  return {
    status: 'valued',
    catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint',
    estimatedValueCents: 1500, marketRangeLowCents: 3000, marketRangeHighCents: 4000,
    confidence: 'high', specificity: 'model_variant_condition', primarySpecificity: 'model_variant_condition',
    rawSampleCount: 8, usedSampleCount: 8, excludedOutlierCount: 0,
    internalSampleCount: 5, externalSampleCount: 3,
    asOf: ASOF, windowStart: new Date('2024-06-01T00:00:00Z'),
    extendedHistoryUsed: false, sampleTruncated: false,
    method: 'median_sales', outlierMethod: 'none', fallbackReason: null,
    latestSaleAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  }
}

const insufficient = (): ValuationResult => ({
  status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: 'var1', condition: 'mint', asOf: ASOF, reason: 'no_sales',
})

function contextFor(valuation: ValuationResult, askSummary: PricingContext['askSummary'] = { lowestAskCents: null, medianAskCents: null, availableCopies: 0 }): PricingContext {
  return {
    valuation,
    askSummary,
    specificityDisclosure: {
      requested: 'model_variant_condition',
      resolved: valuation.status === 'valued' ? valuation.specificity : null,
      exactMatch: valuation.status === 'valued' && valuation.specificity === valuation.primarySpecificity,
    },
    evidenceDisclosure:
      valuation.status === 'valued'
        ? {
            rawSampleCount: valuation.rawSampleCount,
            usedSampleCount: valuation.usedSampleCount,
            excludedOutlierCount: valuation.excludedOutlierCount,
            internalSampleCount: valuation.internalSampleCount,
            externalSampleCount: valuation.externalSampleCount,
          }
        : null,
    asOf: ASOF,
  }
}

const MEDIUM_POLICY = { pricePositionBps: 5000, minimumPricingConfidence: 'medium' }
const HIGH_POLICY = { pricePositionBps: 5000, minimumPricingConfidence: 'high' }

describe('evaluateAutoListingPricingV2 — exact eligible (31B §68)', () => {
  it('exact model+variant+condition, high confidence, no extended history, Market Range available -> eligible with a candidate price', () => {
    const context = contextFor(valued())
    const decision = evaluateAutoListingPricingV2(context, MEDIUM_POLICY)
    expect(decision.eligible).toBe(true)
    if (decision.eligible) {
      expect(decision.candidatePriceCents).toBe(3500) // low=3000 high=4000 bps=5000
      expect(decision.decisionReasons).toEqual(['eligible'])
      expect(decision.pricingContext).toBe(context)
    }
  })
})

describe('evaluateAutoListingPricingV2 — confidence gate (31B §17/§18/§69)', () => {
  it('canonical High confidence -> eligible under any valid policy', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ confidence: 'high' })), HIGH_POLICY)
    expect(decision.eligible).toBe(true)
  })

  it('canonical Medium confidence -> eligible unless policy requires High', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ confidence: 'medium' })), MEDIUM_POLICY)
    expect(decision.eligible).toBe(true)
  })

  it('canonical Medium confidence, policy requires High -> ineligible/policy_requires_high_confidence', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ confidence: 'medium' })), HIGH_POLICY)
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['policy_requires_high_confidence'])
  })

  it('canonical Low confidence -> ineligible/confidence_below_medium, regardless of policy', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ confidence: 'low' })), MEDIUM_POLICY)
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['confidence_below_medium'])
  })

  it('policy minimumPricingConfidence="low" (legacy value) still requires at least Medium — cannot weaken V2 below the canonical floor', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ confidence: 'low' })), { pricePositionBps: 5000, minimumPricingConfidence: 'low' })
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['confidence_below_medium'])
  })

  it('policy minimumPricingConfidence="insufficient" (legacy value) still requires at least Medium, and Medium evidence still qualifies', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ confidence: 'medium' })), { pricePositionBps: 5000, minimumPricingConfidence: 'insufficient' })
    expect(decision.eligible).toBe(true)
  })

  it('unrecognized/corrupt policy confidence value -> ineligible/invalid_policy, fail closed', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ confidence: 'high' })), { pricePositionBps: 5000, minimumPricingConfidence: 'garbage' })
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['invalid_policy'])
  })
})

describe('evaluateAutoListingPricingV2 — specificity gate, exact required (31B §14/§70)', () => {
  it('requested condition, resolved condition (exact) -> may qualify', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(valued({ specificity: 'model_variant_condition', primarySpecificity: 'model_variant_condition' })),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(true)
  })

  it('requested condition, resolved variant -> ineligible/specificity_fallback', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(valued({ specificity: 'model_variant', primarySpecificity: 'model_variant_condition' })),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['specificity_fallback'])
  })

  it('requested condition, resolved model -> ineligible/specificity_fallback', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(valued({ specificity: 'model', primarySpecificity: 'model_variant_condition' })),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['specificity_fallback'])
  })

  it('requested variant, resolved model -> ineligible/specificity_fallback', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(valued({ specificity: 'model', primarySpecificity: 'model_variant' })),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['specificity_fallback'])
  })
})

describe('evaluateAutoListingPricingV2 — valuation insufficient (31B §57)', () => {
  it('status !== valued -> ineligible/valuation_insufficient', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(insufficient()), MEDIUM_POLICY)
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['valuation_insufficient'])
  })
})

describe('evaluateAutoListingPricingV2 — extended history (31B §19/§72)', () => {
  it('extendedHistoryUsed=true -> ineligible/extended_history', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ extendedHistoryUsed: true })), MEDIUM_POLICY)
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['extended_history'])
  })
})

describe('evaluateAutoListingPricingV2 — Market Range required (31B §20/§73)', () => {
  it('marketRangeLowCents null -> ineligible/market_range_unavailable', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: null })), MEDIUM_POLICY)
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['market_range_unavailable'])
  })

  it('marketRangeHighCents null -> ineligible/market_range_unavailable', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeHighCents: null })), MEDIUM_POLICY)
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['market_range_unavailable'])
  })

  it('valid range with other gates passing -> eligible', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 100, marketRangeHighCents: 200 })), MEDIUM_POLICY)
    expect(decision.eligible).toBe(true)
  })
})

describe('evaluateAutoListingPricingV2 — Market Range/sample consistency, fail closed on malformed context (follow-up hotfix)', () => {
  it('range present but usedSampleCount below the canonical RANGE_MIN_SAMPLE -> ineligible/market_range_unavailable, never trusts a malformed PricingContext', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000, usedSampleCount: RANGE_MIN_SAMPLE - 1 })),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['market_range_unavailable'])
    expect(decision.candidatePriceCents).toBeNull()
  })

  it('usedSampleCount exactly at the canonical minimum, otherwise-valid context -> may qualify', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000, usedSampleCount: RANGE_MIN_SAMPLE })),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(true)
  })

  it('reuses the canonical RANGE_MIN_SAMPLE constant from marketValuationMath.ts — no second, lower threshold invented', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    expect(src).toContain("import { RANGE_MIN_SAMPLE } from '@/lib/marketValuationMath'")
    expect(src).toContain('valuation.usedSampleCount < RANGE_MIN_SAMPLE')
    expect(src).not.toMatch(/usedSampleCount\s*<\s*[0-9]+(?!\s*\))/) // no inline numeric literal threshold
  })
})

describe('evaluateAutoListingPricingV2 — pricePositionBps validation (follow-up hotfix)', () => {
  it('pricePositionBps = -1 -> ineligible/invalid_policy', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued()), { pricePositionBps: -1, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['invalid_policy'])
  })

  it('pricePositionBps = 10001 -> ineligible/invalid_policy', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued()), { pricePositionBps: 10001, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['invalid_policy'])
  })

  it('pricePositionBps = 0 -> valid boundary, eligible, candidate = low', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000 })), { pricePositionBps: 0, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    if (decision.eligible) expect(decision.candidatePriceCents).toBe(3000)
  })

  it('pricePositionBps = 10000 -> valid boundary, eligible, candidate = high', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000 })), { pricePositionBps: 10000, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    if (decision.eligible) expect(decision.candidatePriceCents).toBe(4000)
  })

  it('pricePositionBps = 5000 -> normal interpolation, eligible', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000 })), { pricePositionBps: 5000, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    if (decision.eligible) expect(decision.candidatePriceCents).toBe(3500)
  })

  it('non-integer pricePositionBps -> ineligible/invalid_policy', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued()), { pricePositionBps: 4999.5, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['invalid_policy'])
  })

  it('bps validation happens BEFORE computeAutoListPriceCents is trusted to clamp — explicit gate in this module, not a reliance on the interpolation helper\'s defensive clamp', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    const bpsCheckIdx = src.indexOf('policy.pricePositionBps < 0')
    const interpolateIdx = src.indexOf('computeAutoListPriceCents(valuation.marketRangeLowCents')
    expect(bpsCheckIdx).toBeGreaterThan(-1)
    expect(interpolateIdx).toBeGreaterThan(bpsCheckIdx)
  })
})

describe('evaluateAutoListingPricingV2 — range interpolation, deterministic integer cents (31B §22/§74)', () => {
  it('bps=0 -> exactly low', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000 })), { pricePositionBps: 0, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    if (decision.eligible) expect(decision.candidatePriceCents).toBe(3000)
  })

  it('bps=5000 -> exact midpoint', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000 })), { pricePositionBps: 5000, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    if (decision.eligible) expect(decision.candidatePriceCents).toBe(3500)
  })

  it('bps=10000 -> exactly high', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 3000, marketRangeHighCents: 4000 })), { pricePositionBps: 10000, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    if (decision.eligible) expect(decision.candidatePriceCents).toBe(4000)
  })

  it('odd-cent span rounds deterministically (round-half-up, via the existing computeAutoListPriceCents)', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 1001, marketRangeHighCents: 1010 })), { pricePositionBps: 3333, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    // range=9, bps=3333 -> 9*3333/10000 = 2.9997 -> round-half-up -> 3
    if (decision.eligible) expect(decision.candidatePriceCents).toBe(1004)
  })

  it('reuses computeAutoListPriceCents verbatim — no second interpolation formula in this module', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    expect(src).toContain("import { computeAutoListPriceCents } from '@/lib/autoListing'")
    expect(src).toContain('computeAutoListPriceCents(valuation.marketRangeLowCents, valuation.marketRangeHighCents, policy.pricePositionBps)')
  })

  it('invalid range (high < low) -> ineligible/candidate_price_invalid', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 4000, marketRangeHighCents: 3000 })), MEDIUM_POLICY)
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['candidate_price_invalid'])
  })
})

describe('evaluateAutoListingPricingV2 — ask independence (31B §24/§25/§75)', () => {
  it('same valuation/range, different Lowest Ask -> identical candidate price; asks never adjust price', () => {
    const contextLowAsk = contextFor(valued(), { lowestAskCents: 500, medianAskCents: 500, availableCopies: 5 })
    const contextHighAsk = contextFor(valued(), { lowestAskCents: 9000, medianAskCents: 9000, availableCopies: 1 })
    const contextNoAsk = contextFor(valued(), { lowestAskCents: null, medianAskCents: null, availableCopies: 0 })
    const d1 = evaluateAutoListingPricingV2(contextLowAsk, MEDIUM_POLICY)
    const d2 = evaluateAutoListingPricingV2(contextHighAsk, MEDIUM_POLICY)
    const d3 = evaluateAutoListingPricingV2(contextNoAsk, MEDIUM_POLICY)
    expect(d1.eligible && d1.candidatePriceCents).toBe(3500)
    expect(d2.eligible && d2.candidatePriceCents).toBe(3500)
    expect(d3.eligible && d3.candidatePriceCents).toBe(3500)
  })

  it('the module never reads context.askSummary when computing candidatePriceCents', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    const idx = src.indexOf('export function evaluateAutoListingPricingV2')
    const block = src.slice(idx, src.indexOf('\n}', src.lastIndexOf('return', src.length)))
    expect(block).not.toMatch(/askSummary/)
  })
})

describe('evaluateAutoListingPricingV2 — external sold evidence allowed (31B §26/§76)', () => {
  it('canonical valuation drawn partly/mostly from external sold observations still qualifies once other gates pass', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(valued({ internalSampleCount: 1, externalSampleCount: 9, usedSampleCount: 10 })),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(true)
  })
})

describe('evaluateAutoListingPricingV2 — external ask exclusion (31B §27/§77)', () => {
  it('the module never imports/references external ask research', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    expect(src).not.toMatch(/externalMarketResearch|getExternalAsks|ExternalAsk/)
  })
})

describe('evaluateAutoListingPricingV2 — ask-only case (31B §28/§78)', () => {
  it('active internal asks exist but valuation is insufficient -> review (ineligible), never a recommendation from asks alone', () => {
    const decision = evaluateAutoListingPricingV2(
      contextFor(insufficient(), { lowestAskCents: 3200, medianAskCents: 3400, availableCopies: 3 }),
      MEDIUM_POLICY,
    )
    expect(decision.eligible).toBe(false)
    expect(decision.decisionReasons).toEqual(['valuation_insufficient'])
    expect(decision.candidatePriceCents).toBeNull()
  })
})

describe('evaluateAutoListingPricingV2 — signals independence (31B §29/§30/§31/§79)', () => {
  it('the module never imports Market Signals/days-to-sell/Wanted', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    expect(src).not.toMatch(/marketSignalsQuery|getMarketSignals|MedianDaysToSell|WantedCatalogModel|30[Dd] [Cc]hange|valuationChange30d/)
  })
})

describe('evaluateAutoListingPricingV2 — commercial/seller-fact independence (31B §43-§48/§80)', () => {
  it('the module never references expectedPrice/agreedListPrice/minimumSellerPayout/commission/Recorded Cost/agreedBuyoutAmount', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    expect(src).not.toMatch(/expectedPrice|agreedListPrice|minimumSellerPayout|commission|[Rr]ecordedCost|agreedBuyoutAmount/)
  })
})

describe('evaluateAutoListingPricingV2 — cross-model prohibition (31B §16/§63/§71)', () => {
  it('the module never imports resaleEstimator/advancedValuation/pricingIntelligence/externalMarketResearch (the legacy cross-model hierarchy)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    expect(src).not.toMatch(/resaleEstimator|advancedValuation|pricingIntelligence|externalMarketResearch|model_family|series_year|brand_series/)
  })
})

describe('evaluateAutoListingPricingV2 — money (31B §49/§89)', () => {
  it('no ad hoc Math.round(x * 100)-style cents math in this module — candidate price comes only from computeAutoListPriceCents', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    expect(src).not.toMatch(/Math\.round\([^)]*\*\s*100\)/)
  })

  it('candidatePriceCents is always an integer when eligible', () => {
    const decision = evaluateAutoListingPricingV2(contextFor(valued({ marketRangeLowCents: 1001, marketRangeHighCents: 1010 })), { pricePositionBps: 3333, minimumPricingConfidence: 'medium' })
    expect(decision.eligible).toBe(true)
    if (decision.eligible) expect(Number.isInteger(decision.candidatePriceCents)).toBe(true)
  })
})

describe('evaluateAutoListingPricingV2 — no numeric magic score (31B §32)', () => {
  it('AutoListingPricingDecision has no opaque numeric score field beyond candidatePriceCents', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/autoListingPricingV2.ts'), 'utf-8')
    const idx = src.indexOf('export type AutoListingPricingDecision')
    const block = src.slice(idx, src.indexOf('\n\n', idx))
    expect(block).not.toMatch(/score/i)
  })
})
