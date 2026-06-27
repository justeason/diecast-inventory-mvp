'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

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

  await prisma.listing.create({
    data: {
      itemId,
      title,
      price: Number(price),
      description: description || undefined,
      status: 'active',
    },
  })

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

  if (status === 'sold') {
    const existing = await prisma.listing.findUnique({
      where: { id },
      select: { itemId: true },
    })
    if (existing) {
      await prisma.$transaction(async (tx) => {
        await tx.listing.update({
          where: { id },
          data: { title, price: Number(price), description: description || undefined, status },
        })
        await tx.itemInstance.update({
          where: { id: existing.itemId },
          data: { status: 'sold' },
        })
      })
    }
  } else {
    await prisma.listing.update({
      where: { id },
      data: { title, price: Number(price), description: description || undefined, status },
    })
  }

  redirect('/admin/listings')
}
