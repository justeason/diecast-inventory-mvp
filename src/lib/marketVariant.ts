import type { Prisma } from '@prisma/client'

// 21B: MarketVariant is a packaging-only (Carded/Loose) market-comparison bucket
// between CatalogModel and physical inventory. Every CatalogModel is system-
// managed to have exactly these two rows — no admin CRUD, no third value, no
// "Unspecified" placeholder. Unknown packaging is always marketVariantId = null.

export const PACKAGING_TYPES = ['carded', 'loose'] as const
export type PackagingType = (typeof PACKAGING_TYPES)[number]

export function isValidPackagingType(value: string | null | undefined): value is PackagingType {
  return value === 'carded' || value === 'loose'
}

// Idempotent: safe to call for both newly created and pre-existing CatalogModel
// rows. Relies on the @@unique([catalogModelId, packagingType]) constraint —
// no explicit row locking needed, matching this codebase's established
// P2002-catch-and-refetch idiom for race-safe idempotent creation.
export async function ensurePackagingMarketVariants(
  tx: Prisma.TransactionClient,
  catalogModelId: string
): Promise<void> {
  for (const packagingType of PACKAGING_TYPES) {
    const existing = await tx.marketVariant.findUnique({
      where: { catalogModelId_packagingType: { catalogModelId, packagingType } },
      select: { id: true },
    })
    if (existing) continue
    try {
      await tx.marketVariant.create({ data: { catalogModelId, packagingType } })
    } catch (err) {
      // P2002: lost the create race to a concurrent ensurePackagingMarketVariants
      // call — the row now exists, which is exactly the desired end state.
      if (!(err instanceof Error) || !('code' in err) || (err as { code?: string }).code !== 'P2002') {
        throw err
      }
    }
  }
}

// Server-side resolution only — callers must never trust a request-supplied
// marketVariantId. Returns null if the (catalogModelId, packagingType) pair
// doesn't resolve to an existing row (e.g. packagingType not yet valid/known).
export async function findPackagingMarketVariant(
  tx: Prisma.TransactionClient,
  catalogModelId: string,
  packagingType: string
): Promise<{ id: string } | null> {
  if (!isValidPackagingType(packagingType)) return null
  return tx.marketVariant.findUnique({
    where: { catalogModelId_packagingType: { catalogModelId, packagingType } },
    select: { id: true },
  })
}

// For ItemInstance: marketVariantId is REQUIRED. Every CatalogModel is guaranteed
// to already have both packaging variants by the time any ItemInstance references
// it, so a null result here is an unexpected/defensive error, not a legitimate case.
export async function resolvePackagingMarketVariant(
  tx: Prisma.TransactionClient,
  catalogModelId: string,
  cardedOrLoose: string
): Promise<string> {
  const variant = await findPackagingMarketVariant(tx, catalogModelId, cardedOrLoose)
  if (!variant) {
    throw new Error(
      `MARKET_VARIANT_NOT_FOUND: no MarketVariant for catalogModelId=${catalogModelId} packagingType=${cardedOrLoose}`
    )
  }
  return variant.id
}

// For nullable IntakeDraft/ExternalMarketObservation targets: returns null instead
// of throwing whenever either input is missing/unknown/invalid — "unknown" is not
// a price-comparable market variant, never fabricate a bucket for it.
export async function computeMarketVariantId(
  tx: Prisma.TransactionClient,
  catalogModelId: string | null | undefined,
  cardedOrLoose: string | null | undefined
): Promise<string | null> {
  if (!catalogModelId || !isValidPackagingType(cardedOrLoose)) return null
  const variant = await findPackagingMarketVariant(tx, catalogModelId, cardedOrLoose)
  return variant?.id ?? null
}
