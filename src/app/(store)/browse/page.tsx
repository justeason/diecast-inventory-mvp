import type { Metadata } from 'next'
import Link from 'next/link'
import { Prisma } from '@prisma/client'

export const metadata: Metadata = {
  title: 'Browse Collectibles | CollectNTrades',
  description: 'Browse available die-cast cars, collectibles, and trading cards.',
}
import { prisma } from '@/lib/prisma'
import { SearchFilterBar } from '@/components/store/SearchFilterBar'
import { ListingCard } from '@/components/store/ListingCard'
import { Pagination } from '@/components/shared/Pagination'

const PAGE_SIZE = 24

const VALID_CONDITIONS = new Set(['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'])
const VALID_TYPES = new Set(['carded', 'loose'])
const VALID_SORTS = new Set(['newest', 'price_low', 'price_high', 'brand_name'])

function parsePrice(v: string | undefined): number | null {
  if (!v || !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    condition?: string
    type?: string
    brand?: string
    minPrice?: string
    maxPrice?: string
    sort?: string
    page?: string
  }>
}) {
  const {
    q: rawQ,
    condition: rawCondition,
    type: rawType,
    brand: rawBrand,
    minPrice: rawMin,
    maxPrice: rawMax,
    sort: rawSort,
    page: rawPage,
  } = await searchParams

  const q = rawQ?.trim() ?? ''
  const condition = rawCondition && VALID_CONDITIONS.has(rawCondition) ? rawCondition : ''
  const type = rawType && VALID_TYPES.has(rawType) ? rawType : ''
  const brand = rawBrand?.trim() ?? ''
  const minPrice = rawMin?.trim() ?? ''
  const maxPrice = rawMax?.trim() ?? ''
  const sort = rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'newest'
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1') || 1)

  // Price parsing
  const minPriceNum = parsePrice(minPrice)
  const maxPriceNum = parsePrice(maxPrice)
  // Ignore both when range is inverted
  const priceRangeInvalid =
    minPriceNum !== null && maxPriceNum !== null && minPriceNum > maxPriceNum
  // Show warning when any non-empty price input was ignored
  const showPriceWarning =
    (minPrice !== '' && minPriceNum === null) ||
    (maxPrice !== '' && maxPriceNum === null) ||
    priceRangeInvalid

  // Build where clause
  const conditions: Prisma.ListingWhereInput[] = [
    { status: 'active' },
    { item: { status: 'available' } },
  ]

  if (condition) conditions.push({ item: { condition } })
  if (type) conditions.push({ item: { cardedOrLoose: type } })
  if (brand) conditions.push({ item: { catalog: { brand } } })

  if (!priceRangeInvalid) {
    if (minPriceNum !== null) conditions.push({ price: { gte: minPriceNum } })
    if (maxPriceNum !== null) conditions.push({ price: { lte: maxPriceNum } })
  }

  if (q) {
    const yearNum = parseInt(q, 10)
    const orClauses: Prisma.ListingWhereInput[] = [
      { title: { contains: q } },
      { item: { sku: { contains: q } } },
      { item: { catalog: { brand: { contains: q } } } },
      { item: { catalog: { name: { contains: q } } } },
      { item: { catalog: { series: { contains: q } } } },
      { item: { catalog: { color: { contains: q } } } },
    ]
    // Only add year search when q is a clean integer
    if (Number.isInteger(yearNum) && String(yearNum) === q.trim()) {
      orClauses.push({ item: { catalog: { year: { equals: yearNum } } } })
    }
    conditions.push({ OR: orClauses })
  }

  const where: Prisma.ListingWhereInput = { AND: conditions }

  // Build orderBy
  const orderBy: Prisma.ListingOrderByWithRelationInput | Prisma.ListingOrderByWithRelationInput[] =
    sort === 'price_low'
      ? { price: 'asc' }
      : sort === 'price_high'
        ? { price: 'desc' }
        : sort === 'brand_name'
          ? [
              { item: { catalog: { brand: 'asc' } } },
              { item: { catalog: { name: 'asc' } } },
            ]
          : { createdAt: 'desc' }

  // Step 3: count + fetch brands in parallel
  const [filteredCount, brandRows] = await Promise.all([
    prisma.listing.count({ where }),
    prisma.catalogModel.findMany({
      distinct: ['brand'],
      select: { brand: true },
      orderBy: { brand: 'asc' },
      where: {
        items: {
          some: {
            status: 'available',
            listing: { status: 'active' },
          },
        },
      },
    }),
  ])

  const brands = brandRows.map((r) => r.brand)

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
          cardedOrLoose: true,
          condition: true,
          catalog: {
            select: {
              brand: true, name: true, year: true, series: true, color: true,
              photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true, altText: true } },
            },
          },
          photos: { where: { type: 'front' }, take: 1, select: { url: true } },
        },
      },
    },
  })

  const paginationParams: Record<string, string> = {}
  if (q) paginationParams.q = q
  if (condition) paginationParams.condition = condition
  if (type) paginationParams.type = type
  if (brand) paginationParams.brand = brand
  if (minPrice) paginationParams.minPrice = minPrice
  if (maxPrice) paginationParams.maxPrice = maxPrice
  if (sort !== 'newest') paginationParams.sort = sort

  const hasActiveFilters = !!(q || condition || type || brand || minPrice || maxPrice)

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Browse Listings</h1>
      </div>

      <SearchFilterBar
        q={q}
        condition={condition}
        type={type}
        brand={brand}
        minPrice={minPrice}
        maxPrice={maxPrice}
        sort={sort}
        brands={brands}
      />

      {showPriceWarning && (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Invalid price filter ignored. Please enter a valid price range.
        </p>
      )}

      {listings.length === 0 ? (
        <div className="py-12 text-center">
          {filteredCount === 0 && hasActiveFilters ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">No listings match your search.</p>
              <p className="text-sm text-gray-400">
                Try removing a filter or{' '}
                <Link href="/browse" className="text-gray-700 underline underline-offset-2">
                  browse all listings
                </Link>
                .
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">No listings yet — check back soon.</p>
              <Link href="/" className="text-sm text-gray-400 hover:text-gray-700">
                ← Back to home
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {listings.map((listing) => {
            const itemPhoto = listing.item.photos[0]
            const catalogPhoto = listing.item.catalog.photos[0]
            const photoUrl = itemPhoto?.url ?? catalogPhoto?.url ?? null
            const imageSource: 'item' | 'catalog' | 'none' =
              itemPhoto ? 'item' : catalogPhoto ? 'catalog' : 'none'
            return (
              <ListingCard
                key={listing.id}
                listing={listing}
                photoUrl={photoUrl}
                imageSource={imageSource}
              />
            )
          })}
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
