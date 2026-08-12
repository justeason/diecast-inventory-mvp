import Link from 'next/link'
import { listSellerPortfolios } from '@/lib/sellerPortfolioQuery'
import type { PortfolioListFilter } from '@/lib/sellerPortfolioQuery'

export const dynamic = 'force-dynamic'

const FILTERS: Array<{ key: PortfolioListFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs_attention', label: 'Needs attention' },
  { key: 'awaiting_agreement', label: 'Awaiting agreement' },
  { key: 'awaiting_shipment', label: 'Awaiting shipment' },
  { key: 'inbound', label: 'In transit' },
  { key: 'intake', label: 'Intake in progress' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
]
const VALID_FILTERS = new Set(FILTERS.map(f => f.key))

const STAGE_LABELS: Record<string, string> = {
  awaiting_agreement: 'Awaiting agreement',
  awaiting_shipment: 'Awaiting shipment',
  inbound: 'Inbound',
  intake: 'Intake',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

const STAGE_COLORS: Record<string, string> = {
  awaiting_agreement: 'bg-yellow-100 text-yellow-700',
  awaiting_shipment: 'bg-blue-100 text-blue-700',
  inbound: 'bg-purple-100 text-purple-700',
  intake: 'bg-indigo-100 text-indigo-700',
  active: 'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
}

export default async function AdminSellerPortfoliosPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; cursor?: string }>
}) {
  const { filter: rawFilter, cursor: rawCursor } = await searchParams
  const filter: PortfolioListFilter = rawFilter && VALID_FILTERS.has(rawFilter as PortfolioListFilter)
    ? (rawFilter as PortfolioListFilter)
    : 'all'
  const cursor = rawCursor?.trim() || null

  const { items, nextCursor } = await listSellerPortfolios({ filter, cursor })

  const filterHref = (f: PortfolioListFilter) => (f === 'all' ? '/admin/seller-portfolios' : `/admin/seller-portfolios?filter=${f}`)
  const nextHref = nextCursor
    ? `/admin/seller-portfolios?${filter !== 'all' ? `filter=${filter}&` : ''}cursor=${encodeURIComponent(nextCursor)}`
    : null

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Seller Portfolios</h1>
      </div>

      <div className="flex flex-wrap gap-4 mb-4 border-b border-gray-200">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={filterHref(f.key)}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              filter === f.key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-900'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500 mt-4">No portfolios found for this filter.</p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Portfolio</th>
                <th className="px-4 py-3 font-medium">Seller</th>
                <th className="px-4 py-3 font-medium">Stage</th>
                <th className="px-4 py-3 font-medium text-right">Submitted</th>
                <th className="px-4 py-3 font-medium text-right">Accepted</th>
                <th className="px-4 py-3 font-medium text-right">Received</th>
                <th className="px-4 py-3 font-medium text-right">Listed</th>
                <th className="px-4 py-3 font-medium text-right">Sold</th>
                <th className="px-4 py-3 font-medium">Agreement</th>
                <th className="px-4 py-3 font-medium text-right">Outstanding payout</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/admin/seller-portfolios/${p.id}`} className="font-medium text-gray-900 hover:underline">
                      {p.name ?? `Portfolio ${p.id.slice(0, 8)}`}
                    </Link>
                    {p.needsAttention && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        Needs attention
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{p.sellerLabel}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_COLORS[p.stage] ?? 'bg-gray-100 text-gray-600'}`}>
                      {STAGE_LABELS[p.stage] ?? p.stage}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{p.submitted}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{p.accepted ?? '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{p.received}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{p.listed}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{p.sold}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {p.agreementStatus
                      ? `${p.agreementStatus}${p.agreementCommissionBps !== null ? ` · ${(p.agreementCommissionBps / 100).toFixed(0)}%` : ''}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    ${p.outstandingPayout.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">{p.updatedAt.toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 flex justify-end">
        {nextHref ? (
          <Link href={nextHref} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
            Next →
          </Link>
        ) : null}
      </div>
    </>
  )
}
