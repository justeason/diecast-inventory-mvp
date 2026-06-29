import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { SearchFilterBar } from '@/components/store/SearchFilterBar'
import { ListingCard } from '@/components/store/ListingCard'
import { Pagination } from '@/components/shared/Pagination'

const PAGE_SIZE = 24

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; condition?: string; type?: string; page?: string }>
}) {
  const { q, condition, type, page: rawPage } = await searchParams
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1') || 1)

  const conditions: Prisma.ListingWhereInput[] = [
    { status: 'active' },
    { item: { status: 'available' } },
  ]

  if (condition) conditions.push({ item: { condition } })
  if (type) conditions.push({ item: { cardedOrLoose: type } })

  if (q) {
    conditions.push({
      OR: [
        { title: { contains: q } },
        { item: { sku: { contains: q } } },
        { item: { catalog: { brand: { contains: q } } } },
        { item: { catalog: { name: { contains: q } } } },
        { item: { catalog: { series: { contains: q } } } },
        { item: { catalog: { color: { contains: q } } } },
      ],
    })
  }

  const where = { AND: conditions }

  // Step 3: count filtered results
  const filteredCount = await prisma.listing.count({ where })

  // Steps 4–6: compute pages, clamp, skip
  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * PAGE_SIZE

  // Step 7: fetch current page
  const listings = await prisma.listing.findMany({
    where,
    skip,
    take: PAGE_SIZE,
    include: {
      item: {
        select: {
          sku: true,
          cardedOrLoose: true,
          condition: true,
          catalog: {
            select: { brand: true, name: true, year: true, series: true, color: true },
          },
          photos: { where: { type: 'front' }, take: 1, select: { url: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const paginationParams: Record<string, string> = {}
  if (q) paginationParams.q = q
  if (condition) paginationParams.condition = condition
  if (type) paginationParams.type = type

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Browse Listings</h1>
      </div>

      <SearchFilterBar q={q} condition={condition} type={type} />

      {listings.length === 0 ? (
        <p className="text-sm text-gray-500">
          {filteredCount === 0 && (q || condition || type)
            ? 'No listings found matching your search.'
            : 'No listings available.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {listings.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              photoUrl={listing.item.photos[0]?.url ?? null}
            />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        totalCount={filteredCount}
        pageSize={PAGE_SIZE}
        basePath="/browse"
        params={paginationParams}
      />
    </>
  )
}
