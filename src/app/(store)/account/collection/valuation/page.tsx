import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCollectionValuation } from '@/lib/advancedValuationQuery'
import type { TrendDirection, MatchTier, AdvancedConfidence } from '@/lib/advancedValuation'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Collection Valuation | CollectNTrades',
  robots: { index: false, follow: false },
}

function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function trendBadge(dir: TrendDirection): { label: string; cls: string } {
  switch (dir) {
    case 'up':   return { label: '↑ Up',    cls: 'text-green-700' }
    case 'down': return { label: '↓ Down',  cls: 'text-red-700'   }
    case 'flat': return { label: '→ Flat',  cls: 'text-gray-500'  }
    default:     return { label: '—',        cls: 'text-gray-300'  }
  }
}

function confidenceBadge(c: AdvancedConfidence): { label: string; cls: string } {
  switch (c) {
    case 'high':   return { label: 'High',   cls: 'bg-green-100 text-green-800' }
    case 'medium': return { label: 'Med',    cls: 'bg-blue-100  text-blue-800'  }
    case 'low':    return { label: 'Low',    cls: 'bg-yellow-100 text-yellow-800' }
    default:       return { label: '—',      cls: 'bg-gray-100  text-gray-500'  }
  }
}

function tierLabel(tier: MatchTier): string {
  switch (tier) {
    case 'exact':        return 'Exact'
    case 'model_family': return 'Family'
    case 'series_year':  return 'Series/yr'
    case 'brand_series': return 'Series'
    default:             return '—'
  }
}

export default async function CollectionValuationPage() {
  const session = await getBuyerSession()
  if (!session) notFound()

  const result = await getCollectionValuation(session.profileId)

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <Link href="/account/collection" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to My Collection
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Collection Valuation</h1>
        <p className="text-xs text-gray-400 mt-1">
          As of {result.asOf.toLocaleString()} · Based on completed CollectNTrades sales only ·
          Not an appraisal or financial advice · Estimates may not reflect current market conditions
        </p>
      </div>

      {/* Summary totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500 mb-1">Estimated value</p>
          <p className="text-xl font-semibold text-gray-900">{centsToDisplay(result.totalEstimated)}</p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500 mb-1">Low estimate</p>
          <p className="text-xl font-semibold text-gray-700">{centsToDisplay(result.totalLow)}</p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500 mb-1">High estimate</p>
          <p className="text-xl font-semibold text-gray-700">{centsToDisplay(result.totalHigh)}</p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500 mb-1">Coverage</p>
          <p className="text-xl font-semibold text-gray-900">{result.coveragePercent}%</p>
          <p className="text-xs text-gray-400">{result.valuedCount} of {result.valuedCount + result.unvaluedCount} items</p>
        </div>
      </div>

      {/* Methodology note */}
      <div className="rounded-md border border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 mb-6 space-y-1">
        <p><strong>Methodology:</strong> Estimates are based solely on completed CollectNTrades sales.</p>
        <p>Active asks (current listings) are shown separately and are not included in the estimated value.</p>
        <p>Fallback matches (Family, Series) are labeled — exact model data is preferred.</p>
        <p>Sample size, recency, and price dispersion affect confidence ratings.</p>
        <p>These estimates are not guarantees, appraisals, or financial advice.</p>
      </div>

      {/* Per-item table */}
      {result.items.length === 0 ? (
        <p className="text-sm text-gray-400">No collection items found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 pr-4 font-medium text-right">Qty</th>
                <th className="py-2 pr-4 font-medium text-right">Est. subtotal</th>
                <th className="py-2 pr-4 font-medium text-right">Low / High</th>
                <th className="py-2 pr-4 font-medium text-center">Conf.</th>
                <th className="py-2 pr-4 font-medium text-center">Match</th>
                <th className="py-2 pr-4 font-medium text-center">Trend</th>
                <th className="py-2 font-medium text-right">Lowest ask</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {result.items.map(item => {
                const v = item.valuation
                const hasVal = item.estimatedSubtotal !== null
                const trend = v?.recentTrend
                const tBadge = trend ? trendBadge(trend.direction) : trendBadge('unavailable')
                const conf = v?.confidence ?? 'insufficient'
                const cBadge = confidenceBadge(conf)
                const lowestAsk = v?.activeAskContext.lowestActiveAsk

                return (
                  <tr key={item.collectionItemId} className="hover:bg-gray-50">
                    <td className="py-3 pr-4">
                      <span className="font-medium text-gray-900">{item.modelName}</span>
                      {v && v.matchTier !== 'exact' && v.matchTier !== 'insufficient' && (
                        <span className="ml-1 text-xs text-orange-600">(fallback)</span>
                      )}
                      {!item.catalogModelId && (
                        <span className="ml-1 text-xs text-gray-400">(no catalog match)</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right text-gray-700">
                      {item.quantity}
                      {!item.quantityValid && (
                        <span className="ml-1 text-xs text-red-500" title="Invalid quantity — must be 1–999">(invalid)</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right font-medium text-gray-900">
                      {hasVal ? centsToDisplay(item.estimatedSubtotal!) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-3 pr-4 text-right text-gray-500 text-xs">
                      {hasVal && item.lowSubtotal !== null && item.highSubtotal !== null
                        ? `${centsToDisplay(item.lowSubtotal)} / ${centsToDisplay(item.highSubtotal)}`
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-3 pr-4 text-center">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${cBadge.cls}`}>
                        {cBadge.label}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-center text-xs text-gray-500">
                      {v ? tierLabel(v.matchTier) : '—'}
                    </td>
                    <td className={`py-3 pr-4 text-center text-xs ${tBadge.cls}`}>
                      {tBadge.label}
                    </td>
                    <td className="py-3 text-right text-xs text-gray-500">
                      {lowestAsk != null
                        ? <span title="Active ask — not a sold price">{centsToDisplay(lowestAsk)} ask</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {result.unvaluedCount > 0 && (
        <p className="text-xs text-gray-400 mt-4">
          {result.unvaluedCount} item{result.unvaluedCount !== 1 ? 's' : ''} could not be valued (no catalog match or insufficient sales data) and contribute $0.00 to totals.
        </p>
      )}
    </div>
  )
}
