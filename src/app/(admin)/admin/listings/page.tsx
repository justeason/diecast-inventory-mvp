import Link from 'next/link'
import { type Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ListingFilterBar } from '@/components/admin/ListingFilterBar'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  sold: 'bg-blue-100 text-blue-700',
  archived: 'bg-gray-100 text-gray-600',
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  sold: 'Sold',
  archived: 'Archived',
}

const VALID_STATUSES = new Set(['active', 'sold', 'archived'])
const VALID_SORTS = new Set(['newest', 'oldest', 'price_asc', 'price_desc', 'status'])

export default async function AdminListingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>
}) {
  const { q: rawQ, status: rawStatus, sort: rawSort } = await searchParams

  const q = rawQ?.trim() ?? ''
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : ''
  const sort = rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'newest'

  // Build where clause
  const where: Prisma.ListingWhereInput = {}

  if (q) {
    where.OR = [
      { title: { contains: q } },
      { item: { sku: { contains: q } } },
      { item: { catalog: { brand: { contains: q } } } },
      { item: { catalog: { name: { contains: q } } } },
    ]
  }

  if (status) where.status = status

  // Build orderBy
  const orderBy: Prisma.ListingOrderByWithRelationInput =
    sort === 'oldest'
      ? { createdAt: 'asc' }
      : sort === 'price_asc'
        ? { price: 'asc' }
        : sort === 'price_desc'
          ? { price: 'desc' }
          : sort === 'status'
            ? { status: 'asc' }
            : { createdAt: 'desc' } // default: newest

  const isFiltered = q !== '' || status !== ''

  const [listings, totalCount] = await Promise.all([
    prisma.listing.findMany({
      where,
      orderBy,
      include: {
        item: {
          select: {
            sku: true,
            catalog: { select: { brand: true, name: true } },
          },
        },
      },
    }),
    prisma.listing.count(),
  ])

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Listings</h1>
        <Link
          href="/admin/listings/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          New Listing
        </Link>
      </div>

      <ListingFilterBar q={q} status={status} sort={sort} />

      {isFiltered && (
        <p className="text-sm text-gray-500 mb-4">
          Showing {listings.length} matching {listings.length === 1 ? 'listing' : 'listings'} out of{' '}
          {totalCount} total {totalCount === 1 ? 'listing' : 'listings'}.
        </p>
      )}

      {listings.length === 0 ? (
        <p className="text-sm text-gray-500">
          {isFiltered ? 'No listings match the current filters.' : 'No listings yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Item</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {listings.map((listing) => (
                <tr key={listing.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{listing.title}</td>
                  <td className="px-4 py-3 text-gray-500">
                    <span className="font-mono text-xs">{listing.item.sku ?? 'No SKU'}</span>
                    {' — '}
                    {listing.item.catalog.brand} {listing.item.catalog.name}
                  </td>
                  <td className="px-4 py-3">${listing.price.toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[listing.status] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {STATUS_LABELS[listing.status] ?? listing.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {listing.createdAt.toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/listings/${listing.id}/edit`}
                      className="text-blue-600 hover:underline text-sm"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
