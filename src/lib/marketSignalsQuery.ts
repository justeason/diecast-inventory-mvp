// 30B: canonical Market Signals — RECENT BEHAVIOR OVER TIME, kept structurally
// separate from getMarketQuote's CURRENT STATE (30A §4/§46). Composition only:
// introduces no new evidence rule beyond the 30D-change eligibility gate below
// — every underlying number is exactly what getValuation/getSaleCount/
// getMedianDaysToSell/WantedCatalogModel.count would independently return.
// Each field is independently available/ineligible (30A §5/§53/§54) — one
// signal's unavailability never blocks another.
import { getValuation, type ValuationResult } from './marketValuation'
import { getSaleCount } from './marketSaleQuery'
import { getMedianDaysToSell, DAYS_TO_SELL_WINDOW_DAYS, type DaysToSellResult } from './marketDaysToSellQuery'
import { prisma } from '@/lib/prisma'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000 // §67: explicit trailing window, never calendar-month subtraction
const DAYS_TO_SELL_WINDOW_MS = DAYS_TO_SELL_WINDOW_DAYS * 24 * 60 * 60 * 1000

export type ValuationChange30d =
  | { status: 'available'; changeCents: number; changePercent: number; currentEstimatedValueCents: number; priorEstimatedValueCents: number }
  | { status: 'insufficient_data' }
  | { status: 'incomparable' }

export type Sales30d = { status: 'available'; total: number; internal: number; external: number }

export type MarketSignals = {
  valuationChange30d: ValuationChange30d
  sales30d: Sales30d
  medianDaysToSell: DaysToSellResult
  wantedCount: number
}

export type MarketSignalsInput = {
  catalogModelId: string
  marketVariantId?: string
  asOf: Date
  // §50: the Market Model Page already fetches the current valuation via
  // getMarketQuote — passed in here rather than recomputed, PROVIDED it was
  // requested with the identical catalogModelId/marketVariantId/asOf. Avoids
  // a redundant canonical valuation query for the exact same evidence.
  currentValuation: ValuationResult
}

// §13/§14/§15: strict eligibility — a specificity mismatch is a distinct
// 'incomparable' (evidence-scope changed, not a market signal), everything
// else that fails the gate is 'insufficient_data'. Never loosened merely to
// show more numbers.
function computeValuationChange30d(current: ValuationResult, prior: ValuationResult): ValuationChange30d {
  if (current.status !== 'valued' || prior.status !== 'valued') return { status: 'insufficient_data' }
  if (current.specificity !== prior.specificity) return { status: 'incomparable' }
  if (current.extendedHistoryUsed || prior.extendedHistoryUsed) return { status: 'insufficient_data' }
  if (current.confidence === 'low' || prior.confidence === 'low') return { status: 'insufficient_data' }
  if (prior.estimatedValueCents <= 0) return { status: 'insufficient_data' } // §12 guard

  const changeCents = current.estimatedValueCents - prior.estimatedValueCents
  const changePercent = (changeCents / prior.estimatedValueCents) * 100
  return {
    status: 'available',
    changeCents,
    changePercent,
    currentEstimatedValueCents: current.estimatedValueCents,
    priorEstimatedValueCents: prior.estimatedValueCents,
  }
}

export async function getMarketSignals(input: MarketSignalsInput): Promise<MarketSignals> {
  const { catalogModelId, marketVariantId, asOf, currentValuation } = input
  const variantFilter = marketVariantId !== undefined ? { marketVariantId } : {}
  // §9/§51: one request-level asOf; every window below derives from it, no
  // scattered new Date() calls.
  const priorAsOf = new Date(asOf.getTime() - THIRTY_DAYS_MS)
  const daysToSellStart = new Date(asOf.getTime() - DAYS_TO_SELL_WINDOW_MS)

  // §49: independent pieces run in parallel, not a serial waterfall.
  const [priorValuation, saleCount, daysToSell, wantedCount] = await Promise.all([
    getValuation({ catalogModelId, ...variantFilter, asOf: priorAsOf }),
    getSaleCount({ catalogModelId, ...variantFilter, startDate: priorAsOf, endDate: asOf }),
    getMedianDaysToSell({ catalogModelId, ...variantFilter, startDate: daysToSellStart, endDate: asOf }),
    // §33: Wanted is always CatalogModel-level, never scoped by marketVariantId.
    prisma.wantedCatalogModel.count({ where: { catalogModelId } }),
  ])

  return {
    valuationChange30d: computeValuationChange30d(currentValuation, priorValuation),
    sales30d: { status: 'available', total: saleCount.total, internal: saleCount.internal, external: saleCount.external },
    medianDaysToSell: daysToSell,
    wantedCount,
  }
}
