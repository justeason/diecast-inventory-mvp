'use server'

// 26B: customer-facing ownership-ledger actions — a new acquisition ("Add
// Another") and manual removal ("Mark Sold / Removed"). Neither blindly bumps
// CollectionItem.quantity — both go through the ledger (createAcquisitionLot/
// createDisposal), which is the sole writer of the quantity cache.
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { internalPriceToCents } from '@/lib/marketMoney'
import { createAcquisitionLot, createDisposal, type DisposalType } from '@/lib/ownershipLedger'

export type OwnershipActionState = { errors: Record<string, string[]> } | null

function isValidQuantity(v: string | undefined): boolean {
  if (!v || !v.trim()) return true
  const n = parseInt(v.trim(), 10)
  return !isNaN(n) && n >= 1 && n <= 999
}

function isValidPrice(v: string | undefined): boolean {
  if (!v || !v.trim()) return true
  const n = Number(v)
  return Number.isFinite(n) && n >= 0
}

const AddAcquisitionSchema = z.object({
  quantity: z.string().optional().refine(isValidQuantity, 'Quantity must be a whole number of 1 or more'),
  purchasePricePerItem: z.string().optional().refine(isValidPrice, 'Purchase price must be 0 or more'),
  purchaseDate: z.string().optional(),
})

// §24 of the 26B spec: "Add Another" creates a NEW AcquisitionLot — it never
// mutates an existing lot's quantityAcquired and never inherits a previous
// lot's cost/date. Source 'manual' — a customer-recorded reacquisition, same
// as the general manual-add flow.
export async function addAcquisitionLotAction(
  collectionItemId: string,
  _prev: OwnershipActionState,
  formData: FormData,
): Promise<OwnershipActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { form: ['You must be signed in.'] } }

  const item = await prisma.collectionItem.findFirst({
    where: { id: collectionItemId, profileId: session.profileId },
    select: { id: true },
  })
  if (!item) return { errors: { form: ['This collection item no longer exists.'] } }

  const result = AddAcquisitionSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const quantity = result.data.quantity?.trim() ? parseInt(result.data.quantity.trim(), 10) : 1
  const priceRaw = result.data.purchasePricePerItem?.trim()
  const unitRecordedCostCents = priceRaw ? internalPriceToCents(parseFloat(priceRaw)) : null
  const dateRaw = result.data.purchaseDate?.trim()
  const acquiredAt = dateRaw ? new Date(dateRaw) : null

  await prisma.$transaction((tx) =>
    createAcquisitionLot(tx, {
      collectionItemId,
      quantityAcquired: quantity,
      unitRecordedCostCents,
      costKnowledge: unitRecordedCostCents !== null ? 'known' : 'unknown',
      acquiredAt,
      ledgerEffectiveAt: new Date(),
      source: 'manual',
    }),
  )

  revalidatePath(`/account/collection/${collectionItemId}`)
  revalidatePath('/account/collection')
  redirect(`/account/collection/${collectionItemId}`)
}

const MANUAL_DISPOSAL_TYPES = ['external_sale', 'gift', 'trade', 'other_removal'] as const

const MarkDisposedSchema = z.object({
  disposalType: z.string(),
  quantity: z.string().optional().refine(isValidQuantity, 'Quantity must be a whole number of 1 or more'),
  netProceeds: z.string().optional().refine(isValidPrice, 'Proceeds must be 0 or more'),
  disposedAt: z.string().optional(),
  notes: z.string().optional(),
  idempotencyToken: z.string().min(1, 'Missing form token — please refresh and try again.'),
})

// §52-55: private "Mark Sold / Removed" action. Only external_sale collects
// proceeds — gift/trade/other_removal never fabricate a realized loss equal
// to cost (§54/§62). sourceKey='manual:<token>' guards against duplicate
// submission (§55) — a retried submission with the same token is a no-op.
export async function markCollectionItemDisposedAction(
  collectionItemId: string,
  _prev: OwnershipActionState,
  formData: FormData,
): Promise<OwnershipActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { form: ['You must be signed in.'] } }

  const item = await prisma.collectionItem.findFirst({
    where: { id: collectionItemId, profileId: session.profileId },
    select: { id: true },
  })
  if (!item) return { errors: { form: ['This collection item no longer exists.'] } }

  const result = MarkDisposedSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const disposalType = result.data.disposalType
  if (!(MANUAL_DISPOSAL_TYPES as readonly string[]).includes(disposalType)) {
    return { errors: { disposalType: ['Choose a valid removal reason.'] } }
  }

  const quantity = result.data.quantity?.trim() ? parseInt(result.data.quantity.trim(), 10) : 1
  const dateRaw = result.data.disposedAt?.trim()
  const disposedAt = dateRaw ? new Date(dateRaw) : new Date()
  const notes = result.data.notes?.trim() || null

  const proceedsRaw = result.data.netProceeds?.trim()
  const netProceedsCents = disposalType === 'external_sale' && proceedsRaw ? internalPriceToCents(parseFloat(proceedsRaw)) : null

  const outcome = await prisma.$transaction((tx) =>
    createDisposal(tx, {
      collectionItemId,
      quantity,
      disposalType: disposalType as DisposalType,
      disposedAt,
      grossProceedsCents: null,
      netProceedsCents,
      sourceKey: `manual:${result.data.idempotencyToken}`,
      notes,
    }),
  )

  if (outcome.status === 'insufficient_quantity') {
    return { errors: { quantity: [`You only own ${outcome.available}; cannot remove ${outcome.requested}.`] } }
  }

  revalidatePath(`/account/collection/${collectionItemId}`)
  revalidatePath('/account/collection')
  redirect(`/account/collection/${collectionItemId}`)
}
