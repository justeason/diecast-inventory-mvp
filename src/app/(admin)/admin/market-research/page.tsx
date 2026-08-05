import type { Metadata } from 'next'
import Link from 'next/link'
import { getDashboardStats, listImportBatches, BATCHES_PAGE_SIZE } from '@/lib/externalMarketResearchQuery'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Market Research | Admin' }

export default async function MarketResearchDashboard({
  searchParams,
}: {
  searchParams: Promise<{ afterId?: string }>
}) {
  const { afterId } = await searchParams

  const [stats, { batches, total, nextCursor }] = await Promise.all([
    getDashboardStats(),
    listImportBatches(afterId || undefined),
  ])

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Market Research</h1>
        <div className="flex gap-3">
          <Link
            href="/admin/market-research/import"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
          >
            Import CSV
          </Link>
          <Link
            href="/admin/market-research/observations"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            All observations
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-8">
        {[
          { label: 'Total obs.',   value: stats.totalObservations },
          { label: 'Matched',      value: stats.matchedCount },
          { label: 'Unmatched',    value: stats.unmatchedCount },
          { label: 'Rejected',     value: stats.rejectedCount },
          { label: 'Import batches', value: stats.totalBatches },
        ].map(s => (
          <div key={s.label} className="rounded-md border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            <p className="text-xl font-semibold text-gray-900">{s.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* Import batch list */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Import Batches</h2>

      {batches.length === 0 ? (
        <p className="text-sm text-gray-400">No import batches yet. <Link href="/admin/market-research/import" className="underline">Import a CSV</Link>.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 bg-gray-50">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium text-right">Rows</th>
                  <th className="px-4 py-2 font-medium text-right">Imported</th>
                  <th className="px-4 py-2 font-medium text-right">Dups</th>
                  <th className="px-4 py-2 font-medium text-right">Errors</th>
                  <th className="px-4 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {batches.map(b => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">
                      {b.createdAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 font-medium text-gray-900">{b.provider}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{b.originalFileName ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{b.rowCount}</td>
                    <td className="px-4 py-2 text-right text-green-700">{b.importedCount}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{b.duplicateCount}</td>
                    <td className="px-4 py-2 text-right text-red-600">{b.errorCount}</td>
                    <td className="px-4 py-2 text-xs text-gray-400 max-w-xs truncate">{b.adminInfo ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Keyset pagination — newest first */}
          <div className="mt-4 flex items-center gap-4 text-sm">
            {afterId && (
              <Link href="/admin/market-research" className="text-gray-600 hover:text-gray-900">
                ← Newest
              </Link>
            )}
            <span className="text-xs text-gray-400">
              Showing {batches.length} of {total.toLocaleString()} (page size {BATCHES_PAGE_SIZE})
            </span>
            {nextCursor && (
              <Link href={`/admin/market-research?afterId=${nextCursor}`} className="text-gray-600 hover:text-gray-900">
                Older →
              </Link>
            )}
          </div>
        </>
      )}

      <div className="mt-8 rounded-md border border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 space-y-1">
        <p>External market data is for admin reference only. It does not affect buyer-visible valuations automatically.</p>
        <p>Match observations to catalog models to make them available as a reference signal on the collection valuation page.</p>
        <p>Source URLs and raw snapshots are visible to admins only and are never shared with buyers or sellers.</p>
      </div>
    </div>
  )
}
