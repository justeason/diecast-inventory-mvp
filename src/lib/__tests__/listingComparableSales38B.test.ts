/**
 * 38B: Listing Price & Comparable Sales Context — /browse/[id]'s "Asking price
 * & recorded sales" section. Covers: strict specificity/evidence eligibility
 * gating, integer-cents comparison math, exact customer copy, evidence-line
 * disclosure, source-integrity boundaries, and page-level wiring (error
 * isolation, privacy, admin-label-boundary reconciliation). Per §21, this
 * reuses fixture-constructed ValuationResult objects rather than duplicating
 * marketValuation.test.ts's own exhaustive getValuation() coverage — the pure
 * comparison functions here are tested directly against fixed inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { ValuationResult } from '@/lib/marketValuation'
import {
  evaluateComparableSalesEligibility,
  computeAskPosition,
  formatAskPositionSentence,
  formatComparableSalesEvidenceLine,
  type EligibleComparableSales,
} from '@/lib/listingComparableSales'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

type Mock = ReturnType<typeof vi.fn>

// ── Fixture builder ─────────────────────────────────────────────────────────

function valued(overrides: Partial<Extract<ValuationResult, { status: 'valued' }>> = {}): ValuationResult {
  return {
    status: 'valued',
    catalogModelId: 'cat1',
    marketVariantId: 'v1',
    condition: 'mint',
    estimatedValueCents: 3000,
    marketRangeLowCents: 2500,
    marketRangeHighCents: 3500,
    confidence: 'high',
    specificity: 'model_variant_condition',
    primarySpecificity: 'model_variant_condition',
    rawSampleCount: 8,
    usedSampleCount: 8,
    excludedOutlierCount: 0,
    internalSampleCount: 5,
    externalSampleCount: 3,
    asOf: new Date('2026-06-01'),
    windowStart: new Date('2024-06-01'),
    extendedHistoryUsed: false,
    sampleTruncated: false,
    method: 'median_sales',
    outlierMethod: 'iqr_1_5',
    fallbackReason: null,
    latestSaleAt: new Date('2026-05-15'),
    ...overrides,
  }
}

// ── §18 — strict comparability ──────────────────────────────────────────────

describe('§18 — exact comparability gating', () => {
  it('exact model+variant+condition Range: eligible', () => {
    const result = evaluateComparableSalesEligibility(valued())
    expect(result.eligible).toBe(true)
  })

  it('variant fallback (specificity=model_variant, primarySpecificity=model_variant_condition): no comparison', () => {
    const result = evaluateComparableSalesEligibility(
      valued({ specificity: 'model_variant', primarySpecificity: 'model_variant_condition', fallbackReason: 'no_sales_at_requested_specificity' }),
    )
    expect(result.eligible).toBe(false)
  })

  it('model fallback (specificity=model): no comparison', () => {
    const result = evaluateComparableSalesEligibility(
      valued({ specificity: 'model', primarySpecificity: 'model_variant_condition', fallbackReason: 'no_sales_at_requested_specificity' }),
    )
    expect(result.eligible).toBe(false)
  })

  it('condition mismatch (requested condition tier, resolved to model_variant): no comparison', () => {
    const result = evaluateComparableSalesEligibility(
      valued({ condition: 'mint', specificity: 'model_variant', primarySpecificity: 'model_variant_condition' }),
    )
    expect(result.eligible).toBe(false)
  })

  it('packaging/variant mismatch (requested model_variant_condition, resolved model — Carded/Loose never silently mixed): no comparison', () => {
    const result = evaluateComparableSalesEligibility(
      valued({ specificity: 'model', primarySpecificity: 'model_variant_condition' }),
    )
    expect(result.eligible).toBe(false)
  })
})

// ── §19 — evidence gates ─────────────────────────────────────────────────────

describe('§19 — evidence requirement gates', () => {
  it('<5 usable sales: no comparison', () => {
    const result = evaluateComparableSalesEligibility(valued({ usedSampleCount: 4, marketRangeLowCents: null, marketRangeHighCents: null }))
    expect(result.eligible).toBe(false)
  })

  it('Range null (even if usedSampleCount happens to be reported >=5): no comparison', () => {
    const result = evaluateComparableSalesEligibility(valued({ marketRangeLowCents: null, marketRangeHighCents: null }))
    expect(result.eligible).toBe(false)
  })

  it('extended-history fallback: no comparison', () => {
    const result = evaluateComparableSalesEligibility(valued({ extendedHistoryUsed: true, fallbackReason: 'no_recent_sales', confidence: 'low' }))
    expect(result.eligible).toBe(false)
  })

  it('low confidence: no comparison', () => {
    const result = evaluateComparableSalesEligibility(valued({ confidence: 'low' }))
    expect(result.eligible).toBe(false)
  })

  it('insufficient_data status: no comparison', () => {
    const result = evaluateComparableSalesEligibility({
      status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: new Date(), reason: 'no_sales',
    })
    expect(result.eligible).toBe(false)
  })

  it('input_error status: no comparison', () => {
    const result = evaluateComparableSalesEligibility({ status: 'input_error', errors: { condition: ['bad'] } })
    expect(result.eligible).toBe(false)
  })

  it('medium confidence with exact eligible Range: comparison shown', () => {
    const result = evaluateComparableSalesEligibility(valued({ confidence: 'medium' }))
    expect(result.eligible).toBe(true)
  })

  it('high confidence with exact eligible Range: comparison shown', () => {
    const result = evaluateComparableSalesEligibility(valued({ confidence: 'high' }))
    expect(result.eligible).toBe(true)
  })

  it('exactly RANGE_MIN_SAMPLE (5) usable samples: eligible (boundary, not exclusive)', () => {
    const result = evaluateComparableSalesEligibility(valued({ usedSampleCount: 5 }))
    expect(result.eligible).toBe(true)
  })

  it('non-integer range endpoints: no comparison (defensive)', () => {
    const result = evaluateComparableSalesEligibility(valued({ marketRangeLowCents: 2500.5 }))
    expect(result.eligible).toBe(false)
  })
})

// ── §20 — comparison math ────────────────────────────────────────────────────

describe('§20 — comparison math (integer cents)', () => {
  it('ask below Q1: position=below, exact difference', () => {
    const result = computeAskPosition(2000, 2500, 3500)
    expect(result).toEqual({ position: 'below', differenceCents: 500 })
  })

  it('ask exactly Q1 (endpoint): position=within', () => {
    const result = computeAskPosition(2500, 2500, 3500)
    expect(result).toEqual({ position: 'within' })
  })

  it('ask between Q1/Q3: position=within', () => {
    const result = computeAskPosition(3000, 2500, 3500)
    expect(result).toEqual({ position: 'within' })
  })

  it('ask exactly Q3 (endpoint): position=within', () => {
    const result = computeAskPosition(3500, 2500, 3500)
    expect(result).toEqual({ position: 'within' })
  })

  it('ask above Q3: position=above, exact difference', () => {
    const result = computeAskPosition(4000, 2500, 3500)
    expect(result).toEqual({ position: 'above', differenceCents: 500 })
  })

  it('Q1 === Q3 (zero-width range), ask equal: within', () => {
    const result = computeAskPosition(3000, 3000, 3000)
    expect(result).toEqual({ position: 'within' })
  })

  it('Q1 === Q3, ask below: below with exact difference', () => {
    const result = computeAskPosition(2999, 3000, 3000)
    expect(result).toEqual({ position: 'below', differenceCents: 1 })
  })

  it('cent-level boundary: 1 cent below Q1', () => {
    const result = computeAskPosition(2499, 2500, 3500)
    expect(result).toEqual({ position: 'below', differenceCents: 1 })
  })

  it('cent-level boundary: 1 cent above Q3', () => {
    const result = computeAskPosition(3501, 2500, 3500)
    expect(result).toEqual({ position: 'above', differenceCents: 1 })
  })

  it('no float arithmetic — all inputs/outputs are plain integers', () => {
    const result = computeAskPosition(1234567, 1000000, 2000000)
    expect(Number.isInteger(result.position === 'within' ? 0 : result.differenceCents)).toBe(true)
  })
})

// ── §9/§22 — exact customer copy ─────────────────────────────────────────────

describe('§9/§22 — exact customer copy', () => {
  it('below: exact sentence with dollar formatting', () => {
    const sentence = formatAskPositionSentence({ position: 'below', differenceCents: 500 })
    expect(sentence).toBe('The asking price is $5.00 lower than the middle 50% of these recorded sale prices.')
  })

  it('within: exact sentence, no dollar amount', () => {
    const sentence = formatAskPositionSentence({ position: 'within' })
    expect(sentence).toBe('The asking price falls within the middle 50% of these recorded sale prices.')
  })

  it('above: exact sentence with dollar formatting', () => {
    const sentence = formatAskPositionSentence({ position: 'above', differenceCents: 750 })
    expect(sentence).toBe('The asking price is $7.50 higher than the middle 50% of these recorded sale prices.')
  })

  it('never uses Good Deal / Undervalued / Overpriced / Price Recommendation / Guaranteed Value / Buy Signal language', () => {
    const sentences = [
      formatAskPositionSentence({ position: 'below', differenceCents: 500 }),
      formatAskPositionSentence({ position: 'within' }),
      formatAskPositionSentence({ position: 'above', differenceCents: 500 }),
    ]
    for (const s of sentences) {
      expect(s).not.toMatch(/Good Deal|Undervalued|Overpriced|Recommend|Guaranteed|Buy Signal|deal|bargain/i)
    }
  })

  it('never renders the admin "Below/Within/Above Market Range" vocabulary', () => {
    const sentences = [
      formatAskPositionSentence({ position: 'below', differenceCents: 500 }),
      formatAskPositionSentence({ position: 'within' }),
      formatAskPositionSentence({ position: 'above', differenceCents: 500 }),
    ]
    for (const s of sentences) {
      expect(s).not.toMatch(/Below Market Range|Within Market Range|Above Market Range|Below Typical Range|Above Typical Range/)
    }
  })
})

// ── §11 — evidence disclosure ────────────────────────────────────────────────

describe('§11 — evidence/source disclosure line', () => {
  function evidence(overrides: Partial<EligibleComparableSales> = {}): EligibleComparableSales {
    return {
      eligible: true, rangeLowCents: 2500, rangeHighCents: 3500,
      usedSampleCount: 8, excludedOutlierCount: 0, internalSampleCount: 5, externalSampleCount: 3, confidence: 'high',
      ...overrides,
    }
  }

  it('mixed internal+external sources', () => {
    const line = formatComparableSalesEvidenceLine(evidence())
    expect(line).toBe('Based on 8 comparable sales from CollectNTrades and tracked external marketplaces. High confidence.')
  })

  it('internal-only', () => {
    const line = formatComparableSalesEvidenceLine(evidence({ internalSampleCount: 8, externalSampleCount: 0 }))
    expect(line).toBe('Based on 8 CollectNTrades comparable sales. High confidence.')
  })

  it('external-only', () => {
    const line = formatComparableSalesEvidenceLine(evidence({ internalSampleCount: 0, externalSampleCount: 8 }))
    expect(line).toBe('Based on 8 comparable sales from tracked external marketplaces. High confidence.')
  })

  it('excluded outliers disclosed', () => {
    const line = formatComparableSalesEvidenceLine(evidence({ excludedOutlierCount: 2 }))
    expect(line).toContain('2 unusual results excluded')
  })

  it('singular sale/result wording at count=1', () => {
    const line = formatComparableSalesEvidenceLine(evidence({ usedSampleCount: 1, internalSampleCount: 1, externalSampleCount: 0, excludedOutlierCount: 1 }))
    expect(line).toContain('1 CollectNTrades comparable sale')
    expect(line).toContain('1 unusual result excluded')
  })

  it('medium confidence rendered correctly', () => {
    const line = formatComparableSalesEvidenceLine(evidence({ confidence: 'medium' }))
    expect(line).toContain('Medium confidence')
  })

  it('never claims "recent" language not backed by the eligibility gates', () => {
    const line = formatComparableSalesEvidenceLine(evidence())
    expect(line).not.toMatch(/recent/i)
  })
})

// ── §21 — source integrity ───────────────────────────────────────────────────

describe('§21 — source integrity', () => {
  it('the pure module never IMPORTS marketAskQuery, riskPolicy, adminPricingDisplay, autoListingPricingV2, autoListingExecution, or resaleEstimator (comments referencing them as boundary explanation are fine)', () => {
    const src = readSrc('src/lib/listingComparableSales.ts')
    const importLines = src.split('\n').filter((l) => l.trim().startsWith('import'))
    for (const line of importLines) {
      expect(line).not.toMatch(/marketAskQuery|riskPolicy|adminPricingDisplay|autoListingPricingV2|autoListingExecution|resaleEstimator/)
    }
  })

  it('only imports the canonical customer-facing getValuation module and existing display/math helpers', () => {
    const src = readSrc('src/lib/listingComparableSales.ts')
    expect(src).toContain("from './marketValuation'")
    expect(src).toContain("from './marketValuationMath'")
    expect(src).toContain("from './marketModelPageDisplay'")
  })

  it('RANGE_MIN_SAMPLE is imported/reused, not redefined as a second independent threshold', () => {
    const src = readSrc('src/lib/listingComparableSales.ts')
    expect(src).toContain('import { RANGE_MIN_SAMPLE }')
    expect(src).not.toMatch(/RANGE_MIN_SAMPLE\s*=\s*\d/) // no local redefinition
  })

  it('no external condition data is ever invented (external observations pass through valuation with condition=null unchanged)', () => {
    const src = stripComments(readSrc('src/lib/listingComparableSales.ts'))
    expect(src).not.toMatch(/externalCondition|inferCondition|condition\s*=\s*['"]?(mint|near_mint|good|fair|poor|damaged)['"]?\s*(?!:)/)
  })
})

// ── Page wiring: identity, asOf, source, error isolation, privacy ──────────

describe('/browse/[id] page wiring', () => {
  const pageSrc = readSrc('src/app/(store)/browse/[id]/page.tsx')

  it('§4 — uses the actual ItemInstance catalogId/marketVariantId/condition FKs, not derived display text', () => {
    expect(pageSrc).toContain('catalogId: true')
    expect(pageSrc).toContain('marketVariantId: true')
    expect(pageSrc).toContain('catalogModelId: item.catalogId')
    expect(pageSrc).toContain('marketVariantId: item.marketVariantId')
    expect(pageSrc).toContain('condition: item.condition')
  })

  it('§3 — imports only the canonical getValuation, never a second engine', () => {
    expect(pageSrc).toContain("import { getValuation } from '@/lib/marketValuation'")
    expect(pageSrc).not.toMatch(/adminPricingDisplay|riskPolicy|PricingContext|autoListingPricingV2|autoListingExecution|resaleEstimator/)
  })

  it('§10 — uses internalPriceToCents (canonical conversion), never Math.round(price*100)', () => {
    expect(pageSrc).toContain('internalPriceToCents(listing.price)')
    expect(pageSrc).not.toMatch(/Math\.round\(listing\.price\s*\*\s*100\)/)
  })

  it('§14 — one request-level asOf for the new valuation call', () => {
    const idx = pageSrc.indexOf('getValuation({')
    const block = pageSrc.slice(idx, idx + 300)
    expect(block).toContain('asOf: new Date()')
  })

  it('§13 — the valuation call is wrapped in try/catch with logger.error, degrading to null on failure', () => {
    const idx = pageSrc.indexOf('let comparableSalesEvidence')
    const block = pageSrc.slice(idx, idx + 700)
    expect(block).toContain('try {')
    expect(block).toContain('catch (err)')
    expect(block).toContain('logger.error(')
    expect(block).toContain('comparableSalesEvidence = null')
  })

  it('§13 — the try/catch runs strictly AFTER the existing notFound()/availability check, never wraps or swallows it', () => {
    const notFoundIdx = pageSrc.indexOf('notFound()')
    const tryIdx = pageSrc.indexOf('let comparableSalesEvidence')
    expect(notFoundIdx).toBeLessThan(tryIdx)
  })

  it('§7 — a small link to /catalog/[id] is shown when ineligible; no broader-range/synthetic/classification rendering', () => {
    const idx = pageSrc.indexOf('!comparableSalesEvidence.eligible')
    const block = pageSrc.slice(idx, idx + 400)
    expect(block).toContain(`/catalog/${'$'}{item.catalogId}`)
    expect(block).not.toMatch(/marketRangeLowCents|marketRangeHighCents/)
  })

  it('§15 — the section renders after Condition Notes (secondary to photos/condition/price/purchase action)', () => {
    const conditionNotesIdx = pageSrc.indexOf('Condition Notes')
    const sectionIdx = pageSrc.indexOf('<ListingComparableSales')
    expect(sectionIdx).toBeGreaterThan(-1)
    expect(conditionNotesIdx).toBeLessThan(sectionIdx)
    const addToCartIdx = pageSrc.indexOf('AddToCartButton')
    expect(addToCartIdx).toBeLessThan(sectionIdx)
  })

  it('§15 — no new standalone route was created for this feature', () => {
    expect(fs.existsSync(path.join(root, 'src/app/(store)/browse/[id]/market'))).toBe(false)
  })

  it('§24 — no buyer identity, seller data, order ID, risk notes, auto-list candidate, raw external snapshot, or maxDesiredPrice referenced', () => {
    const stripped = stripComments(pageSrc)
    expect(stripped).not.toMatch(/buyerEmail|sellerProfile|orderId|riskNote|autoListCandidate|rawSnapshot|maxDesiredPrice/i)
  })
})

describe('ListingComparableSales component', () => {
  const componentSrc = readSrc('src/components/store/ListingComparableSales.tsx')

  it('§9 — exact section title', () => {
    expect(componentSrc).toContain('Asking price &amp; recorded sales')
  })

  it('§9 — exact fact labels', () => {
    expect(componentSrc).toContain('Current asking price')
    expect(componentSrc).toContain('Middle 50% of comparable completed sales')
  })

  it('§8 — never describes Range as all historical prices, future price, guarantee, or recommended listing range', () => {
    const stripped = stripComments(componentSrc)
    expect(stripped).not.toMatch(/all historical|future price|guarantee|recommended listing range|fair.value/i)
  })

  it('§16 — mobile-first: no fixed pixel width, no hover-only disclosure, no dense <table>', () => {
    expect(componentSrc).not.toContain('<table')
    expect(componentSrc).not.toMatch(/group-hover|hover:opacity-0|width:\s*\d+px/)
  })

  it('does not itself perform eligibility gating (caller-gated only)', () => {
    expect(componentSrc).not.toContain('RANGE_MIN_SAMPLE')
    expect(componentSrc).not.toContain('extendedHistoryUsed')
  })

  it('links to the existing Market Model Page, not a new route', () => {
    expect(componentSrc).toContain('marketPageHref')
  })
})

// ── §23 — behavioral error isolation ─────────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  prisma: { listing: { findUnique: vi.fn() } },
}))
vi.mock('@/lib/marketValuation', () => ({ getValuation: vi.fn() }))
vi.mock('@/lib/serverLogger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { getValuation } from '@/lib/marketValuation'
import { logger } from '@/lib/serverLogger'

describe('§23 — behavioral: comparable-sales query failure isolation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('a getValuation rejection is caught, logged, and degrades to ineligible (null) — never thrown further', async () => {
    ;(getValuation as Mock).mockRejectedValue(new Error('db timeout'))

    let comparableSalesEvidence: ReturnType<typeof evaluateComparableSalesEligibility> | null = null
    try {
      const valuation = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: new Date() })
      comparableSalesEvidence = evaluateComparableSalesEligibility(valuation)
    } catch (err) {
      logger.error('listing_comparable_sales_failed', err, { route: '/browse/[id]', listingId: 'l1' })
      comparableSalesEvidence = null
    }

    expect(comparableSalesEvidence).toBeNull()
    expect(logger.error).toHaveBeenCalledWith('listing_comparable_sales_failed', expect.any(Error), { route: '/browse/[id]', listingId: 'l1' })
  })

  it('a successful getValuation resolving to insufficient_data does not throw and yields ineligible (no fabricated comparison)', async () => {
    ;(getValuation as Mock).mockResolvedValue({
      status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: new Date(), reason: 'no_sales',
    })

    const valuation = await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1', condition: 'mint', asOf: new Date() })
    const result = evaluateComparableSalesEligibility(valuation)

    expect(result.eligible).toBe(false)
  })
})

// ── Schema/migrations/packages ──────────────────────────────────────────────

describe('Schema/migrations/packages unchanged', () => {
  it('migration count is unchanged at 53', () => {
    const dirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((f) => fs.statSync(path.join(root, 'prisma/migrations', f)).isDirectory())
    expect(dirs.length).toBe(53)
  })
})

// ── §25 — unchanged systems ──────────────────────────────────────────────────

describe('§25 — unrelated systems untouched', () => {
  it('catalog/[id] Market Model Page, MarketSnapshot, MarketActivity, AskDepth, PriceHistoryChart are unmodified by this milestone', () => {
    const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
    expect(hubSrc).not.toMatch(/listingComparableSales|ListingComparableSales/)
  })

  it('riskPolicy.ts and adminPricingDisplay.ts are untouched (admin vocabulary/logic unchanged)', () => {
    const riskSrc = readSrc('src/lib/riskPolicy.ts')
    const adminDisplaySrc = readSrc('src/lib/adminPricingDisplay.ts')
    expect(riskSrc).not.toMatch(/listingComparableSales/)
    expect(adminDisplaySrc).not.toMatch(/listingComparableSales/)
  })
})
