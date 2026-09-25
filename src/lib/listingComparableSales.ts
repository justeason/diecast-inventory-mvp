// 38B: pure display-logic for /browse/[id]'s "Asking price & recorded sales"
// section — mirrors marketValuationMath.ts/marketModelPageDisplay.ts's existing
// separation of pure math from orchestration. Consumes ONLY the canonical
// customer-facing getValuation() result (marketValuation.ts) — never a second
// comparison/valuation engine, never adminPricingDisplay.ts/riskPolicy.ts's
// classification vocabulary (that boundary is deliberate — see the existing
// customer-facing tests that forbid "Below/Within/Above Market Range").
import type { ValuationResult } from './marketValuation'
import { RANGE_MIN_SAMPLE } from './marketValuationMath'
import { centsToDisplay } from './marketModelPageDisplay'

type ValuedResult = Extract<ValuationResult, { status: 'valued' }>

export type EligibleComparableSales = {
  eligible: true
  rangeLowCents: number
  rangeHighCents: number
  usedSampleCount: number
  excludedOutlierCount: number
  internalSampleCount: number
  externalSampleCount: number
  confidence: ValuedResult['confidence']
}
export type IneligibleComparableSales = { eligible: false }
export type ComparableSalesEvidence = EligibleComparableSales | IneligibleComparableSales

// §5/§6: strict like-for-like comparability. Every one of these gates must
// hold, or no numerical comparison is shown — never a broader-evidence
// substitute silently labeled as comparable, never a fabricated/synthetic
// range. Reuses the SAME RANGE_MIN_SAMPLE threshold Market Range itself
// already requires — no second, independent sample-size policy.
export function evaluateComparableSalesEligibility(valuation: ValuationResult): ComparableSalesEvidence {
  if (valuation.status !== 'valued') return { eligible: false }
  if (valuation.marketRangeLowCents === null || valuation.marketRangeHighCents === null) return { eligible: false }
  if (valuation.usedSampleCount < RANGE_MIN_SAMPLE) return { eligible: false }
  // §5: exact condition+variant tier only — a fallback to a broader tier
  // (model_variant or model) is never presented as a like-for-like Listing
  // comparison, even though it may remain visible on the Market Model Page.
  if (valuation.specificity !== valuation.primarySpecificity) return { eligible: false }
  if (valuation.extendedHistoryUsed) return { eligible: false }
  if (valuation.confidence !== 'medium' && valuation.confidence !== 'high') return { eligible: false }
  if (!Number.isInteger(valuation.marketRangeLowCents) || !Number.isInteger(valuation.marketRangeHighCents)) return { eligible: false }

  return {
    eligible: true,
    rangeLowCents: valuation.marketRangeLowCents,
    rangeHighCents: valuation.marketRangeHighCents,
    usedSampleCount: valuation.usedSampleCount,
    excludedOutlierCount: valuation.excludedOutlierCount,
    internalSampleCount: valuation.internalSampleCount,
    externalSampleCount: valuation.externalSampleCount,
    confidence: valuation.confidence,
  }
}

export type AskPosition =
  | { position: 'below'; differenceCents: number }
  | { position: 'within' }
  | { position: 'above'; differenceCents: number }

// §10: integer cents only, no tolerance band, no percentage threshold, no
// risk-policy classification — endpoints count as within.
export function computeAskPosition(askCents: number, rangeLowCents: number, rangeHighCents: number): AskPosition {
  if (askCents < rangeLowCents) return { position: 'below', differenceCents: rangeLowCents - askCents }
  if (askCents > rangeHighCents) return { position: 'above', differenceCents: askCents - rangeHighCents }
  return { position: 'within' }
}

// §9: exact customer copy — descriptions of position relative to actual sale
// observations, never a deal-quality label. Never the admin
// "Below/Within/Above Market Range" vocabulary.
export function formatAskPositionSentence(ask: AskPosition): string {
  if (ask.position === 'within') {
    return 'The asking price falls within the middle 50% of these recorded sale prices.'
  }
  const verb = ask.position === 'below' ? 'lower' : 'higher'
  return `The asking price is ${centsToDisplay(ask.differenceCents)} ${verb} than the middle 50% of these recorded sale prices.`
}

// §11: concise evidence/source disclosure line — never claims "recent" beyond
// what the eligibility gates already establish (extendedHistoryUsed=false).
export function formatComparableSalesEvidenceLine(evidence: EligibleComparableSales): string {
  const { usedSampleCount, internalSampleCount, externalSampleCount, excludedOutlierCount, confidence } = evidence
  const saleWord = usedSampleCount === 1 ? 'sale' : 'sales'

  let base: string
  if (internalSampleCount > 0 && externalSampleCount > 0) {
    base = `Based on ${usedSampleCount} comparable ${saleWord} from CollectNTrades and tracked external marketplaces`
  } else if (internalSampleCount > 0) {
    base = `Based on ${usedSampleCount} CollectNTrades comparable ${saleWord}`
  } else {
    base = `Based on ${usedSampleCount} comparable ${saleWord} from tracked external marketplaces`
  }
  if (excludedOutlierCount > 0) {
    const outlierWord = excludedOutlierCount === 1 ? 'result' : 'results'
    base += `; ${excludedOutlierCount} unusual ${outlierWord} excluded`
  }
  const confidenceLabel = confidence === 'high' ? 'High confidence' : 'Medium confidence'
  return `${base}. ${confidenceLabel}.`
}
