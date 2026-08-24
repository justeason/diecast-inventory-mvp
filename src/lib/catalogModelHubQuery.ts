// 16H: DB boundary for the canonical CatalogModel customer hub (/catalog/[id]).
// One model lookup + the same "purchasable" Listing predicate /browse already uses
// (status: 'active', item.status: 'available') scoped to this one model, plus an
// exact count and an authoritative min-price aggregate — never derived from the
// bounded/paginated Listing list, so neither total can silently undercount once a
// model has more Listings than one page. No N+1, no relationship/valuation query
// lives here (those are the caller's job — see /catalog/[id]/page.tsx).
import { prisma } from '@/lib/prisma'
import { eligibleListingWhere } from './listingEligibility'

export const LISTING_PAGE_SIZE = 24

export type CatalogModelHubListing = {
  id: string
  title: string
  price: number
  item: {
    sku: string
    cardedOrLoose: string
    condition: string
    catalog: {
      id: string
      brand: string
      name: string
      year: number | null
      series: string | null
      color: string | null
    }
    photos: { url: string }[]
  }
}

export type CatalogModelHubData = {
  model: {
    id: string
    brand: string
    name: string
    year: number | null
    series: string | null
    color: string | null
    scale: string | null
    photoUrl: string | null
  }
  listings: CatalogModelHubListing[]
  nextCursor: string | null
  // Exact — from a dedicated count(), never items.length.
  listingCount: number
  // Authoritative — from a dedicated min-price aggregate, never inferred from a
  // bounded/reordered page of listings.
  lowestPrice: number | null
}

export async function getCatalogModelHub(
  catalogModelId: string,
  cursor?: string,
): Promise<CatalogModelHubData | null> {
  const model = await prisma.catalogModel.findUnique({
    where: { id: catalogModelId },
    select: {
      id: true, brand: true, name: true, year: true, series: true, color: true, scale: true,
      photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
    },
  })
  if (!model) return null

  // Same purchasable-Listing predicate /browse's own query uses, scoped to this model.
  // 16J: extracted to a shared helper (listingEligibility.ts) — reused unchanged by
  // catalogDiscoveryQuery.ts's availability aggregation.
  const listingWhere = eligibleListingWhere(catalogModelId)

  const [listingCount, priceAgg, rows] = await Promise.all([
    prisma.listing.count({ where: listingWhere }),
    prisma.listing.aggregate({ where: listingWhere, _min: { price: true } }),
    prisma.listing.findMany({
      where: listingWhere,
      orderBy: { id: 'asc' },
      take: LISTING_PAGE_SIZE + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        title: true,
        price: true,
        item: {
          select: {
            sku: true,
            cardedOrLoose: true,
            condition: true,
            catalog: { select: { id: true, brand: true, name: true, year: true, series: true, color: true } },
            photos: { where: { type: 'front' }, take: 1, select: { url: true } },
          },
        },
      },
    }),
  ])

  const hasMore = rows.length > LISTING_PAGE_SIZE
  const listings = hasMore ? rows.slice(0, LISTING_PAGE_SIZE) : rows
  const nextCursor = hasMore ? listings[listings.length - 1].id : null

  return {
    model: {
      id: model.id,
      brand: model.brand,
      name: model.name,
      year: model.year,
      series: model.series,
      color: model.color,
      scale: model.scale,
      photoUrl: model.photos[0]?.url ?? null,
    },
    listings,
    nextCursor,
    listingCount,
    lowestPrice: priceAgg._min.price,
  }
}
