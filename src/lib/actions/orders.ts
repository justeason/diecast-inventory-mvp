'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'

const OrderSchema = z.object({
  buyerName: z.string().min(1, 'Name is required'),
  buyerEmail: z.string().email('Valid email is required'),
  buyerPhone: z.string().optional(),
  notes: z.string().optional(),
})

export type OrderActionState =
  | { success: true }
  | { errors: Record<string, string[]> }
  | null

export async function createOrder(
  _prev: OrderActionState,
  formData: FormData
): Promise<OrderActionState> {
  const listingIds = formData.getAll('listingIds') as string[]
  if (!listingIds.length) {
    return { errors: { form: ['Your cart is empty.'] } }
  }

  const raw = {
    buyerName: formData.get('buyerName') as string,
    buyerEmail: formData.get('buyerEmail') as string,
    buyerPhone: (formData.get('buyerPhone') as string) || undefined,
    notes: (formData.get('notes') as string) || undefined,
  }

  const result = OrderSchema.safeParse(raw)
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }

  const listings = await prisma.listing.findMany({
    where: {
      id: { in: listingIds },
      status: 'active',
      item: { status: 'available' },
    },
  })

  if (listings.length !== listingIds.length) {
    return {
      errors: {
        form: ['One or more items are no longer available. Please review your cart and try again.'],
      },
    }
  }

  const { buyerName, buyerEmail, buyerPhone, notes } = result.data

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        buyerName,
        buyerEmail,
        buyerPhone: buyerPhone ?? null,
        notes: notes ?? null,
        status: 'pending',
      },
    })

    for (const listing of listings) {
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          itemId: listing.itemId,
          listingId: listing.id,
          price: listing.price,
        },
      })

      // Use listing.itemId (the FK stored directly on the Listing row) — not catalogId and not a
      // relation-derived id — because each physical ItemInstance is unique even when multiple items
      // share the same CatalogModel. Relation includes can resolve ambiguously in Prisma 5 + SQLite
      // when the same relation appears in both the where filter and the include.
      await tx.itemInstance.update({
        where: { id: listing.itemId },
        data: { status: 'reserved' },
      })
      // Listing.status intentionally stays 'active'; ItemInstance.status = 'reserved' is the hold signal.
      // Browse filters out reserved items via the item.status = 'available' check.
    }
  })

  return { success: true }
}
