import type { AdminPricingContext as AdminPricingContextData } from '@/lib/adminPricingContext'
import { centsToDisplay, formatEvidenceLine } from '@/lib/marketModelPageDisplay'
import {
  ADMIN_CONFIDENCE_LABELS,
  describeSpecificityFallback,
  classifyPriceVsMarketRange,
  PRICE_VS_RANGE_LABELS,
} from '@/lib/adminPricingDisplay'
import { MarketActivity } from '@/components/store/MarketActivity'

// 32B: the ONE reusable canonical Admin Pricing Context panel — item detail,
// listing create/edit, and valuation detail all render the SAME component
// rather than three independently-designed pricing panels (§25). Primary
// facts only (§14/§26): EMV, Market Range, Confidence, Lowest Ask, Available
// Copies. Everything else (evidence detail, Ask Depth, Market Activity) is
// collapsed behind plain <details> — no client JS, no stock-terminal density.
//
// No directive of its own (no 'use server'/'use client') — pure props->JSX,
// so it renders identically whether the caller is a Server Component (item
// detail, valuation detail) or re-rendered reactively inside a 'use client'
// listing form via `comparePriceCents` (§76 — same live, zero-network-cost
// pattern already proven by ListingForm.tsx's PayoutPreview).
export function AdminPricingContextPanel({
  context,
  heading = 'Pricing Context',
  comparePriceCents,
  comparePriceLabel = 'Current Price',
}: {
  // Follow-up §1: null represents an isolated technical failure in the
  // optional pricing enrichment fetch (see safeGetAdminPricingContext) — the
  // panel itself renders neutral, non-alarming unavailable copy so every
  // caller gets consistent error isolation for free, never raw exception text.
  context: AdminPricingContextData | null
  heading?: string
  // §43: optional live price-vs-range classification — display-only, never
  // feeds risk/validation (§44).
  comparePriceCents?: number | null
  comparePriceLabel?: string
}) {
  if (!context) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
        Pricing context unavailable.
      </div>
    )
  }

  const { pricing, askDepth, signals } = context
  const { valuation, askSummary, evidenceDisclosure } = pricing
  const valued = valuation.status === 'valued' ? valuation : null
  const fallbackNote = valued ? describeSpecificityFallback(valued) : null
  const comparison =
    valued && comparePriceCents != null
      ? classifyPriceVsMarketRange(comparePriceCents, valued.marketRangeLowCents, valued.marketRangeHighCents)
      : null

  return (
    <div className="rounded-md border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{heading}</p>
        <p className="text-xs text-gray-400">As of {pricing.asOf.toLocaleString()}</p>
      </div>

      <div className="px-4 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-gray-400 mb-1">Estimated Market Value</p>
          <p className="text-sm font-semibold text-gray-900 tabular-nums">
            {valued ? centsToDisplay(valued.estimatedValueCents) : 'Not enough direct sales data'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-1">Market Range</p>
          <p className="text-sm text-gray-700 tabular-nums">
            {valued && valued.marketRangeLowCents !== null && valued.marketRangeHighCents !== null
              ? `${centsToDisplay(valued.marketRangeLowCents)} – ${centsToDisplay(valued.marketRangeHighCents)}`
              : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-1">Confidence</p>
          <p className="text-sm text-gray-700">{valued ? ADMIN_CONFIDENCE_LABELS[valued.confidence] : '—'}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-1">Lowest Ask</p>
          <p className="text-sm text-gray-700 tabular-nums">
            {askSummary.lowestAskCents !== null ? centsToDisplay(askSummary.lowestAskCents) : 'None available'}
          </p>
        </div>
      </div>

      {fallbackNote && <p className="px-4 pb-3 text-xs text-amber-700">{fallbackNote}</p>}

      {comparison && (
        <p className="px-4 pb-3 text-xs text-gray-600">
          {comparePriceLabel} vs. Market Range: <span className="font-medium text-gray-900">{PRICE_VS_RANGE_LABELS[comparison]}</span>
        </p>
      )}

      <div className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
        Available Copies: <span className="text-gray-900">{askSummary.availableCopies}</span>
      </div>

      <div className="border-t border-gray-100 divide-y divide-gray-100">
        {valued && evidenceDisclosure && (
          <details className="px-4 py-2 text-xs text-gray-500">
            <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-900">Sales Evidence</summary>
            <div className="mt-2 space-y-1">
              <p>{formatEvidenceLine(valued)}</p>
              <p>
                Raw: {evidenceDisclosure.rawSampleCount} · Used: {evidenceDisclosure.usedSampleCount} · Excluded as outliers:{' '}
                {evidenceDisclosure.excludedOutlierCount}
              </p>
              <p>
                CollectNTrades: {evidenceDisclosure.internalSampleCount} · Tracked external: {evidenceDisclosure.externalSampleCount}
              </p>
            </div>
          </details>
        )}

        <details className="px-4 py-2 text-xs text-gray-500">
          <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-900">Current Ask Depth</summary>
          {askDepth.length === 0 ? (
            <p className="mt-2 text-gray-400">No copies currently available.</p>
          ) : (
            <table className="mt-2 w-full text-xs">
              <thead className="text-left text-gray-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">Asking Price</th>
                  <th className="py-1 font-medium">Available</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {askDepth.map((level) => (
                  <tr key={level.priceCents}>
                    <td className="py-1 pr-3 text-gray-900">{centsToDisplay(level.priceCents)}</td>
                    <td className="py-1 text-gray-700">{level.availableCopies}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>

        {signals && (
          <details className="px-4 py-2 text-xs text-gray-500">
            <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-900">Recent Market Activity</summary>
            <MarketActivity signals={signals} />
          </details>
        )}
      </div>
    </div>
  )
}
