import Link from 'next/link'
import { type Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ListingFilterBar } from '@/components/admin/ListingFilterBar'
import { Pagination } from '@/components/shared/Pagination'

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

const PAGE_SIZE = 25

export default async function AdminListingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string; page?: string }>
}) {
  const { q: rawQ, status: rawStatus, sort: rawSort, page: rawPage } = await searchParams

  const q = rawQ?.trim() ?? ''
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : ''
  const sort = rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'newest'
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1') || 1)

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
            : { createdAt: 'desc' }

  // Step 3: count filtered results
  const filteredCount = await prisma.listing.count({ where })

  // Steps 4–6: compute pages, clamp, skip
  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * PAGE_SIZE

  // Step 7: fetch current page
  const listings = await prisma.listing.findMany({
    where,
    orderBy,
    skip,
    take: PAGE_SIZE,
    include: {
      item: {
        select: {
          sku: true,
          catalog: { select: { brand: true, name: true } },
          _count: { select: { photos: true } },
        },
      },
    },
  })

  const paginationParams: Record<string, string> = {}
  if (q) paginationParams.q = q
  if (status) paginationParams.status = status
  if (sort !== 'newest') paginationParams.sort = sort

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

      {listings.length === 0 ? (
        <p className="text-sm text-gray-500">
          {filteredCount === 0 && (q || status)
            ? 'No listings match the current filters.'
            : 'No listings yet.'}
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
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[listing.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {STATUS_LABELS[listing.status] ?? listing.status}
                      </span>
                      {listing.status === 'active' && listing.item._count.photos === 0 && (
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                          No item photos
                        </span>
                      )}
                    </div>
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

      <Pagination
        page={page}
        totalPages={totalPages}
        totalCount={filteredCount}
        pageSize={PAGE_SIZE}
        basePath="/admin/listings"
        params={paginationParams}
      />
    </>
  )
}
