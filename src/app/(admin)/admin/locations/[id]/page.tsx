import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  draft:        'Draft',
  available:    'Available',
  reserved:     'Reserved',
  sold:         'Sold',
  not_for_sale: 'Not for Sale',
}

const SOURCE_LABELS: Record<string, string> = {
  company_owned: 'Company',
  buyout:        'Buyout',
  consignment:   'Consignment',
}

export default async function LocationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ status?: string; source?: string; q?: string; sellerOnly?: string }>
}) {
  const { id } = await params
  const { status: statusFilter, source: sourceFilter, q, sellerOnly } = await searchParams

  const itemWhere = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(sourceFilter ? { sourceType: sourceFilter } : {}),
    ...(sellerOnly ? { sourceType: { in: ['buyout', 'consignment'] } } : {}),
    ...(q?.trim()
      ? {
          catalog: {
            OR: [
              { brand: { contains: q.trim(), mode: 'insensitive' as const } },
              { name: { contains: q.trim(), mode: 'insensitive' as const } },
            ],
          },
        }
      : {}),
  }

  const location = await prisma.storageLocation.findUnique({
    where: { id },
    include: {
      items: {
        where: itemWhere,
        select: {
          id: true,
          sku: true,
          status: true,
          sourceType: true,
          catalogId: true,
          catalog: { select: { brand: true, name: true } },
          listing: { select: { id: true, price: true } },
        },
        orderBy: [{ status: 'asc' }, { sku: 'asc' }],
      },
      intakeDrafts: {
        where: { status: { in: ['draft', 'reviewed'] } },
        select: {
          id: true,
          status: true,
          brand: true,
          name: true,
          receivedAt: true,
          sellerSubmissionId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      },
    },
  })

  if (!location) notFound()

  // Unfiltered counts for summary (always shows totals regardless of current filter)
  const allItems = await prisma.itemInstance.findMany({
    where: { locationId: id },
    select: { id: true, status: true, sourceType: true },
  })
  const byStatus = new Map<string, number>()
  const bySource = new Map<string, number>()
  for (const item of allItems) {
    byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1)
    if (item.sourceType) bySource.set(item.sourceType, (bySource.get(item.sourceType) ?? 0) + 1)
  }

  const activeItems = location.items.filter((i) => i.status !== 'sold' && i.status !== 'not_for_sale')
  const soldItems = location.items.filter((i) => i.status === 'sold')

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <Link href="/admin/locations" className="text-sm text-gray-500 hover:text-gray-900">
            ← Back to Locations
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">{location.label}</h1>
          {location.notes && <p className="text-sm text-gray-500 mt-1">{location.notes}</p>}
        </div>
        <Link
          href={`/admin/locations/${id}/edit`}
          className="text-sm font-medium text-blue-600 hover:underline mt-8"
        >
          Edit →
        </Link>
      </div>

      {/* Item filters */}
      <form method="GET" action={`/admin/locations/${id}`} className="flex flex-wrap gap-2 mb-6">
        <input
          type="text"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search brand/model…"
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          name="status"
          defaultValue={statusFilter ?? ''}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select
          name="source"
          defaultValue={sourceFilter ?? ''}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none"
        >
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
          <input type="checkbox" name="sellerOnly" value="1" defaultChecked={!!sellerOnly} />
          Seller-sourced only
        </label>
        <button type="submit" className="px-3 py-1.5 rounded-md bg-gray-800 text-white text-sm hover:bg-gray-900">
          Filter
        </button>
        {(statusFilter || sourceFilter || q || sellerOnly) && (
          <Link
            href={`/admin/locations/${id}`}
            className="px-3 py-1.5 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
          >
            Clear
          </Link>
        )}
      </form>

      {/* Summary counts */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <p className="text-2xl font-bold text-gray-900">{allItems.length}</p>
          <p className="text-sm text-gray-500">Total items{(statusFilter || sourceFilter || q || sellerOnly) ? ' (unfiltered)' : ''}</p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <p className="text-2xl font-bold text-gray-900">{activeItems.length}</p>
          <p className="text-sm text-gray-500">Active</p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <p className="text-2xl font-bold text-gray-900">{location.intakeDrafts.length}</p>
          <p className="text-sm text-gray-500">Pending intakes</p>
        </div>
      </div>

      {/* Breakdown by status */}
      <div className="mb-8 grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">By Status</h2>
          <div className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100">
            {Object.entries(STATUS_LABELS).map(([key, label]) => {
              const count = byStatus.get(key) ?? 0
              if (count === 0 && !['available', 'draft'].includes(key)) return null
              return (
                <div key={key} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-gray-600">{label}</span>
                  <span className="font-medium text-gray-900">{count}</span>
                </div>
              )
            })}
          </div>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">By Source</h2>
          <div className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100">
            {Object.entries(SOURCE_LABELS).map(([key, label]) => {
              const count = bySource.get(key) ?? 0
              return (
                <div key={key} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-gray-600">{label}</span>
                  <span className="font-medium text-gray-900">{count}</span>
                </div>
              )
            })}
            {bySource.size === 0 && (
              <div className="px-4 py-2 text-sm text-gray-400">No items</div>
            )}
          </div>
        </div>
      </div>

      {/* Pending intake drafts assigned here */}
      {location.intakeDrafts.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Pending Intakes
          </h2>
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {location.intakeDrafts.map((draft) => (
              <div key={draft.id} className="flex items-center gap-4 px-4 py-3">
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  draft.status === 'reviewed' ? 'bg-blue-100 text-blue-700' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {draft.status}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {[draft.brand, draft.name].filter(Boolean).join(' ') || 'Untitled draft'}
                  </p>
                  <p className="text-xs text-gray-500">
                    {draft.receivedAt
                      ? `Received ${draft.receivedAt.toLocaleDateString()}`
                      : `Created ${draft.createdAt.toLocaleDateString()}`}
                  </p>
                </div>
                <Link
                  href={`/admin/intake/${draft.id}/edit`}
                  className="shrink-0 text-sm font-medium text-blue-600 hover:underline"
                >
                  Edit →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active items */}
      {activeItems.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Active Items ({activeItems.length})
          </h2>
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {activeItems.map((item) => (
              <div key={item.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {item.sku}
                    {item.catalog && (
                      <span className="ml-2 text-gray-400 font-normal">
                        {item.catalog.brand} {item.catalog.name}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {STATUS_LABELS[item.status] ?? item.status}
                    {item.sourceType && ` · ${SOURCE_LABELS[item.sourceType] ?? item.sourceType}`}
                    {item.listing && ` · $${item.listing.price.toFixed(2)}`}
                  </p>
                </div>
                <Link
                  href={`/admin/items/${item.id}/edit`}
                  className="shrink-0 text-sm text-gray-500 hover:text-gray-900"
                >
                  View →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sold items summary */}
      {soldItems.length > 0 && (
        <details className="rounded-md border border-gray-200 bg-white">
          <summary className="px-4 py-3 text-sm font-medium text-gray-600 cursor-pointer">
            Sold items ({soldItems.length})
          </summary>
          <div className="divide-y divide-gray-100">
            {soldItems.map((item) => (
              <div key={item.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 truncate">
                    {item.sku}
                    {item.catalog && (
                      <span className="ml-2 text-gray-400">
                        {item.catalog.brand} {item.catalog.name}
                      </span>
                    )}
                  </p>
                </div>
                <Link
                  href={`/admin/items/${item.id}/edit`}
                  className="shrink-0 text-xs text-gray-400 hover:text-gray-700"
                >
                  View →
                </Link>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  )
}
