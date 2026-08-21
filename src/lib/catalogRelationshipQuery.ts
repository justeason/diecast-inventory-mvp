// 16F: batched, customer-scoped "does this customer already want/own each of these
// CatalogModels" lookup for catalog interaction cards (/browse). Exactly two
// queries total, both scoped to catalogModelId IN (current page's ids) — never a
// full Wanted/Collection hydration, never one query per card, never the matching
// engine (that's a different concept — availability, not relationship state).
import { prisma } from '@/lib/prisma'

export type CatalogRelationshipEntry = {
  wanted: boolean
  wantedId: string | null
  collectionItemId: string | null
  // From CollectionItem.quantity directly — never a row count (16E semantics).
  ownedQuantity: number | null
}

function emptyEntry(): CatalogRelationshipEntry {
  return { wanted: false, wantedId: null, collectionItemId: null, ownedQuantity: null }
}

export async function getCatalogRelationshipState(
  profileId: string,
  catalogModelIds: string[],
): Promise<Map<string, CatalogRelationshipEntry>> {
  const ids = [...new Set(catalogModelIds)]
  const result = new Map<string, CatalogRelationshipEntry>(ids.map((id) => [id, emptyEntry()]))
  if (ids.length === 0) return result

  const [wantedRows, collectionRows] = await Promise.all([
    prisma.wantedCatalogModel.findMany({
      where: { customerProfileId: profileId, catalogModelId: { in: ids } },
      select: { id: true, catalogModelId: true },
    }),
    prisma.collectionItem.findMany({
      where: { profileId, catalogId: { in: ids } },
      select: { id: true, catalogId: true, quantity: true },
    }),
  ])

  for (const w of wantedRows) {
    const entry = result.get(w.catalogModelId)
    if (entry) {
      entry.wanted = true
      entry.wantedId = w.id
    }
  }
  for (const c of collectionRows) {
    if (!c.catalogId) continue
    const entry = result.get(c.catalogId)
    if (entry) {
      entry.collectionItemId = c.id
      entry.ownedQuantity = c.quantity
    }
  }

  return result
}
