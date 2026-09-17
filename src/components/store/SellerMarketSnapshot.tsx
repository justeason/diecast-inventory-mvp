import Link from 'next/link'
import type { MarketQuote } from '@/lib/marketQuoteQuery'
import { centsToDisplay, formatEvidenceLine, isFallbackSpecificity } from '@/lib/marketModelPageDisplay'

const CONFIDENCE_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

// 27B §14/§16/§20/§22: minimum seller market block — Estimated Market Value,
// Market Range (N>=5 only, omitted otherwise), Confidence, evidence-source
// line, current internal-only asks (scoped to the resolved MarketVariant,
// never implying condition specificity), View Market. No Suggested Listing
// Price/Target Price, no days-to-sell, no liquidity/trend — all deferred
// (§25-§28, §30-§33). Last Sale intentionally omitted in V1 (§22) — View
// Market covers it.
export function SellerMarketSnapshot({
  quote,
  catalogId,
  requestedVariantLabel,
}: {
  quote: MarketQuote
  catalogId: string
  // e.g. "Carded" when a packaging variant was resolved — used only to scope
  // the ask-supply heading copy, never to claim condition specificity.
  requestedVariantLabel: string | null
}) {
  const { valuation, askSummary } = quote
  const hasAsks = askSummary.availableCopies > 0 && askSummary.lowestAskCents !== null

  return (
    <section className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 space-y-3">
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Market Snapshot</h2>

      <div>
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
                {valuation.specificity === 'model'
                  ? 'Not enough packaging-specific sales — using broader model-level sales due to limited packaging-specific history.'
                  : 'Not enough sales at your exact condition — using packaging-level sales across all conditions.'}
              </p>
            )}
            {valuation.extendedHistoryUsed && (
              <p className="text-xs text-gray-500 mt-1">Includes older sales beyond the recent 24-month window.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-400">Not enough direct sales data yet.</p>
        )}
      </div>

      <div className="border-t border-gray-200 pt-3">
        <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">
          {requestedVariantLabel ? `Current ${requestedVariantLabel} supply` : 'Current supply'}
        </p>
        {hasAsks ? (
          <p className="text-sm text-gray-700">
            Lowest Ask: <span className="font-medium">{centsToDisplay(askSummary.lowestAskCents!)}</span>
            {' · '}Available Copies: <span className="font-medium">{askSummary.availableCopies}</span>
          </p>
        ) : (
          <p className="text-sm text-gray-400">None available right now.</p>
        )}
      </div>

      <div className="border-t border-gray-200 pt-3">
        <Link href={`/catalog/${catalogId}`} className="text-sm font-medium text-gray-900 hover:underline underline-offset-2">
          View Market →
        </Link>
        <p className="text-xs text-gray-400 mt-0.5">Last sale, price history, and full market range on the model page.</p>
      </div>
    </section>
  )
}
