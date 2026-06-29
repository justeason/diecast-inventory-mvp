import Link from 'next/link'
import { type Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { ItemFilterBar } from '@/components/admin/ItemFilterBar'
import { Pagination } from '@/components/shared/Pagination'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  available: 'Available',
  reserved: 'Reserved',
  sold: 'Sold',
  not_for_sale: 'Not for Sale',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  available: 'bg-green-100 text-green-700',
  reserved: 'bg-yellow-100 text-yellow-700',
  sold: 'bg-blue-100 text-blue-700',
  not_for_sale: 'bg-red-100 text-red-700',
}

const LISTING_STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  sold: 'bg-blue-100 text-blue-700',
  archived: 'bg-gray-100 text-gray-600',
}

const LISTING_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  sold: 'Sold',
  archived: 'Archived',
}

const VALID_STATUSES = new Set(['draft', 'available', 'reserved', 'sold', 'not_for_sale'])
const VALID_CONDITIONS = new Set(['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'])
const VALID_TYPES = new Set(['carded', 'loose'])
const VALID_SORTS = new Set(['sku', 'newest', 'oldest', 'brand', 'status'])

const PAGE_SIZE = 25

export default async function AdminItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; condition?: string; type?: string; sort?: string; page?: string }>
}) {
  const { q: rawQ, status: rawStatus, condition: rawCondition, type: rawType, sort: rawSort, page: rawPage } =
    await searchParams

  const q = rawQ?.trim() ?? ''
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : ''
  const condition = rawCondition && VALID_CONDITIONS.has(rawCondition) ? rawCondition : ''
  const cardedOrLoose = rawType && VALID_TYPES.has(rawType) ? rawType : ''
  const sort = rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'sku'
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1') || 1)

  // Build where clause
  const where: Prisma.ItemInstanceWhereInput = {}

  if (q) {
    const orConditions: Prisma.ItemInstanceWhereInput[] = [
      { sku: { contains: q } },
      { catalog: { brand: { contains: q } } },
      { catalog: { name: { contains: q } } },
      { catalog: { series: { contains: q } } },
      { catalog: { color: { contains: q } } },
      { location: { label: { contains: q } } },
    ]
    const yearNum = parseInt(q, 10)
    if (!isNaN(yearNum)) {
      orConditions.push({ catalog: { year: { equals: yearNum } } })
    }
    where.OR = orConditions
  }

  if (status) where.status = status
  if (condition) where.condition = condition
  if (cardedOrLoose) where.cardedOrLoose = cardedOrLoose

  // Build orderBy
  const orderBy:
    | Prisma.ItemInstanceOrderByWithRelationInput
    | Prisma.ItemInstanceOrderByWithRelationInput[] =
    sort === 'newest'
      ? { createdAt: 'desc' }
      : sort === 'oldest'
        ? { createdAt: 'asc' }
        : sort === 'brand'
          ? [{ catalog: { brand: 'asc' } }, { catalog: { name: 'asc' } }]
          : sort === 'status'
            ? { status: 'asc' }
            : { sku: 'asc' }

  // Step 3: count filtered results
  const filteredCount = await prisma.itemInstance.count({ where })

  // Steps 4–6: compute pages, clamp, skip
  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * PAGE_SIZE

  // Step 7: fetch current page
  const items = await prisma.itemInstance.findMany({
    where,
    orderBy,
    skip,
    take: PAGE_SIZE,
    include: {
      catalog: { select: { brand: true, name: true } },
      location: { select: { label: true } },
      listing: { select: { id: true, status: true } },
      photos: { where: { type: 'front' }, take: 1, select: { url: true } },
    },
  })

  const paginationParams: Record<string, string> = {}
  if (q) paginationParams.q = q
  if (status) paginationParams.status = status
  if (condition) paginationParams.condition = condition
  if (cardedOrLoose) paginationParams.type = cardedOrLoose
  if (sort !== 'sku') paginationParams.sort = sort

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Item Instances</h1>
        <Link
          href="/admin/items/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          New Item
        </Link>
      </div>

      <ItemFilterBar
        q={q}
        status={status}
        condition={condition}
        cardedOrLoose={cardedOrLoose}
        sort={sort}
      />

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">
          {filteredCount === 0 && (q || status || condition || cardedOrLoose)
            ? 'No items match the current filters.'
            : 'No items yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium w-14"></th>
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Catalog</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">Condition</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">List Price</th>
                <th className="px-4 py-3 font-medium">Listing</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <PhotoThumbnail
                      photoUrl={item.photos[0]?.url ?? null}
                      alt={item.sku}
                      size="sm"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{item.sku}</td>
                  <td className="px-4 py-3">
                    {item.catalog.brand} – {item.catalog.name}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{item.location?.label ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {CONDITION_LABELS[item.condition] ?? item.condition}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.status] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {item.listPrice != null ? `$${item.listPrice.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {item.listing ? (
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${LISTING_STATUS_COLORS[item.listing.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {LISTING_STATUS_LABELS[item.listing.status] ?? item.listing.status}
                      </span>
                    ) : item.status === 'available' ? (
                      <Link
                        href={`/admin/listings/new?itemId=${item.id}`}
                        className="text-blue-600 hover:underline text-sm"
                      >
                        List →
                      </Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/items/${item.id}/edit`}
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
        basePath="/admin/items"
        params={paginationParams}
      />
    </>
  )
}
