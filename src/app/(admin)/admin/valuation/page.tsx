import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { scanAdminPricingOpportunities, type AdminPricingFilter } from '@/lib/adminPricingListQuery'
import { ADMIN_CONFIDENCE_LABELS } from '@/lib/adminPricingDisplay'
import { formatCatalogResult } from '@/lib/catalogFormat'
import { ValuationSearchForm } from '@/components/admin/ValuationSearchForm'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Market Pricing | Admin' }

const FILTERS: { key: AdminPricingFilter; label: string }[] = [
  { key: 'low_confidence', label: 'Low confidence' },
  { key: 'high_confidence', label: 'High confidence' },
  { key: 'no_sold_evidence', label: 'No sold evidence' },
  { key: 'high_dispersion', label: 'High dispersion' },
]

function usd(cents: number | null): string {
  return cents === null ? '—' : `$${(cents / 100).toFixed(2)}`
}

function isAdminPricingFilter(v: string | undefined): v is AdminPricingFilter {
  return !!v && FILTERS.some(f => f.key === v)
}

export default async function AdminValuationPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; after?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')
  const { filter: rawFilter, after } = await searchParams
  const filter = isAdminPricingFilter(rawFilter) ? rawFilter : null

  const { items, nextCursor } = await scanAdminPricingOpportunities(filter, after || undefined)

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Market Pricing</h1>
        <p className="text-sm text-gray-500 mt-1">
          Canonical Estimated Market Value, Market Range, and current supply from completed comparable sales.
          Advisory only — nothing here changes a listing price automatically.
        </p>
      </div>

      <ValuationSearchForm />

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Models</h2>
        <div className="flex flex-wrap gap-2 mb-4 text-xs">
          <Link href="/admin/valuation" className={`px-3 py-1 rounded-full border ${!filter ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-600'}`}>
            All
          </Link>
          {FILTERS.map(f => (
            <Link
              key={f.key}
              href={`/admin/valuation?filter=${f.key}`}
              className={`px-3 py-1 rounded-full border ${filter === f.key ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-600'}`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        {items.length === 0 && (
          <p className="text-sm text-gray-500 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
            No models match this filter on the current page{nextCursor ? ' — try the next page.' : '.'}
          </p>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Estimated Market Value</th>
                  <th className="px-4 py-3 font-medium">Market Range</th>
                  <th className="px-4 py-3 font-medium">Confidence</th>
                  <th className="px-4 py-3 font-medium">Sales Evidence</th>
                  <th className="px-4 py-3 font-medium">Current Supply</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map(row => (
                  <tr key={row.catalogModelId} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/admin/valuation/models/${row.catalogModelId}`} className="text-blue-600 hover:underline">
                        {formatCatalogResult({ id: row.catalogModelId, brand: row.brand, name: row.name, series: row.series, year: row.year, color: null, scale: null })}
                      </Link>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {row.valuation.status === 'valued' ? usd(row.valuation.estimatedValueCents) : <span className="text-amber-600">Not enough sales</span>}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-gray-500">
                      {row.valuation.status === 'valued' && row.valuation.marketRangeLowCents !== null && row.valuation.marketRangeHighCents !== null
                        ? `${usd(row.valuation.marketRangeLowCents)} – ${usd(row.valuation.marketRangeHighCents)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">{row.valuation.status === 'valued' ? ADMIN_CONFIDENCE_LABELS[row.valuation.confidence] : '—'}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-500">
                      {row.valuation.status === 'valued' ? row.valuation.usedSampleCount : 0}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-gray-500">
                      {row.availableCopies > 0 ? `${row.availableCopies} from ${usd(row.lowestAskCents)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && (
          <div className="mt-4">
            <Link
              href={`/admin/valuation?${filter ? `filter=${filter}&` : ''}after=${nextCursor}`}
              className="text-sm text-gray-600 hover:text-gray-900 underline underline-offset-2"
            >
              Next page →
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
