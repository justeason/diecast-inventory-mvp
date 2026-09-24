'use server'

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { del } from '@vercel/blob'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { updateTag } from 'next/cache'
import { checkRateLimit } from '@/lib/rateLimit'
import { internalPriceToCents } from '@/lib/marketMoney'
import { createAcquisitionLot, type AcquisitionSource } from '@/lib/ownershipLedger'

// 30 new items per 10 minutes per profile (instance-local)
const CREATE_MAX    = 30
const CREATE_WINDOW = 10 * 60 * 1000

export async function toggleCollectionItemPublic(id: string, isPublic: boolean): Promise<void> {
  const session = await getBuyerSession()
  if (!session) return

  const existing = await prisma.collectionItem.findFirst({
    where: { id, profileId: session.profileId },
    select: { id: true, catalogId: true },
  })
  if (!existing) return

  // 35B: freeform items (no catalog link) cannot be newly published — the public
  // showcase has no honest way to identify/display them. Existing rows that were
  // already isPublic=true before this rule stay as-is in the DB (no backfill) but
  // public queries exclude them regardless (see communityLeaderboardsQuery.ts).
  if (isPublic && existing.catalogId === null) return

  await prisma.collectionItem.update({ where: { id }, data: { isPublic } })
  updateTag('community-leaderboards')
  revalidatePath('/account/collection')
}

const VALID_CONDITIONS   = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'] as const
const VALID_CARDED_LOOSE = ['carded', 'loose'] as const

function trimOrNull(v: string | undefined | null): string | null {
  const t = v?.trim()
  return t || null
}

function isValidYear(v: string | undefined): boolean {
  if (!v || !v.trim()) return true
  const n = parseInt(v.trim(), 10)
  return !isNaN(n) && n >= 1950 && n <= 2100
}

function isValidQuantity(v: string | undefined): boolean {
  if (!v || !v.trim()) return true
  const n = parseInt(v.trim(), 10)
  return !isNaN(n) && n >= 1 && n <= 999
}

function isValidPurchasePrice(v: string | undefined): boolean {
  if (!v || !v.trim()) return true
  const n = Number(v)
  return Number.isFinite(n) && n >= 0
}

const CollectionItemSchema = z.object({
  catalogId:      z.string().optional(),
  brand:          z.string().optional(),
  name:           z.string().optional(),
  series:         z.string().optional(),
  year:           z.string().optional()
    .refine(isValidYear, 'Year must be between 1950 and 2100'),
  color:          z.string().optional(),
  scale:          z.string().optional(),
  cardedOrLoose:  z.string().optional(),
  condition:      z.string().optional(),
  conditionNotes: z.string().optional(),
  quantity:       z.string().optional()
    .refine(isValidQuantity, 'Quantity must be a whole number of 1 or more'),
  purchasePrice:  z.string().optional()
    .refine(isValidPurchasePrice, 'Purchase price must be 0 or more'),
  purchaseDate:   z.string().optional(),
  notes:          z.string().optional(),
})

export type CollectionItemActionState = { errors: Record<string, string[]> } | null

function validateEnums(data: z.infer<typeof CollectionItemSchema>): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const condition = trimOrNull(data.condition)
  if (condition && !(VALID_CONDITIONS as readonly string[]).includes(condition)) {
    errors.condition = ['Condition must be one of: Mint, Near Mint, Good, Fair, Poor, Damaged']
  }
  const cardedOrLoose = trimOrNull(data.cardedOrLoose)
  if (cardedOrLoose && !(VALID_CARDED_LOOSE as readonly string[]).includes(cardedOrLoose)) {
    errors.cardedOrLoose = ['Must be carded or loose']
  }
  return errors
}

function toDbFields(data: z.infer<typeof CollectionItemSchema>) {
  return {
    brand:          trimOrNull(data.brand),
    name:           trimOrNull(data.name),
    series:         trimOrNull(data.series),
    year:           data.year?.trim() ? parseInt(data.year.trim(), 10) || null : null,
    color:          trimOrNull(data.color),
    scale:          trimOrNull(data.scale),
    cardedOrLoose:  trimOrNull(data.cardedOrLoose),
    condition:      trimOrNull(data.condition),
    conditionNotes: trimOrNull(data.conditionNotes),
    quantity:       data.quantity?.trim() ? (parseInt(data.quantity.trim(), 10) || 1) : 1,
    purchasePrice:  data.purchasePrice?.trim() ? (parseFloat(data.purchasePrice.trim()) ?? null) : null,
    purchaseDate:   data.purchaseDate?.trim() ? new Date(data.purchaseDate.trim()) : null,
    notes:          trimOrNull(data.notes),
  }
}

export async function createCollectionItem(
  _prev: CollectionItemActionState,
  formData: FormData
): Promise<CollectionItemActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in to add collection items.'] } }
  }

  const { allowed, resetMs } = checkRateLimit(
    `create_collection:${session.profileId}`,
    CREATE_MAX,
    CREATE_WINDOW,
  )
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return { errors: { form: [`Too many items added. Please wait ${secs} seconds.`] } }
  }

  const result = CollectionItemSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }

  const catalogIdRaw = trimOrNull(result.data.catalogId)
  const brandRaw     = trimOrNull(result.data.brand)
  const nameRaw      = trimOrNull(result.data.name)

  if (!catalogIdRaw && !brandRaw && !nameRaw) {
    return {
      errors: { form: ['Add a catalog match, brand, or name so this collection item can be identified.'] },
    }
  }

  const enumErrors = validateEnums(result.data)
  if (Object.keys(enumErrors).length > 0) return { errors: enumErrors }

  const requestedPublic = formData.get('isPublic') === 'on'

  let resolvedCatalogId: string | null = null
  if (catalogIdRaw) {
    const found = await prisma.catalogModel.findUnique({
      where: { id: catalogIdRaw },
      select: { id: true },
    })
    if (!found) {
      return { errors: { catalogId: ['Selected catalog model not found. Please refresh and try again.'] } }
    }
    resolvedCatalogId = found.id

    const dupe = await prisma.collectionItem.findFirst({
      where: { profileId: session.profileId, catalogId: resolvedCatalogId },
      select: { id: true },
    })
    if (dupe) {
      return {
        errors: { catalogId: ['You already have this model in your collection. Edit the existing item to adjust the quantity.'] },
      }
    }
  }

  // 16F Final: the findFirst check above is a fast-path for a friendly error in
  // the common case — it is NOT what makes this race-safe. Under true concurrency
  // two requests can both pass that check before either commits. The DB-side
  // @@unique([profileId, catalogId]) constraint (see schema.prisma) is the actual
  // authoritative guarantee; this catch handles the losing request of that race
  // the same way, rather than letting it crash with a raw Prisma error.
  //
  // 26B: the CollectionItem row and its founding AcquisitionLot are created
  // atomically — a CollectionItem is never left without a lot. quantity=0 at
  // create time; createAcquisitionLot's own increment establishes the true
  // value, so the ledger remains the single writer of the quantity cache.
  const dbFields = toDbFields(result.data)
  const sourceRaw = formData.get('source')?.toString()
  const source: AcquisitionSource = sourceRaw === 'i_own_it' ? 'i_own_it' : 'manual'
  const unitRecordedCostCents = dbFields.purchasePrice !== null ? internalPriceToCents(dbFields.purchasePrice) : null
  // 35B: freeform items (no catalog link) cannot be newly published — see
  // toggleCollectionItemPublic for the same rule applied to the toggle path.
  const isPublic = requestedPublic && resolvedCatalogId !== null

  let item: { id: string }
  try {
    item = await prisma.$transaction(async (tx) => {
      const created = await tx.collectionItem.create({
        data: {
          profileId: session.profileId,
          catalogId: resolvedCatalogId ?? undefined,
          isPublic,
          ...dbFields,
          quantity: 0,
        },
      })
      await createAcquisitionLot(tx, {
        collectionItemId: created.id,
        quantityAcquired: dbFields.quantity,
        unitRecordedCostCents,
        costKnowledge: unitRecordedCostCents !== null ? 'known' : 'unknown',
        acquiredAt: dbFields.purchaseDate,
        ledgerEffectiveAt: new Date(),
        source,
      })
      return created
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return {
        errors: { catalogId: ['You already have this model in your collection. Edit the existing item to adjust the quantity.'] },
      }
    }
    throw e
  }

  if (isPublic) updateTag('community-leaderboards')
  redirect(`/account/collection/${item.id}`)
}

export async function updateCollectionItem(
  id: string,
  _prev: CollectionItemActionState,
  formData: FormData
): Promise<CollectionItemActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in to edit collection items.'] } }
  }

  const expectedUpdatedAtRaw = formData.get('expectedUpdatedAt')?.toString() ?? ''
  if (!expectedUpdatedAtRaw) {
    return { errors: { form: ['Please refresh the page and try again.'] } }
  }
  const expectedUpdatedAt = new Date(expectedUpdatedAtRaw)
  if (isNaN(expectedUpdatedAt.getTime())) {
    return { errors: { form: ['Please refresh the page and try again.'] } }
  }

  const existing = await prisma.collectionItem.findFirst({
    where: { id, profileId: session.profileId },
    select: { id: true, isPublic: true, quantity: true },
  })
  if (!existing) {
    return { errors: { form: ['This collection item no longer exists.'] } }
  }

  const result = CollectionItemSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }

  const catalogIdRaw = trimOrNull(result.data.catalogId)
  const brandRaw     = trimOrNull(result.data.brand)
  const nameRaw      = trimOrNull(result.data.name)

  if (!catalogIdRaw && !brandRaw && !nameRaw) {
    return {
      errors: { form: ['Add a catalog match, brand, or name so this collection item can be identified.'] },
    }
  }

  const enumErrors = validateEnums(result.data)
  if (Object.keys(enumErrors).length > 0) return { errors: enumErrors }

  let resolvedCatalogId: string | null = null
  if (catalogIdRaw) {
    const found = await prisma.catalogModel.findUnique({
      where: { id: catalogIdRaw },
      select: { id: true },
    })
    if (!found) {
      return { errors: { catalogId: ['Selected catalog model not found. Please refresh and try again.'] } }
    }
    resolvedCatalogId = found.id
  }

  // 35B: freeform items (no catalog link) cannot be newly published.
  const isPublic = formData.get('isPublic') === 'on' && resolvedCatalogId !== null

  // 26B §20: quantity is ledger-derived (Σ AcquisitionLot.remainingQuantity) —
  // the general edit form never mutates it directly, regardless of what was
  // submitted (the input is disabled client-side; this is the authoritative
  // server-side guarantee). Use "Add Another" / "Mark Sold / Removed" instead.
  const updateResult = await prisma.collectionItem.updateMany({
    where: { id, profileId: session.profileId, updatedAt: expectedUpdatedAt },
    data: {
      catalogId: resolvedCatalogId,
      isPublic,
      ...toDbFields(result.data),
      quantity: existing.quantity,
    },
  })

  if (updateResult.count === 0) {
    const stillExists = await prisma.collectionItem.findFirst({
      where: { id, profileId: session.profileId },
      select: { id: true },
    })
    if (stillExists) {
      return { errors: { form: ['This collection item was changed elsewhere. Refresh and try again.'] } }
    }
    return { errors: { form: ['This collection item no longer exists.'] } }
  }

  if (existing.isPublic || isPublic) {
    updateTag('community-leaderboards')
  }
  revalidatePath(`/account/collection/${id}`)
  revalidatePath('/account/collection')
  redirect(`/account/collection/${id}`)
}

export async function deleteCollectionItem(id: string): Promise<void> {
  const session = await getBuyerSession()
  if (!session) redirect('/account/orders')

  // Fetch the item's photos/visibility plus ledger state before deletion.
  const item = await prisma.collectionItem.findFirst({
    where: { id, profileId: session.profileId },
    select: {
      isPublic: true,
      photos: { select: { url: true } },
      acquisitionLots: { select: { id: true, quantityAcquired: true, remainingQuantity: true } },
      disposals: { select: { id: true } },
    },
  })
  if (!item) redirect('/account/collection')

  // 26B §28: once any lot has ever participated in an allocation, or any
  // disposal (even reversed) exists, ordinary hard-delete is blocked — the
  // ledger's historical facts must never be destroyed. Direct ownership
  // reduction through "Mark Sold / Removed" instead. A genuinely mistaken
  // entry (no allocation/disposal history at all) may still be deleted —
  // its lots are removed in the same transaction as the CollectionItem.
  const hasDisposalHistory = item.disposals.length > 0
  const hasAllocatedLot = item.acquisitionLots.some((lot) => lot.remainingQuantity !== lot.quantityAcquired)
  if (hasDisposalHistory || hasAllocatedLot) {
    redirect(`/account/collection/${id}?deleteBlocked=1`)
  }

  // Delete lots (mistaken-entry only, none ever allocated) + the item
  // atomically — cascade removes CollectionItemPhoto rows from DB.
  const deleteResult = await prisma.$transaction(async (tx) => {
    await tx.acquisitionLot.deleteMany({ where: { collectionItemId: id } })
    return tx.collectionItem.deleteMany({ where: { id, profileId: session.profileId } })
  })

  if (deleteResult.count === 0) {
    // Race: item was already deleted by another request
    redirect('/account/collection')
  }

  if (item.isPublic) updateTag('community-leaderboards')

  // Best-effort blob cleanup after DB deletion
  for (const photo of item.photos) {
    try {
      await del(photo.url)
    } catch (err) {
      console.error(
        '[deleteCollectionItem] Failed to delete blob:',
        err instanceof Error ? err.message : 'UnknownError'
      )
    }
  }

  redirect('/account/collection')
}
