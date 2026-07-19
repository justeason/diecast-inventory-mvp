import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { Pagination } from '@/components/shared/Pagination'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  pending:   'Pending',
  approved:  'Approved',
  rejected:  'Rejected',
  duplicate: 'Duplicate',
}

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  approved:  'bg-green-100 text-green-700',
  rejected:  'bg-red-100 text-red-700',
  duplicate: 'bg-blue-100 text-blue-700',
}

const BADGE_COLORS: Record<string, string> = {
  pending:   'bg-yellow-50 border-yellow-200 text-yellow-800',
  approved:  'bg-green-50 border-green-200 text-green-800',
  rejected:  'bg-red-50 border-red-200 text-red-800',
  duplicate: 'bg-blue-50 border-blue-200 text-blue-800',
}

const STATUS_ORDER = ['pending', 'approved', 'rejected', 'duplicate'] as const
const VALID_STATUSES = new Set([...STATUS_ORDER, 'all'])
const PAGE_SIZE = 25

export default async function AdminCatalogSuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>
}) {
  const { status: rawStatus, page: rawPage } = await searchParams

  const statusFilter =
    rawStatus && VALID_STATUSES.has(rawStatus) && rawStatus !== 'all' ? rawStatus : ''
  const activeTab = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : 'pending'
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1') || 1)

  const where = statusFilter ? { status: statusFilter } : {}

  // Status counts (always unfiltered)
  const [countRows, filteredCount] = await Promise.all([
    prisma.catalogSuggestion.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.catalogSuggestion.count({ where }),
  ])

  const counts: Record<string, number> = {
    pending: 0, approved: 0, rejected: 0, duplicate: 0,
  }
  for (const row of countRows) {
    if (row.status in counts) counts[row.status] = row._count._all
  }

  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * PAGE_SIZE

  const suggestions = await prisma.catalogSuggestion.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip,
    take: PAGE_SIZE,
    select: {
      id:                    true,
      brand:                 true,
      name:                  true,
      series:                true,
      year:                  true,
      color:                 true,
      status:                true,
      aiExtractionConfidence: true,
      createdAt:             true,
      profile: { select: { id: true, name: true, email: true } },
    },
  })

  const tabHref = (s: string) => (s === 'all' ? '/admin/catalog-suggestions' : `/admin/catalog-suggestions?status=${s}`)
  const paginationParams: Record<string, string> = {}
  if (statusFilter) paginationParams.status = statusFilter

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Catalog Suggestions</h1>
      </div>

      {/* Status count badges */}
      <div className="flex flex-wrap gap-3 mb-6">
        {STATUS_ORDER.map((s) => (
          <div
            key={s}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${BADGE_COLORS[s]}`}
          >
            <span className="font-medium">{STATUS_LABELS[s]}</span>
            <span className="font-bold tabular-nums">{counts[s]}</span>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-4 mb-4 border-b border-gray-200">
        {(['pending', 'approved', 'rejected', 'duplicate', 'all'] as const).map((s) => (
          <Link
            key={s}
            href={tabHref(s)}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === s
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-900'
            }`}
          >
            {s === 'all' ? 'All' : STATUS_LABELS[s]}
          </Link>
        ))}
      </div>

      {suggestions.length === 0 ? (
        <p className="text-sm text-gray-500 mt-4">No suggestions found.</p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Submitter</th>
                <th className="px-4 py-3 font-medium">Brand · Model</th>
                <th className="px-4 py-3 font-medium">Series</th>
                <th className="px-4 py-3 font-medium">Year</th>
                <th className="px-4 py-3 font-medium">Color</th>
                <th className="px-4 py-3 font-medium">AI conf.</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {suggestions.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700">
                    {s.profile.name ?? s.profile.email}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {s.brand} · {s.name}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{s.series ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{s.year ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{s.color ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {s.aiExtractionConfidence != null
                      ? `${Math.round(s.aiExtractionConfidence * 100)}%`
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {s.createdAt.toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_COLORS[s.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {STATUS_LABELS[s.status] ?? s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/catalog-suggestions/${s.id}`}
                      className="text-sm text-gray-600 hover:text-gray-900"
                    >
                      {s.status === 'pending' ? 'Review →' : 'View'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        totalCount={filteredCount}
        pageSize={PAGE_SIZE}
        basePath="/admin/catalog-suggestions"
        params={paginationParams}
      />
    </>
  )
}
