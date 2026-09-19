// 24B: pure display-logic helpers for the public Market Model Page
// (/catalog/[id]). No Prisma, no React — grammar/wording/scaling logic is kept
// directly unit-testable, mirroring marketValuationMath.ts's separation of pure
// math from orchestration/rendering.
import type { MarketSaleObservation } from './marketSaleQuery'
import type { ValuationResult } from './marketValuation'
import type { ValuationChange30d } from './marketSignalsQuery'

export function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// 30B §17/§18: "+6.3% (+$2.00)" / "-4.1% (-$1.25)" / "0.0% ($0.00)" — plain
// text sign, one decimal place, no green/red/ticker treatment (styling is the
// caller's concern, this only produces the string).
export function formatValuationChange30d(change: Extract<ValuationChange30d, { status: 'available' }>): string {
  const sign = change.changeCents > 0 ? '+' : change.changeCents < 0 ? '-' : ''
  const pct = `${sign}${Math.abs(change.changePercent).toFixed(1)}%`
  const dollars = `${sign}${centsToDisplay(Math.abs(change.changeCents))}`
  return `${pct} (${dollars})`
}

export function saleSourceLabel(sale: Pick<MarketSaleObservation, 'sourceType'>): string {
  return sale.sourceType === 'internal' ? 'CollectNTrades' : 'External marketplace'
}

export const PACKAGING_LABELS: Record<string, string> = { carded: 'Carded', loose: 'Loose' }

export const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

type ValuedResult = Extract<ValuationResult, { status: 'valued' }>

// §18/§19: source-mix-conditional, truthful sample-count wording. Never
// universally claims both sources were used — reads the actual used counts.
export function formatEvidenceLine(valuation: ValuedResult): string {
  const { usedSampleCount, excludedOutlierCount, internalSampleCount, externalSampleCount } = valuation
  const saleWord = usedSampleCount === 1 ? 'sale' : 'sales'

  let base: string
  if (internalSampleCount > 0 && externalSampleCount > 0) {
    base = `Based on ${usedSampleCount} comparable ${saleWord} from CollectNTrades and tracked external marketplaces`
  } else if (internalSampleCount > 0) {
    base = `Based on ${usedSampleCount} CollectNTrades comparable ${saleWord}`
  } else if (externalSampleCount > 0) {
    base = `Based on ${usedSampleCount} comparable ${saleWord} from tracked external marketplaces`
  } else {
    // Defensive only — usedSampleCount is always >=1 whenever status is 'valued'.
    base = `Based on ${usedSampleCount} comparable ${saleWord}`
  }

  if (excludedOutlierCount > 0) {
    const outlierWord = excludedOutlierCount === 1 ? 'result' : 'results'
    base += `; ${excludedOutlierCount} unusual ${outlierWord} excluded`
  }

  return `${base}.`
}

// §9/§83: a selected-variant request may have broadened to a wider tier.
export function isFallbackSpecificity(valuation: ValuedResult): boolean {
  return valuation.specificity !== valuation.primarySpecificity
}

export type LastSaleDisplay = {
  showLastInternalRow: boolean
  showNoInternalSalesNote: boolean
}

// §22/§23: avoid an identical duplicate row when the latest overall sale is
// already internal; show a compact "no CollectNTrades sales yet" note only
// when the latest overall sale exists and is external with no internal sale at all.
export function resolveLastSaleDisplay(
  lastMarketSale: MarketSaleObservation | null,
  lastInternalSale: MarketSaleObservation | null,
): LastSaleDisplay {
  const showLastInternalRow =
    lastInternalSale !== null && (lastMarketSale === null || lastMarketSale.sourceType !== 'internal')
  const showNoInternalSalesNote =
    lastMarketSale !== null && lastMarketSale.sourceType === 'external' && lastInternalSale === null
  return { showLastInternalRow, showNoInternalSalesNote }
}

export type ChartPoint = { x: number; y: number; sourceType: MarketSaleObservation['sourceType'] }

// §34/§35: discrete scatter coordinates only — no interpolation, no synthetic
// points. Explicit divide-by-zero guards for degenerate ranges (1 point, every
// point on the same day, every point the same price) — never NaN.
export function computeChartPoints(
  points: Array<{ soldAt: Date; priceCents: number; sourceType: MarketSaleObservation['sourceType'] }>,
  width: number,
  height: number,
  pad: number,
): ChartPoint[] {
  if (points.length === 0) return []

  const times = points.map((p) => p.soldAt.getTime())
  const prices = points.map((p) => p.priceCents)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const timeRange = maxTime - minTime
  const priceRange = maxPrice - minPrice

  return points.map((p) => ({
    x: timeRange === 0 ? width / 2 : pad + ((p.soldAt.getTime() - minTime) / timeRange) * (width - 2 * pad),
    y: priceRange === 0 ? height / 2 : height - pad - ((p.priceCents - minPrice) / priceRange) * (height - 2 * pad),
    sourceType: p.sourceType,
  }))
}
