'use server'

import { z } from 'zod'
import { del } from '@vercel/blob'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

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
  return !isNaN(n) && n >= 1
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

  const item = await prisma.collectionItem.create({
    data: {
      profileId: session.profileId,
      catalogId: resolvedCatalogId ?? undefined,
      ...toDbFields(result.data),
    },
  })

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

  const existing = await prisma.collectionItem.findFirst({
    where: { id, profileId: session.profileId },
    select: { id: true },
  })
  if (!existing) {
    return { errors: { form: ['Collection item not found.'] } }
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

  await prisma.collectionItem.update({
    where: { id },
    data: {
      catalogId: resolvedCatalogId,
      ...toDbFields(result.data),
    },
  })

  revalidatePath(`/account/collection/${id}`)
  revalidatePath('/account/collection')
  redirect(`/account/collection/${id}`)
}

export async function deleteCollectionItem(id: string): Promise<void> {
  const session = await getBuyerSession()
  if (!session) redirect('/account/orders')

  // Fetch the item's photos before deletion so we can clean up blobs afterward
  const item = await prisma.collectionItem.findFirst({
    where: { id, profileId: session.profileId },
    select: { photos: { select: { url: true } } },
  })
  if (!item) redirect('/account/collection')

  // Delete the item — cascade removes CollectionItemPhoto rows from DB
  await prisma.collectionItem.deleteMany({
    where: { id, profileId: session.profileId },
  })

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
