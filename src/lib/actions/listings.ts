'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { createAvailableFanoutJob, createPriceChangeFanoutJob } from '@/lib/buyerAlertsTrigger'
import { processFanoutJobs } from '@/lib/buyerAlertsFanoutProcessor'

// Best-effort immediate processing after a fan-out job is durably committed. Never
// lets a processing failure affect the admin action — the cron and admin "process
// next batch" button are the durability backstop, not this call.
async function processFanoutBestEffort(): Promise<void> {
  try {
    await processFanoutJobs()
  } catch {
    // swallowed intentionally — the durable BuyerAlertFanout row already exists
  }
}

const isValidPositivePrice = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0
}

const CreateListingSchema = z.object({
  itemId: z.string().min(1, 'Item is required'),
  title: z.string().min(1, 'Title is required'),
  price: z.string().min(1, 'Price is required')
    .refine(isValidPositivePrice, 'Price must be a valid number greater than 0'),
  description: z.string().optional(),
})

const UpdateListingSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  price: z.string().min(1, 'Price is required')
    .refine(isValidPositivePrice, 'Price must be a valid number greater than 0'),
  description: z.string().optional(),
  status: z.enum(['active', 'sold', 'archived'], { error: 'Status is required' }),
})

export type ListingActionState = { errors: Record<string, string[]> } | null

export async function createListing(
  _prev: ListingActionState,
  formData: FormData
): Promise<ListingActionState> {
  const result = CreateListingSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { itemId, title, price, description } = result.data

  const item = await prisma.itemInstance.findUnique({
    where: { id: itemId },
    include: { listing: { select: { id: true } } },
  })

  if (!item) return { errors: { itemId: ['Item not found.'] } }
  if (item.status !== 'available') return { errors: { itemId: ['Item is not available for listing.'] } }
  if (item.listing) return { errors: { itemId: ['Item already has a listing.'] } }

  // The listing mutation and the durable fan-out job commit atomically — a crash
  // right after this transaction can never lose the intent to notify wanted buyers.
  await prisma.$transaction(async (tx) => {
    const listing = await tx.listing.create({
      data: {
        itemId,
        title,
        price: Number(price),
        description: description || undefined,
        status: 'active',
      },
    })
    await createAvailableFanoutJob(tx, item.catalogId, listing.id, listing.version)
  })

  await processFanoutBestEffort()

  redirect('/admin/listings')
}

export async function updateListing(
  id: string,
  _prev: ListingActionState,
  formData: FormData
): Promise<ListingActionState> {
  const result = UpdateListingSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { title, price, description, status } = result.data

  // Authoritative pre-update snapshot — never infer old price from alert history.
  const before = await prisma.listing.findUnique({
    where: { id },
    select: { itemId: true, price: true, status: true, item: { select: { catalogId: true, status: true } } },
  })

  if (status === 'sold') {
    if (before) {
      await prisma.$transaction(async (tx) => {
        await tx.listing.update({
          where: { id },
          data: { title, price: Number(price), description: description || undefined, status, version: { increment: 1 } },
        })
        await tx.itemInstance.update({
          where: { id: before.itemId },
          data: { status: 'sold' },
        })
      })
    }
  } else {
    // The listing mutation and the durable fan-out job (if any transition qualifies)
    // commit atomically. Alerts fire only when the item itself is available (a listing
    // can be 'active' while its item is 'reserved' during checkout).
    await prisma.$transaction(async (tx) => {
      const updated = await tx.listing.update({
        where: { id },
        data: { title, price: Number(price), description: description || undefined, status, version: { increment: 1 } },
      })

      if (before && before.item.status === 'available') {
        const becameActive = before.status !== 'active' && updated.status === 'active'
        const staysActive   = before.status === 'active' && updated.status === 'active'

        if (becameActive) {
          await createAvailableFanoutJob(tx, before.item.catalogId, updated.id, updated.version)
        } else if (staysActive && before.price !== updated.price) {
          await createPriceChangeFanoutJob(tx, before.item.catalogId, updated.id, before.price, updated.price, updated.version)
        }
      }
    })

    await processFanoutBestEffort()
  }

  redirect('/admin/listings')
}
