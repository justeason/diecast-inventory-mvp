import Link from 'next/link'
import { type Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { IntakeFilterBar } from '@/components/admin/IntakeFilterBar'

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  converted: 'Converted',
  rejected: 'Rejected',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700',
  reviewed: 'bg-blue-100 text-blue-700',
  converted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

const BADGE_COLORS: Record<string, string> = {
  draft: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  reviewed: 'bg-blue-50 border-blue-200 text-blue-800',
  converted: 'bg-green-50 border-green-200 text-green-800',
  rejected: 'bg-red-50 border-red-200 text-red-800',
}

const STATUS_ORDER = ['draft', 'reviewed', 'converted', 'rejected'] as const

const VALID_FILTER_STATUSES = new Set(['draft', 'reviewed', 'converted', 'rejected'])
const VALID_SORTS = new Set(['newest', 'oldest', 'status', 'brand'])

export default async function AdminIntakePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>
}) {
  const { q: rawQ, status: rawStatus, sort: rawSort } = await searchParams

  const q = rawQ?.trim() ?? ''
  const status =
    rawStatus && VALID_FILTER_STATUSES.has(rawStatus) ? rawStatus : ''
  const sort = rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'newest'

  // Build filtered where clause
  const where: Prisma.IntakeDraftWhereInput = {}

  if (q) {
    const orConditions: Prisma.IntakeDraftWhereInput[] = [
      { brand: { contains: q } },
      { name: { contains: q } },
      { series: { contains: q } },
      { color: { contains: q } },
      { convertedItem: { sku: { contains: q } } },
    ]
    const yearNum = parseInt(q, 10)
    if (!isNaN(yearNum)) {
      orConditions.push({ year: { equals: yearNum } })
    }
    where.OR = orConditions
  }

  if (status) {
    where.status = status
  }

  // Build orderBy
  const orderBy: Prisma.IntakeDraftOrderByWithRelationInput | Prisma.IntakeDraftOrderByWithRelationInput[] =
    sort === 'oldest'
      ? { createdAt: 'asc' }
      : sort === 'status'
        ? { status: 'asc' }
        : sort === 'brand'
          ? [{ brand: 'asc' }, { name: 'asc' }]
          : { createdAt: 'desc' }

  const [drafts, countRows] = await Promise.all([
    prisma.intakeDraft.findMany({
      where,
      orderBy,
      select: {
        id: true,
        status: true,
        brand: true,
        name: true,
        year: true,
        color: true,
        condition: true,
        cardedOrLoose: true,
        createdAt: true,
        convertedItem: {
          select: {
            id: true,
            sku: true,
            listing: { select: { id: true } },
          },
        },
      },
    }),
    // Counts always reflect ALL drafts regardless of filters
    prisma.intakeDraft.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
  ])

  const counts: Record<string, number> = { draft: 0, reviewed: 0, converted: 0, rejected: 0 }
  for (const row of countRows) {
    if (row.status in counts) counts[row.status] = row._count._all
  }

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const isFiltered = q !== '' || status !== ''

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Intake Drafts</h1>
        <Link
          href="/admin/intake/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
        >
          New Draft
        </Link>
      </div>

      {/* Status count badges — always unfiltered totals */}
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

      <IntakeFilterBar q={q} status={status} sort={sort} />

      {isFiltered && (
        <p className="text-sm text-gray-500 mb-4">
          Showing {drafts.length} matching {drafts.length === 1 ? 'draft' : 'drafts'} out of{' '}
          {totalCount} total {totalCount === 1 ? 'draft' : 'drafts'}.
        </p>
      )}

      {drafts.length === 0 ? (
        <p className="text-gray-500 text-sm">
          {isFiltered ? 'No drafts match the current filters.' : 'No intake drafts yet.'}
        </p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Model</th>
                <th className="px-4 py-3 font-medium">Condition</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {drafts.map((d) => {
                const modelStr =
                  [d.brand, d.name, d.year?.toString(), d.color].filter(Boolean).join(' · ') ||
                  '(no model info)'
                return (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{modelStr}</td>
                    <td className="px-4 py-3 text-gray-500 capitalize">{d.condition ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500 capitalize">
                      {d.cardedOrLoose ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[d.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {STATUS_LABELS[d.status] ?? d.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {d.createdAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/admin/intake/${d.id}/edit`}
                          className="text-sm text-gray-600 hover:text-gray-900"
                        >
                          {d.status === 'converted' || d.status === 'rejected' ? 'View' : 'Edit →'}
                        </Link>
                        {d.convertedItem && (
                          <Link
                            href={`/admin/items/${d.convertedItem.id}/edit`}
                            className="text-xs text-green-700 hover:text-green-900 whitespace-nowrap"
                          >
                            Item →
                          </Link>
                        )}
                        {d.convertedItem?.listing && (
                          <Link
                            href={`/admin/listings/${d.convertedItem.listing.id}/edit`}
                            className="text-xs text-green-700 hover:text-green-900 whitespace-nowrap"
                          >
                            Listing →
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
