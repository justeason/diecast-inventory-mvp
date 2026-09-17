// 27B: Core Market Quote — a shared, query-side composition of 23B canonical
// valuation + 24B internal-ask summary + optional Last Sale. The Market Model
// Page (24B) is the first consumer; the seller Market Snapshot (27B) is the
// second. Composition only — introduces no new evidence rule; every field is
// exactly what getValuation/getInternalAskSummary/getLatestSale would
// independently return. Callers request only the subset they need
// (includeLastSale) — a consumer that omits it never pays for those two
// getLatestSale queries. No 30D/momentum/velocity/Wanted signals here — those
// remain Series 30's Market Signals, not this composition's concern.
import { getValuation, type ValuationInput, type ValuationResult } from '@/lib/marketValuation'
import { getInternalAskSummary, type InternalAskSummary } from '@/lib/marketAskQuery'
import { getLatestSale, type MarketSaleObservation } from '@/lib/marketSaleQuery'

export type MarketQuoteInput = ValuationInput & {
  // Default false — the seller Market Snapshot doesn't want Last Sale in V1
  // (View Market links to the full Market Model Page instead); the Market
  // Model Page passes true to preserve its existing behavior unchanged.
  includeLastSale?: boolean
}

export type MarketQuote = {
  valuation: ValuationResult
  askSummary: InternalAskSummary
  lastMarketSale: MarketSaleObservation | null
  lastInternalSale: MarketSaleObservation | null
}

export async function getMarketQuote(input: MarketQuoteInput): Promise<MarketQuote> {
  const asOf = input.asOf ?? new Date()
  const variantFilter = input.marketVariantId !== undefined ? { marketVariantId: input.marketVariantId } : {}
  const conditionFilter = input.condition !== undefined ? { condition: input.condition } : {}

  const [valuation, askSummary, lastMarketSale, lastInternalSale] = await Promise.all([
    getValuation({ catalogModelId: input.catalogModelId, ...variantFilter, ...conditionFilter, asOf }),
    getInternalAskSummary({ catalogModelId: input.catalogModelId, ...variantFilter }),
    input.includeLastSale
      ? getLatestSale({ catalogModelId: input.catalogModelId, ...variantFilter, sources: ['internal', 'external'], endDate: asOf })
      : Promise.resolve(null),
    input.includeLastSale
      ? getLatestSale({ catalogModelId: input.catalogModelId, ...variantFilter, sources: ['internal'], endDate: asOf })
      : Promise.resolve(null),
  ])

  return { valuation, askSummary, lastMarketSale, lastInternalSale }
}
