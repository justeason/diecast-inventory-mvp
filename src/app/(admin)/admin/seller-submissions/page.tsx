import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { Pagination } from '@/components/shared/Pagination'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  submitted:           'Submitted',
  under_review:        'Under review',
  needs_info:          'Needs info',
  approved_for_intake: 'Approved for intake',
  declined:            'Declined',
  withdrawn:           'Withdrawn',
}

const STATUS_COLORS: Record<string, string> = {
  submitted:           'bg-blue-100 text-blue-700',
  under_review:        'bg-purple-100 text-purple-700',
  needs_info:          'bg-yellow-100 text-yellow-700',
  approved_for_intake: 'bg-green-100 text-green-700',
  declined:            'bg-red-100 text-red-700',
  withdrawn:           'bg-gray-100 text-gray-500',
}

const BADGE_COLORS: Record<string, string> = {
  submitted:           'bg-blue-50 border-blue-200 text-blue-800',
  under_review:        'bg-purple-50 border-purple-200 text-purple-800',
  needs_info:          'bg-yellow-50 border-yellow-200 text-yellow-800',
  approved_for_intake: 'bg-green-50 border-green-200 text-green-800',
  declined:            'bg-red-50 border-red-200 text-red-800',
  withdrawn:           'bg-gray-50 border-gray-200 text-gray-600',
}

const SALE_TYPE_LABELS: Record<string, string> = {
  consignment: 'Consignment',
  buyout:      'Buyout',
  unsure:      'Not sure',
}

const STATUS_ORDER = ['submitted', 'under_review', 'needs_info', 'approved_for_intake', 'declined', 'withdrawn'] as const
const VALID_STATUSES = new Set([...STATUS_ORDER, 'all'])
const PAGE_SIZE = 25

export default async function AdminSellerSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>
}) {
  const { status: rawStatus, page: rawPage } = await searchParams

  const statusFilter =
    rawStatus && VALID_STATUSES.has(rawStatus) && rawStatus !== 'all' ? rawStatus : ''
  const activeTab = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : 'all'
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1') || 1)

  const where = statusFilter ? { status: statusFilter } : {}

  const [countRows, filteredCount] = await Promise.all([
    prisma.sellerSubmission.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.sellerSubmission.count({ where }),
  ])

  const counts: Record<string, number> = {
    submitted: 0, under_review: 0, needs_info: 0,
    approved_for_intake: 0, declined: 0, withdrawn: 0,
  }
  for (const row of countRows) {
    if (row.status in counts) counts[row.status] = row._count._all
  }

  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * PAGE_SIZE

  const submissions = await prisma.sellerSubmission.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip,
    take: PAGE_SIZE,
    select: {
      id:                 true,
      brand:              true,
      name:               true,
      status:             true,
      saleTypePreference: true,
      quantity:           true,
      createdAt:          true,
      profile: { select: { id: true, name: true, email: true } },
    },
  })

  const tabHref = (s: string) =>
    s === 'all' ? '/admin/seller-submissions' : `/admin/seller-submissions?status=${s}`
  const paginationParams: Record<string, string> = {}
  if (statusFilter) paginationParams.status = statusFilter

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Sell Requests</h1>
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
      <div className="flex flex-wrap gap-4 mb-4 border-b border-gray-200">
        {([...STATUS_ORDER, 'all'] as const).map((s) => (
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

      {submissions.length === 0 ? (
        <p className="text-sm text-gray-500 mt-4">No sell requests found.</p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Item</th>
                <th className="px-4 py-3 font-medium">Qty</th>
                <th className="px-4 py-3 font-medium">Sale type</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {submissions.map((sub) => {
                const itemLabel =
                  [sub.brand, sub.name].filter(Boolean).join(' ') || '—'
                const customerLabel = sub.profile.name ?? sub.profile.email
                const isActionable = ['submitted', 'under_review', 'needs_info'].includes(sub.status)
                return (
                  <tr key={sub.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-700">{customerLabel}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{itemLabel}</td>
                    <td className="px-4 py-3 text-gray-500">{sub.quantity}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {sub.saleTypePreference
                        ? (SALE_TYPE_LABELS[sub.saleTypePreference] ?? sub.saleTypePreference)
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {sub.createdAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_COLORS[sub.status] ?? 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {STATUS_LABELS[sub.status] ?? sub.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/seller-submissions/${sub.id}`}
                        className="text-sm text-gray-600 hover:text-gray-900"
                      >
                        {isActionable ? 'Review →' : 'View'}
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        totalCount={filteredCount}
        pageSize={PAGE_SIZE}
        basePath="/admin/seller-submissions"
        params={paginationParams}
      />
    </>
  )
}
