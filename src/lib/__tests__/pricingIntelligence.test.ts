import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  buildPricingIntelligence,
  compareListingToGuidance,
  classifyListingPosition,
  firstPartyEvidenceSummary,
  externalSoldEvidenceSummary,
  externalActiveAskEvidenceSummary,
  GUIDANCE_TOLERANCE_PCT,
  SAMPLE_WEIGHT_CAP,
  FIRST_PARTY_SOURCE_PRIORITY,
  EXTERNAL_SOURCE_PRIORITY,
} from '@/lib/pricingIntelligence'
import type { AdvancedValuation } from '@/lib/advancedValuation'
import type { ExternalMarketSummary } from '@/lib/externalMarketResearch'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const ASOF = new Date('2026-08-01T00:00:00.000Z')

function fp(overrides: Partial<AdvancedValuation> = {}): AdvancedValuation {
  return {
    catalogModelId: 'cat1',
    asOf: ASOF,
    matchTier: 'exact',
    sampleCount: 0,
    effectiveSampleCount: 0,
    // Mirrors buildAdvancedValuation's real invariant: estimatedValue defaults to
    // whatever unweightedMedian the fixture sets, unless the test overrides it
    // explicitly (e.g. to test weighted vs. unweighted divergence).
    estimatedValue: overrides.unweightedMedian ?? null,
    lowEstimate: null,
    highEstimate: null,
    confidence: 'insufficient',
    confidenceReasons: [{ code: 'sample_insufficient', label: 'No eligible completed sales' }],
    latestSaleAt: null,
    medianDaysToSell: null,
    recentTrend: { direction: 'unavailable', percentageChange: null, recentMedian: null, priorMedian: null },
    activeAskContext: { activeListingCount: 0, lowestActiveAsk: null, medianActiveAsk: null, highestActiveAsk: null },
    liquidity: { medianDaysToSell: null, p25DaysToSell: null, p75DaysToSell: null, durationSampleCount: 0, recentCompletedSaleCount: 0, activePurchasableListingCount: 0 },
    outliersRemoved: false,
    unweightedMedian: null,
    weightedMedian: null,
    extendedHistoryUsed: false,
    minCents: null,
    maxCents: null,
    oldestSaleAt: null,
    ...overrides,
  }
}

function ext(overrides: Partial<ExternalMarketSummary> = {}): ExternalMarketSummary {
  return {
    catalogModelId: 'cat1',
    asOf: ASOF,
    soldSummary: null,
    activeAskCount: 0,
    lowestActiveAskCents: null,
    askSummary: null,
    researchFreshness: 'unavailable',
    latestSoldAt: null,
    latestAskObservedAt: null,
    providers: [],
    ...overrides,
  }
}

const NO_CNT_ASK = { activeListingCount: 0, lowestAskCents: null, medianAskCents: null, highestAskCents: null }

describe('pricingIntelligence: evidence summaries', () => {
  it('firstPartyEvidenceSummary reports raw/included/excluded outlier counts', () => {
    const v = fp({ sampleCount: 10, effectiveSampleCount: 8, unweightedMedian: 1500, lowEstimate: 1300, highEstimate: 1700, minCents: 1000, maxCents: 2000, latestSaleAt: ASOF, oldestSaleAt: new Date('2026-01-01') })
    const s = firstPartyEvidenceSummary(v)
    expect(s.count).toBe(10)
    expect(s.outliers).toEqual({ rawCount: 10, includedCount: 8, excludedCount: 2 })
    expect(s.medianCents).toBe(1500)
  })

  it('externalSoldEvidenceSummary is empty when no soldSummary', () => {
    const s = externalSoldEvidenceSummary(ext())
    expect(s.count).toBe(0)
    expect(s.medianCents).toBeNull()
  })

  it('externalActiveAskEvidenceSummary surfaces median/p75/max from askSummary', () => {
    const s = externalActiveAskEvidenceSummary(ext({
      askSummary: { count: 4, medianCents: 1200, p75Cents: 1400, highestActiveAskCents: 1600 },
      lowestActiveAskCents: 900,
    }))
    expect(s.count).toBe(4)
    expect(s.medianCents).toBe(1200)
    expect(s.maxCents).toBe(1600)
    expect(s.minCents).toBe(900)
  })
})

describe('pricingIntelligence: blending', () => {
  it('first-party priority: uses first-party median when only first-party sold evidence exists', () => {
    const v = fp({ sampleCount: 8, effectiveSampleCount: 8, unweightedMedian: 1500, lowEstimate: 1300, highEstimate: 1700, confidence: 'high', latestSaleAt: ASOF })
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    expect(r.estimatedValueCents).toBe(1500)
    expect(r.isAskOnly).toBe(false)
  })

  it('external sold supplements when first-party is thin — blended target lies between the two medians', () => {
    const v = fp({ sampleCount: 1, effectiveSampleCount: 1, unweightedMedian: 1000, lowEstimate: 1000, highEstimate: 1000, confidence: 'low' })
    const e = ext({ soldSummary: { medianCents: 2000, p25Cents: 1800, p75Cents: 2200, minCents: 1700, maxCents: 2300, sampleSize: 10, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.estimatedValueCents).not.toBeNull()
    expect(r.estimatedValueCents!).toBeGreaterThan(1000)
    expect(r.estimatedValueCents!).toBeLessThan(2000)
  })

  it('external-only: uses external median when first-party has zero sold evidence', () => {
    const e = ext({ soldSummary: { medianCents: 1800, p25Cents: 1600, p75Cents: 2000, minCents: 1500, maxCents: 2100, sampleSize: 6, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', fp(), e, NO_CNT_ASK, ASOF)
    expect(r.estimatedValueCents).toBe(1800)
  })

  it('active asks do not override sold evidence: ask prices far from sold evidence do not move estimatedValueCents', () => {
    const v = fp({ sampleCount: 8, effectiveSampleCount: 8, unweightedMedian: 1500, lowEstimate: 1300, highEstimate: 1700, confidence: 'high', latestSaleAt: ASOF })
    const cnt = { activeListingCount: 3, lowestAskCents: 5000, medianAskCents: 6000, highestAskCents: 7000 }
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), cnt, ASOF)
    expect(r.estimatedValueCents).toBe(1500) // unaffected by the wildly different ask prices
  })

  it('insufficient sold evidence with no asks either: estimatedValue and recommendedListing are all null', () => {
    const r = buildPricingIntelligence('cat1', 'insufficient', fp(), ext(), NO_CNT_ASK, ASOF)
    expect(r.estimatedValueCents).toBeNull()
    expect(r.recommendedListing).toEqual({ lowCents: null, targetCents: null, highCents: null })
    expect(r.confidence.level).toBe('insufficient')
  })

  it('ask-only: no sold evidence but active asks exist — recommendedListing populated, estimatedValueCents stays null, explicitly labeled', () => {
    const cnt = { activeListingCount: 3, lowestAskCents: 1000, medianAskCents: 1200, highestAskCents: 1500 }
    const r = buildPricingIntelligence('cat1', 'insufficient', fp(), ext(), cnt, ASOF)
    expect(r.estimatedValueCents).toBeNull()
    expect(r.isAskOnly).toBe(true)
    expect(r.recommendedListing.targetCents).toBe(1200)
    expect(r.warnings.some(w => w.toLowerCase().includes('active market asks only'))).toBe(true)
    expect(r.confidence.level).toBe('insufficient') // ask-only never establishes a confident valuation
  })

  it('first-party/external disagreement is flagged and downgrades confidence', () => {
    const v = fp({ sampleCount: 8, effectiveSampleCount: 8, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, confidence: 'high', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 2000, p25Cents: 1800, p75Cents: 2200, minCents: 1700, maxCents: 2300, sampleSize: 8, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.confidence.reasons.some(x => x.toLowerCase().includes('diverge'))).toBe(true)
    expect(r.confidence.level).not.toBe('high')
  })

  it('first-party/external agreement is flagged and can upgrade confidence', () => {
    const v = fp({ sampleCount: 4, effectiveSampleCount: 4, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, confidence: 'medium', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 1030, p25Cents: 950, p75Cents: 1100, minCents: 900, maxCents: 1150, sampleSize: 8, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.confidence.reasons.some(x => x.toLowerCase().includes('agree'))).toBe(true)
  })
})

describe('pricingIntelligence: source weighting saturation (section 2)', () => {
  it('exact formula: weight(source) = min(sampleSize, SAMPLE_WEIGHT_CAP) x priority', () => {
    expect(SAMPLE_WEIGHT_CAP).toBe(10)
    expect(FIRST_PARTY_SOURCE_PRIORITY).toBe(2)
    expect(EXTERNAL_SOURCE_PRIORITY).toBe(1)
  })

  it('4 strong first-party sales vs 100 external observations: external sample count is capped, first-party is not overwhelmed', () => {
    const v = fp({ sampleCount: 4, effectiveSampleCount: 4, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, confidence: 'medium', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 2000, p25Cents: 1900, p75Cents: 2100, minCents: 1800, maxCents: 2200, sampleSize: 100, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)

    const fpWeight = Math.min(4, SAMPLE_WEIGHT_CAP) * FIRST_PARTY_SOURCE_PRIORITY // 8
    const extWeight = Math.min(100, SAMPLE_WEIGHT_CAP) * EXTERNAL_SOURCE_PRIORITY // 10
    const expected = Math.round((1000 * fpWeight + 2000 * extWeight) / (fpWeight + extWeight))
    expect(r.estimatedValueCents).toBe(expected) // 1556 — meaningfully pulled toward first-party's $10.00

    // Regression guard: the pre-fix uncapped formula would have put this within
    // $0.75 of the external median ($19.26 of $20.00) — external count alone must
    // not be allowed to get anywhere near that close.
    expect(Math.abs(r.estimatedValueCents! - 2000)).toBeGreaterThan(300)
  })

  it('10 first-party vs 10 external (both under the cap, no saturation triggered): first-party still leads via 2x source priority', () => {
    const v = fp({ sampleCount: 10, effectiveSampleCount: 10, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, confidence: 'high', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 2000, p25Cents: 1900, p75Cents: 2100, minCents: 1800, maxCents: 2200, sampleSize: 10, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)

    const expected = Math.round((1000 * 20 + 2000 * 10) / 30) // fpWeight=20, extWeight=10
    expect(r.estimatedValueCents).toBe(expected)
    expect(Math.abs(r.estimatedValueCents! - 1000)).toBeLessThan(Math.abs(r.estimatedValueCents! - 2000)) // closer to first-party
  })

  it('external-only sample count beyond the cap does not change the result once already at the cap', () => {
    const e10 = ext({ soldSummary: { medianCents: 1500, p25Cents: 1400, p75Cents: 1600, minCents: 1300, maxCents: 1700, sampleSize: 10, freshestSoldAt: ASOF, stalestSoldAt: ASOF, extendedHistoryUsed: false, windowMonths: 12 } })
    const e1000 = ext({ soldSummary: { ...e10.soldSummary!, sampleSize: 1000 } })
    const r10 = buildPricingIntelligence('cat1', 'insufficient', fp(), e10, NO_CNT_ASK, ASOF)
    const r1000 = buildPricingIntelligence('cat1', 'insufficient', fp(), e1000, NO_CNT_ASK, ASOF)
    expect(r10.estimatedValueCents).toBe(r1000.estimatedValueCents) // external-only, so the median is used directly either way
  })

  it('first-party-only: full weight regardless of cap (no external to compete with)', () => {
    const v = fp({ sampleCount: 15, effectiveSampleCount: 15, unweightedMedian: 1200, lowEstimate: 1100, highEstimate: 1300, confidence: 'high', latestSaleAt: ASOF })
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    expect(r.estimatedValueCents).toBe(1200)
  })

  it('strongly disagreeing sources still blend deterministically via the capped weights, never picking one side arbitrarily', () => {
    const v = fp({ sampleCount: 5, effectiveSampleCount: 5, unweightedMedian: 500, lowEstimate: 450, highEstimate: 550, confidence: 'medium', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 5000, p25Cents: 4800, p75Cents: 5200, minCents: 4700, maxCents: 5300, sampleSize: 20, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    const fpWeight = Math.min(5, SAMPLE_WEIGHT_CAP) * FIRST_PARTY_SOURCE_PRIORITY
    const extWeight = Math.min(20, SAMPLE_WEIGHT_CAP) * EXTERNAL_SOURCE_PRIORITY
    const expected = Math.round((500 * fpWeight + 5000 * extWeight) / (fpWeight + extWeight))
    expect(r.estimatedValueCents).toBe(expected)
    expect(r.confidence.reasons.some(x => x.toLowerCase().includes('diverge'))).toBe(true)
  })
})

describe('pricingIntelligence: confidence sample-depth ceilings (section 3)', () => {
  it('1 first-party + 1 external sale agreeing exactly cannot reach high confidence', () => {
    const v = fp({ sampleCount: 1, effectiveSampleCount: 1, unweightedMedian: 1000, lowEstimate: 1000, highEstimate: 1000, confidence: 'low', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 1000, p25Cents: 1000, p75Cents: 1000, minCents: 1000, maxCents: 1000, sampleSize: 1, freshestSoldAt: ASOF, stalestSoldAt: ASOF, extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.confidence.level).not.toBe('high')
    expect(r.confidence.level).toBe('low') // totalSoldSample=2 < SAMPLE_CEILING_LOW(3)
  })

  it('totalSoldSample below the low ceiling cannot exceed low even with strong agreement', () => {
    const v = fp({ sampleCount: 2, effectiveSampleCount: 2, unweightedMedian: 1000, lowEstimate: 950, highEstimate: 1050, confidence: 'medium', latestSaleAt: ASOF })
    // totalSoldSample = 2 (fp only) -> below SAMPLE_CEILING_LOW(3)
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    expect(r.confidence.level).toBe('low')
  })

  it('totalSoldSample between the low and medium ceilings cannot exceed medium', () => {
    const v = fp({ sampleCount: 5, effectiveSampleCount: 5, unweightedMedian: 1000, lowEstimate: 950, highEstimate: 1050, confidence: 'high', latestSaleAt: ASOF })
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF) // totalSoldSample=5, below SAMPLE_CEILING_MEDIUM(6)
    expect(r.confidence.level).not.toBe('high')
  })

  it('high dispersion caps confidence at medium even when sources agree', () => {
    const v = fp({ sampleCount: 10, effectiveSampleCount: 10, unweightedMedian: 1000, lowEstimate: 200, highEstimate: 2000, confidence: 'high', latestSaleAt: ASOF }) // huge low/high spread
    const e = ext({ soldSummary: { medianCents: 1000, p25Cents: 200, p75Cents: 2000, minCents: 100, maxCents: 2500, sampleSize: 10, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.confidence.reasons.some(x => x.toLowerCase().includes('dispersion'))).toBe(true)
    expect(r.confidence.level).not.toBe('high')
  })

  it('stale external evidence caps confidence at medium', () => {
    const v = fp({ sampleCount: 10, effectiveSampleCount: 10, unweightedMedian: 1000, lowEstimate: 950, highEstimate: 1050, confidence: 'high', latestSaleAt: ASOF })
    const e = ext({
      soldSummary: { medianCents: 1010, p25Cents: 950, p75Cents: 1060, minCents: 900, maxCents: 1100, sampleSize: 10, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 },
      researchFreshness: 'stale',
    })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.confidence.level).not.toBe('high')
    expect(r.confidence.reasons.some(x => x.toLowerCase().includes('stale'))).toBe(true)
  })

  it('large outlier-exclusion ratio caps confidence at medium', () => {
    const v = fp({ sampleCount: 10, effectiveSampleCount: 6, unweightedMedian: 1000, lowEstimate: 950, highEstimate: 1050, confidence: 'high', latestSaleAt: ASOF, outliersRemoved: true }) // 40% excluded
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    expect(r.confidence.level).not.toBe('high')
    expect(r.confidence.reasons.some(x => x.toLowerCase().includes('outlier'))).toBe(true)
  })

  it('extended-history evidence caps confidence at medium, even with cross-source agreement', () => {
    const v = fp({ sampleCount: 8, effectiveSampleCount: 8, unweightedMedian: 1000, lowEstimate: 950, highEstimate: 1050, confidence: 'medium', latestSaleAt: new Date('2023-01-01'), extendedHistoryUsed: true })
    const e = ext({ soldSummary: { medianCents: 1010, p25Cents: 950, p75Cents: 1060, minCents: 900, maxCents: 1100, sampleSize: 10, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.confidence.level).not.toBe('high')
    expect(r.confidence.reasons.some(x => x.toLowerCase().includes('extended'))).toBe(true)
  })

  it('ask-only is always insufficient, never upgraded by anything', () => {
    const cnt = { activeListingCount: 5, lowestAskCents: 900, medianAskCents: 1000, highestAskCents: 1100 }
    const r = buildPricingIntelligence('cat1', 'insufficient', fp(), ext({ askSummary: { count: 20, medianCents: 1000, p75Cents: 1100, highestActiveAskCents: 1200 } }), cnt, ASOF)
    expect(r.confidence.level).toBe('insufficient')
  })

  it('a genuinely strong case (large sample, agreement, no dispersion/staleness/extended-history) can still reach high', () => {
    const v = fp({ sampleCount: 10, effectiveSampleCount: 10, unweightedMedian: 1000, lowEstimate: 950, highEstimate: 1050, confidence: 'high', latestSaleAt: ASOF, extendedHistoryUsed: false })
    const e = ext({ soldSummary: { medianCents: 1020, p25Cents: 970, p75Cents: 1070, minCents: 930, maxCents: 1120, sampleSize: 10, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.confidence.level).toBe('high') // sanity check: ceilings don't over-suppress a genuinely strong case
  })
})

describe('pricingIntelligence: extended-evidence labeling (section 6)', () => {
  it('explanation states extended/older evidence was used, not described as recent', () => {
    const v = fp({ sampleCount: 4, effectiveSampleCount: 4, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, confidence: 'low', latestSaleAt: new Date('2022-01-01'), extendedHistoryUsed: true })
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    expect(r.explanation.toLowerCase()).toContain('extended')
    expect(r.warnings.some(w => w.toLowerCase().includes('extended'))).toBe(true)
  })

  it('evidence windowLabel is "all-time (extended)", never a bare "last 24 months" claim, when extended history was used', () => {
    const v = fp({ sampleCount: 4, effectiveSampleCount: 4, extendedHistoryUsed: true })
    const summary = firstPartyEvidenceSummary(v)
    expect(summary.windowLabel.toLowerCase()).toContain('all-time')
    expect(summary.windowLabel.toLowerCase()).toContain('extended')
    expect(summary.windowLabel.toLowerCase()).not.toBe('last 24 months') // not mislabeled as the primary recent window
  })
})

describe('pricingIntelligence: recommendation range provenance (section 5)', () => {
  it('active asks (first-party or external) never move the sold-evidence central estimate', () => {
    const v = fp({ sampleCount: 8, effectiveSampleCount: 8, unweightedMedian: 1500, lowEstimate: 1400, highEstimate: 1600, confidence: 'high', latestSaleAt: ASOF })
    const noAsk = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    const extremeAsk = buildPricingIntelligence('cat1', 'exact', v,
      ext({ askSummary: { count: 50, medianCents: 9000, p75Cents: 9500, highestActiveAskCents: 10000 }, lowestActiveAskCents: 8000 }),
      { activeListingCount: 10, lowestAskCents: 100, medianAskCents: 200, highestAskCents: 300 },
      ASOF)
    expect(extremeAsk.estimatedValueCents).toBe(noAsk.estimatedValueCents)
    expect(extremeAsk.recommendedListing).toEqual(noAsk.recommendedListing)
  })

  it('low/high derive from sample-weighted p25/p75 of sold evidence only — same weights as the target formula', () => {
    const v = fp({ sampleCount: 6, effectiveSampleCount: 6, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, confidence: 'medium', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 1200, p25Cents: 1100, p75Cents: 1300, minCents: 1000, maxCents: 1400, sampleSize: 8, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    const fpWeight = Math.min(6, SAMPLE_WEIGHT_CAP) * FIRST_PARTY_SOURCE_PRIORITY
    const extWeight = Math.min(8, SAMPLE_WEIGHT_CAP) * EXTERNAL_SOURCE_PRIORITY
    const expectedLow = Math.round((900 * fpWeight + 1100 * extWeight) / (fpWeight + extWeight))
    const expectedHigh = Math.round((1100 * fpWeight + 1300 * extWeight) / (fpWeight + extWeight))
    expect(r.recommendedListing.lowCents).toBe(expectedLow)
    expect(r.recommendedListing.highCents).toBe(expectedHigh)
  })
})

describe('pricingIntelligence: recommendation constraints', () => {
  it('low <= target <= high always holds', () => {
    const v = fp({ sampleCount: 8, effectiveSampleCount: 8, unweightedMedian: 1500, lowEstimate: 1600, highEstimate: 1400, confidence: 'high', latestSaleAt: ASOF }) // deliberately inverted low/high input
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    const { lowCents, targetCents, highCents } = r.recommendedListing
    expect(lowCents).not.toBeNull()
    expect(lowCents!).toBeLessThanOrEqual(targetCents!)
    expect(targetCents!).toBeLessThanOrEqual(highCents!)
  })

  it('never recommends a non-positive price', () => {
    const v = fp({ sampleCount: 1, effectiveSampleCount: 1, unweightedMedian: 0, lowEstimate: 0, highEstimate: 0, confidence: 'low' })
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    expect(r.recommendedListing.targetCents).toBeNull()
  })

  it('widens the range using a symmetric fallback band when p25/p75 are unavailable on the dominant source', () => {
    const e = ext({ soldSummary: { medianCents: 2000, p25Cents: 2000, p75Cents: 2000, minCents: 2000, maxCents: 2000, sampleSize: 3, freshestSoldAt: ASOF, stalestSoldAt: ASOF, extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', fp(), e, NO_CNT_ASK, ASOF)
    expect(r.recommendedListing.lowCents).toBeLessThanOrEqual(r.recommendedListing.targetCents!)
    expect(r.recommendedListing.highCents).toBeGreaterThanOrEqual(r.recommendedListing.targetCents!)
  })
})

describe('pricingIntelligence: listing price comparison (section 17)', () => {
  it('classifies a listing priced within the tolerance band as within_guidance', () => {
    expect(classifyListingPosition(1000, 1000)).toBe('within_guidance')
    expect(classifyListingPosition(1049, 1000)).toBe('within_guidance') // 4.9% above, within 5% band
  })

  it('classifies materially above/below guidance correctly, using the centralized tolerance', () => {
    expect(classifyListingPosition(1200, 1000)).toBe('above_guidance')
    expect(classifyListingPosition(800, 1000)).toBe('below_guidance')
    expect(GUIDANCE_TOLERANCE_PCT).toBe(0.05)
  })

  it('compareListingToGuidance returns unavailable with null diffs when there is no target', () => {
    const c = compareListingToGuidance(1500, null)
    expect(c.classification).toBe('unavailable')
    expect(c.absoluteDiffCents).toBeNull()
    expect(c.percentDiff).toBeNull()
  })

  it('compareListingToGuidance computes absolute and percent diff deterministically', () => {
    const c = compareListingToGuidance(1100, 1000)
    expect(c.absoluteDiffCents).toBe(100)
    expect(c.percentDiff).toBe(10)
    expect(c.classification).toBe('above_guidance')
  })
})

describe('pricingIntelligence: missing-data behavior (section 26)', () => {
  it('never displays $0 for missing evidence — estimatedValueCents is null, not 0', () => {
    const r = buildPricingIntelligence('cat1', 'insufficient', fp(), ext(), NO_CNT_ASK, ASOF)
    expect(r.estimatedValueCents).toBeNull()
    expect(r.estimatedValueCents).not.toBe(0)
  })

  it('explanation distinguishes "no sold evidence" from "ask-only" from full insufficiency', () => {
    const noneAtAll = buildPricingIntelligence('cat1', 'insufficient', fp(), ext(), NO_CNT_ASK, ASOF)
    expect(noneAtAll.explanation.toLowerCase()).toContain('no completed sales')

    const askOnly = buildPricingIntelligence('cat1', 'insufficient', fp(), ext(), { activeListingCount: 2, lowestAskCents: 1000, medianAskCents: 1100, highestAskCents: 1200 }, ASOF)
    expect(askOnly.explanation.toLowerCase()).toContain('ask-only')
  })
})

describe('pricingIntelligence: explainability (section 25)', () => {
  it('explanation cites sample counts and both medians when both sources present', () => {
    const v = fp({ sampleCount: 6, effectiveSampleCount: 6, unweightedMedian: 1850, lowEstimate: 1700, highEstimate: 2000, confidence: 'medium', latestSaleAt: ASOF })
    const e = ext({ soldSummary: { medianCents: 1925, p25Cents: 1800, p75Cents: 2050, minCents: 1700, maxCents: 2100, sampleSize: 14, freshestSoldAt: ASOF, stalestSoldAt: new Date('2025-09-01'), extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(r.explanation).toContain('6 completed first-party sales')
    expect(r.explanation).toContain('14 external sold observations')
    expect(r.explanation).toContain('$18.50')
    expect(r.explanation).toContain('$19.25')
  })
})

describe('pricingIntelligence: determinism', () => {
  it('same inputs produce the same result object (no randomization, no hidden current-time reads)', () => {
    const v = fp({ sampleCount: 5, effectiveSampleCount: 5, unweightedMedian: 1500, lowEstimate: 1300, highEstimate: 1700, confidence: 'medium', latestSaleAt: ASOF })
    const r1 = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    const r2 = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    expect(r1).toEqual(r2)
  })
})

describe('pricingIntelligence: money precision (integer cents, no JS Float accumulation)', () => {
  it('blends awkward cent values (1, 10, 1999) without drift', () => {
    const v = fp({ sampleCount: 3, effectiveSampleCount: 3, unweightedMedian: 1, lowEstimate: 1, highEstimate: 10, confidence: 'low' })
    const e = ext({ soldSummary: { medianCents: 1999, p25Cents: 1900, p75Cents: 2050, minCents: 1800, maxCents: 2100, sampleSize: 5, freshestSoldAt: ASOF, stalestSoldAt: ASOF, extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', v, e, NO_CNT_ASK, ASOF)
    expect(Number.isInteger(r.estimatedValueCents)).toBe(true)
    expect(Number.isInteger(r.recommendedListing.lowCents!)).toBe(true)
    expect(Number.isInteger(r.recommendedListing.highCents!)).toBe(true)
  })

  it('percentDiff rounds deterministically for awkward percentages (compareListingToGuidance)', () => {
    expect(compareListingToGuidance(1999, 2000).percentDiff).toBe(-0.05)
    expect(compareListingToGuidance(1, 3).percentDiff).toBe(-66.67)
  })

  it('all recommended cent values are whole integers — no fractional-cent precision anywhere', () => {
    const v = fp({ sampleCount: 7, effectiveSampleCount: 7, unweightedMedian: 1033, lowEstimate: 999, highEstimate: 1177, confidence: 'medium', latestSaleAt: ASOF })
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    for (const c of [r.estimatedValueCents, r.recommendedListing.lowCents, r.recommendedListing.targetCents, r.recommendedListing.highCents]) {
      if (c !== null) expect(Number.isInteger(c)).toBe(true)
    }
  })
})

describe('pricingIntelligence: safety/scope', () => {
  it('result contains no buyer/seller PII fields', () => {
    const v = fp({ sampleCount: 4, effectiveSampleCount: 4, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, confidence: 'medium', latestSaleAt: ASOF })
    const r = buildPricingIntelligence('cat1', 'exact', v, ext(), NO_CNT_ASK, ASOF)
    const json = JSON.stringify(r)
    for (const forbidden of ['buyerName', 'buyerEmail', 'sellerName', 'sellerEmail', 'orderId', 'purchasePrice']) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('result never exposes raw external provider payloads — only counts/medians', () => {
    const e = ext({ providers: ['ebay'], soldSummary: { medianCents: 1000, p25Cents: 900, p75Cents: 1100, minCents: 800, maxCents: 1200, sampleSize: 4, freshestSoldAt: ASOF, stalestSoldAt: ASOF, extendedHistoryUsed: false, windowMonths: 12 } })
    const r = buildPricingIntelligence('cat1', 'exact', fp(), e, NO_CNT_ASK, ASOF)
    const json = JSON.stringify(r)
    expect(json).not.toContain('rawSnapshot')
    expect(json).not.toContain('sourceUrl')
  })
})

describe('pricingIntelligence: ask-only vs sold-evidence UI labeling (section 4)', () => {
  const adminPanel = readSrc('src/components/admin/PricingIntelligencePanel.tsx')
  const adminList = readSrc('src/app/(admin)/admin/valuation/page.tsx')
  const sellerSummary = readSrc('src/components/store/PricingIntelligenceSummary.tsx')

  it('admin detail panel never labels ask-only guidance as "Estimated Value"/"Recommended Range" without a distinct ask-only heading', () => {
    expect(adminPanel).toContain('isAskOnly')
    expect(adminPanel.toLowerCase()).toContain('ask-only market context')
    expect(adminPanel.toLowerCase()).toContain('current asking-price range')
    expect(adminPanel.toLowerCase()).toContain('no completed-sale evidence is available')
  })

  it('admin opportunity list marks ask-only rows distinctly instead of showing a bare dollar estimate', () => {
    expect(adminList).toContain('isAskOnly')
    expect(adminList.toLowerCase()).toContain('no sold evidence')
  })

  it('seller-facing summary renders a distinct "Active ask context" block for ask-only results, never "Estimated market value"', () => {
    expect(sellerSummary).toContain('result.isAskOnly')
    expect(sellerSummary.toLowerCase()).toContain('active ask context')
    expect(sellerSummary.toLowerCase()).toContain('not a validated market value')
    // The ask-only branch must return before the "Estimated market value" heading renders.
    const askOnlyIdx = sellerSummary.indexOf('if (result.isAskOnly)')
    const estimatedHeadingIdx = sellerSummary.indexOf('Estimated market value')
    expect(askOnlyIdx).toBeGreaterThan(-1)
    expect(askOnlyIdx).toBeLessThan(estimatedHeadingIdx)
  })

  it('sold-evidence (non-ask-only) results still use "Estimated value" / "Recommended listing range" labels', () => {
    expect(adminPanel).toContain('Estimated Value')
    expect(adminPanel).toContain('Recommended Range')
    expect(sellerSummary).toContain('Estimated market value')
    expect(sellerSummary).toContain('Recommended range')
  })
})
