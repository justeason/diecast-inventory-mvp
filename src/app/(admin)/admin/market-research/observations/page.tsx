import type { Metadata } from 'next'
import Link from 'next/link'
import { listObservations, OBSERVATIONS_PAGE_SIZE } from '@/lib/externalMarketResearchQuery'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Observations | Market Research | Admin' }

const STATUS_COLORS: Record<string, string> = {
  unmatched: 'bg-yellow-100 text-yellow-800',
  matched:   'bg-green-100 text-green-800',
  rejected:  'bg-red-100 text-red-800',
}

function buildUrl(params: Record<string, string>): string {
  const sp = new URLSearchParams(params)
  const s = sp.toString()
  return `/admin/market-research/observations${s ? `?${s}` : ''}`
}

export default async function ObservationsListPage({
  searchParams,
}: {
  searchParams: Promise<{ afterId?: string; status?: string; provider?: string }>
}) {
  const { afterId, status, provider } = await searchParams

  const { observations, total, nextCursor } = await listObservations(afterId || undefined, {
    matchStatus: status   || undefined,
    provider:    provider || undefined,
  })

  const filterParams: Record<string, string> = {}
  if (status)   filterParams['status']   = status
  if (provider) filterParams['provider'] = provider

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/admin/market-research" className="text-sm text-gray-500 hover:text-gray-900">
            ← Market Research
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">All Observations</h1>
        </div>
      </div>

      {/* Filters */}
      <form method="GET" className="flex gap-3 mb-6 flex-wrap">
        <select
          name="status"
          defaultValue={status ?? ''}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          <option value="unmatched">Unmatched</option>
          <option value="matched">Matched</option>
          <option value="rejected">Rejected</option>
        </select>
        <input
          name="provider"
          defaultValue={provider ?? ''}
          placeholder="Provider filter"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm w-44"
        />
        <button
          type="submit"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Filter
        </button>
        {(status || provider) && (
          <Link href="/admin/market-research/observations" className="text-sm text-gray-400 hover:text-gray-600 self-center">
            Clear
          </Link>
        )}
      </form>

      <p className="text-xs text-gray-500 mb-3">{total.toLocaleString()} observations</p>

      {observations.length === 0 ? (
        <p className="text-sm text-gray-400">No observations match the current filters.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 bg-gray-50">
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium text-right">Total price</th>
                  <th className="px-4 py-2 font-medium">Catalog match</th>
                  <th className="px-4 py-2 font-medium">Observed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {observations.map(obs => (
                  <tr key={obs.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 max-w-xs">
                      <Link
                        href={`/admin/market-research/observations/${obs.id}`}
                        className="font-medium text-gray-900 hover:underline underline-offset-2 block truncate"
                        title={obs.title}
                      >
                        {obs.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{obs.provider}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{obs.observationType}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_COLORS[obs.matchStatus] ?? 'bg-gray-100 text-gray-600'}`}>
                        {obs.matchStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700 whitespace-nowrap">
                      {obs.currency} {parseFloat(obs.totalPrice).toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {obs.catalogModelName ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">
                      {obs.observedAt.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Keyset pagination — newest first, cursor on last item's id */}
          <div className="mt-4 flex items-center gap-4 text-sm">
            {afterId && (
              <Link
                href={buildUrl({ ...filterParams })}
                className="text-gray-600 hover:text-gray-900"
              >
                ← Newest
              </Link>
            )}
            <span className="text-xs text-gray-400">
              Showing {observations.length} of {total.toLocaleString()} (page size {OBSERVATIONS_PAGE_SIZE})
            </span>
            {nextCursor && (
              <Link
                href={buildUrl({ ...filterParams, afterId: nextCursor })}
                className="text-gray-600 hover:text-gray-900"
              >
                Older →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  )
}
