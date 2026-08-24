import type { Prisma } from '@prisma/client'

// 16H established this predicate ("purchasable Listing") inline inside
// catalogModelHubQuery.ts; 16J adds a second model-centric consumer (catalog
// discovery availability). Centralized here so the two never drift — /browse's own
// inline predicate (part of a larger filter AND array) is left untouched, since
// changing it is out of 16J's scope.
export function eligibleListingWhere(catalogId: string | string[]): Prisma.ListingWhereInput {
  return {
    status: 'active',
    item: {
      status: 'available',
      catalogId: Array.isArray(catalogId) ? { in: catalogId } : catalogId,
    },
  }
}
