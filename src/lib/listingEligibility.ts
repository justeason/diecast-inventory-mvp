import type { Prisma } from '@prisma/client'

// 16H established this predicate ("purchasable Listing") inline inside
// catalogModelHubQuery.ts; 16J adds a second model-centric consumer (catalog
// discovery availability). Centralized here so the two never drift — /browse's own
// inline predicate (part of a larger filter AND array) is left untouched, since
// changing it is out of 16J's scope.
export function eligibleListingWhere(catalogId: string | string[], marketVariantId?: string): Prisma.ListingWhereInput {
  return {
    status: 'active',
    item: {
      status: 'available',
      catalogId: Array.isArray(catalogId) ? { in: catalogId } : catalogId,
      ...(marketVariantId !== undefined ? { marketVariantId } : {}),
    },
  }
}

// 20A: the SAME eligibility rule, expressed from ItemInstance's own side (no
// catalogId scoping needed — used inside a CatalogModel.items relation filter,
// where Prisma already scopes to the parent row). Used with `some`/`none` to
// ask "does this CatalogModel have >=1 eligible Listing" without a raw EXISTS
// query and without fetching any Listing rows.
export function eligibleItemInstanceWhere(): Prisma.ItemInstanceWhereInput {
  return {
    status: 'available',
    listing: { status: 'active' },
  }
}
