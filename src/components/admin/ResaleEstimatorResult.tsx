import Link from 'next/link'
import type { EstimateResult, MatchLevel, Confidence } from '@/lib/resaleEstimator'
import { formatCatalogResult } from '@/lib/catalogFormat'

type ModelSummary = {
  id: string
  brand: string
  name: string
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
}

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  insufficient: 'Insufficient',
}

const CONFIDENCE_COLORS: Record<Confidence, string> = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-blue-100 text-blue-800',
  low: 'bg-yellow-100 text-yellow-800',
  insufficient: 'bg-gray-100 text-gray-600',
}

const MATCH_LEVEL_LABELS: Record<MatchLevel, string> = {
  exact: 'Exact model',
  model_family: 'Model family',
  series_year: 'Series + year',
  brand_series: 'Brand + series',
  insufficient: 'Insufficient',
}

function usd(cents: number | null): string {
  if (cents === null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

export function ResaleEstimatorResult({
  model,
  result,
}: {
  model: ModelSummary
  result: EstimateResult
}) {
  const hasEstimate = result.estimatedPrice !== null

  return (
    <div className="space-y-6">
      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1">
          {result.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {/* Result card */}
      <div className="rounded-md border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-5 py-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Resale Estimate</p>
          <p className="text-sm font-medium text-gray-900">{formatCatalogResult(model)}</p>
        </div>
        <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <p className="text-xs text-gray-400 mb-1">Est. Price</p>
            <p className="text-lg font-bold text-gray-900 tabular-nums">
              {hasEstimate ? usd(result.estimatedPrice) : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Range</p>
            <p className="text-sm text-gray-700 tabular-nums">
              {hasEstimate
                ? `${usd(result.lowPrice)} – ${usd(result.highPrice)}`
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Days to Sell</p>
            <p className="text-sm text-gray-700 tabular-nums">
              {result.estimatedDaysToSell !== null ? `~${result.estimatedDaysToSell}d` : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Comparables</p>
            <p className="text-sm text-gray-700 tabular-nums">{result.comparableCount}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Confidence</p>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_COLORS[result.confidence]}`}
            >
              {CONFIDENCE_LABELS[result.confidence]}
            </span>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Match Level</p>
            <p className="text-sm text-gray-700">{MATCH_LEVEL_LABELS[result.matchLevel]}</p>
          </div>
        </div>
        {(result.newestComparableDate || result.oldestComparableDate) && (
          <div className="border-t border-gray-100 px-5 py-3 text-xs text-gray-400 flex gap-4">
            {result.newestComparableDate && (
              <span>Most recent: {result.newestComparableDate.toLocaleDateString()}</span>
            )}
            {result.oldestComparableDate && (
              <span>Oldest: {result.oldestComparableDate.toLocaleDateString()}</span>
            )}
            {result.extendedHistoryUsed && (
              <span className="text-amber-600 font-medium">Extended history used</span>
            )}
          </div>
        )}
      </div>

      {/* No data message */}
      {!hasEstimate && (
        <p className="text-sm text-gray-500 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
          Not enough comparable completed sales to produce a reliable estimate.
        </p>
      )}

      {/* Comparable table */}
      {result.comparables.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
            Comparable Sales ({result.comparables.length})
          </h2>
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Sold Price</th>
                  <th className="px-4 py-3 font-medium">Listed</th>
                  <th className="px-4 py-3 font-medium">Completed</th>
                  <th className="px-4 py-3 font-medium">Days</th>
                  <th className="px-4 py-3 font-medium">Match</th>
                  <th className="px-4 py-3 font-medium">Order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {result.comparables.map((c) => (
                  <tr key={c.orderItemId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{c.sku}</td>
                    <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">
                      {usd(c.soldPriceCents)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {c.listingCreatedAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {c.orderCompletedAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 tabular-nums">
                      {c.daysToSell !== null ? c.daysToSell : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {MATCH_LEVEL_LABELS[c.matchLevel]}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <Link
                        href={`/admin/orders/${c.orderId}`}
                        className="text-blue-600 hover:underline font-mono"
                      >
                        {c.orderId.slice(0, 8)}…
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
