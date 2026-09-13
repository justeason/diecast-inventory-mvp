import Link from 'next/link'
import type { ValuationResult } from '@/lib/marketValuation'
import type { MarketSaleObservation } from '@/lib/marketSaleQuery'
import type { InternalAskSummary } from '@/lib/marketAskQuery'
import { formatDate } from '@/lib/formatDate'
import {
  centsToDisplay,
  saleSourceLabel,
  formatEvidenceLine,
  isFallbackSpecificity,
  resolveLastSaleDisplay,
} from '@/lib/marketModelPageDisplay'
import { MarketMethodology } from './MarketMethodology'

const CONFIDENCE_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

const SALE_DATE_OPTS = { month: 'short', day: 'numeric', year: 'numeric' } as const

// 24B: one full-width Market Snapshot — Estimated Market Value first (23B
// getValuation exclusively, never asks/old engines), then Last Sale(s), then
// current supply. Stacked labeled rows, not a dense tile grid.
export function MarketSnapshot({
  valuation,
  lastMarketSale,
  lastInternalSale,
  askSummary,
  listingsAnchorHref,
}: {
  valuation: ValuationResult
  lastMarketSale: MarketSaleObservation | null
  lastInternalSale: MarketSaleObservation | null
  askSummary: InternalAskSummary
  listingsAnchorHref: string
}) {
  const { showLastInternalRow, showNoInternalSalesNote } = resolveLastSaleDisplay(lastMarketSale, lastInternalSale)
  const hasAsks = askSummary.availableCopies > 0 && askSummary.lowestAskCents !== null && askSummary.medianAskCents !== null

  return (
    <section className="mb-8 rounded-md border border-gray-200 bg-gray-50 px-4 py-3 space-y-4">
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Market Snapshot</h2>

        <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Estimated Market Value</p>
        {valuation.status === 'valued' ? (
          <>
            <p className="text-lg font-semibold text-gray-900">
              {centsToDisplay(valuation.estimatedValueCents)}
              {valuation.marketRangeLowCents !== null && valuation.marketRangeHighCents !== null && (
                <span className="text-sm font-normal text-gray-500">
                  {' '}
                  ({centsToDisplay(valuation.marketRangeLowCents)}–{centsToDisplay(valuation.marketRangeHighCents)})
                </span>
              )}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {CONFIDENCE_LABELS[valuation.confidence]} · {formatEvidenceLine(valuation)}
            </p>
            {isFallbackSpecificity(valuation) && (
              <p className="text-xs text-amber-700 mt-1">
                Using broader model-level sales due to limited packaging-specific history.
              </p>
            )}
            {valuation.extendedHistoryUsed && (
              <p className="text-xs text-gray-500 mt-1">Includes older sales beyond the recent 24-month window.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-400">Not enough direct sales data yet.</p>
        )}

        <MarketMethodology />
      </div>

      <div className="border-t border-gray-200 pt-3 space-y-1">
        {lastMarketSale ? (
          <p className="text-sm text-gray-700">
            <span className="font-medium">Last Market Sale:</span> {centsToDisplay(lastMarketSale.priceCents)} on{' '}
            {formatDate(lastMarketSale.soldAt, SALE_DATE_OPTS)} ({saleSourceLabel(lastMarketSale)})
          </p>
        ) : (
          <p className="text-sm text-gray-400">Last Market Sale: No sales recorded yet.</p>
        )}
        {showLastInternalRow && lastInternalSale && (
          <p className="text-sm text-gray-700">
            <span className="font-medium">Last CollectNTrades Sale:</span> {centsToDisplay(lastInternalSale.priceCents)} on{' '}
            {formatDate(lastInternalSale.soldAt, SALE_DATE_OPTS)}
          </p>
        )}
        {showNoInternalSalesNote && <p className="text-sm text-gray-400">No CollectNTrades sales yet.</p>}
      </div>

      <div className="border-t border-gray-200 pt-3 space-y-1">
        {hasAsks ? (
          <>
            <p className="text-sm text-gray-700">
              <span className="font-medium">Lowest Ask:</span>{' '}
              <Link href={listingsAnchorHref} className="underline underline-offset-2 hover:text-gray-900">
                {centsToDisplay(askSummary.lowestAskCents!)}
              </Link>
            </p>
            <p className="text-sm text-gray-700">
              <span className="font-medium">Median Ask:</span>{' '}
              <Link href={listingsAnchorHref} className="underline underline-offset-2 hover:text-gray-900">
                {centsToDisplay(askSummary.medianAskCents!)}
              </Link>
            </p>
            <p className="text-sm text-gray-700">
              <span className="font-medium">Available Copies:</span>{' '}
              <Link href={listingsAnchorHref} className="underline underline-offset-2 hover:text-gray-900">
                {askSummary.availableCopies}
              </Link>
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-400">None available right now.</p>
        )}
      </div>
    </section>
  )
}
