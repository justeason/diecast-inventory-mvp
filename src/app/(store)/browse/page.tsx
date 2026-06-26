import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { SearchFilterBar } from '@/components/store/SearchFilterBar'
import { ListingCard } from '@/components/store/ListingCard'

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; condition?: string; type?: string }>
}) {
  const { q, condition, type } = await searchParams

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

  const listings = await prisma.listing.findMany({
    where: { AND: conditions },
    include: {
      item: {
        select: {
          sku: true,
          cardedOrLoose: true,
          condition: true,
          catalog: {
            select: { brand: true, name: true, year: true, series: true, color: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Browse Listings</h1>
        <p className="mt-1 text-sm text-gray-500">
          {listings.length} listing{listings.length !== 1 ? 's' : ''} found
        </p>
      </div>

      <SearchFilterBar q={q} condition={condition} type={type} />

      {listings.length === 0 ? (
        <p className="text-sm text-gray-500">No listings found.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {listings.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      )}
    </>
  )
}
