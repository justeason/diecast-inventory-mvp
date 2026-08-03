import { prisma } from '@/lib/prisma'

export type WantedMatchResult = {
  catalogModelId: string
  hasActiveListing: boolean
  activeListingCount: number
  lowestActivePrice: number | null
  firstListingId: string | null
}

// Batch query: one DB round-trip for all catalogModelIds.
// Predicate: Listing.status='active', price>0, ItemInstance.status='available'.
// Results ordered by price ASC, id ASC so first-seen per catalogId is lowest-price deterministic listing.
export async function matchWantedList(
  catalogModelIds: string[],
): Promise<Map<string, WantedMatchResult>> {
  const result = new Map<string, WantedMatchResult>(
    catalogModelIds.map(id => [
      id,
      { catalogModelId: id, hasActiveListing: false, activeListingCount: 0, lowestActivePrice: null, firstListingId: null },
    ]),
  )
  if (catalogModelIds.length === 0) return result

  const listings = await prisma.listing.findMany({
    where: {
      status: 'active',
      price: { gt: 0 },
      item: { status: 'available', catalogId: { in: catalogModelIds } },
    },
    orderBy: [{ price: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      price: true,
      item: { select: { catalogId: true } },
    },
  })

  for (const listing of listings) {
    const catalogId = listing.item.catalogId
    const entry = result.get(catalogId)
    if (!entry) continue
    entry.hasActiveListing = true
    entry.activeListingCount++
    if (entry.firstListingId === null) {
      // First seen = lowest price by DB sort (price ASC, id ASC tiebreaker)
      entry.lowestActivePrice = listing.price
      entry.firstListingId = listing.id
    }
  }

  return result
}
