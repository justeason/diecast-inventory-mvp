'use server'

import { z } from 'zod'
import { redirect } from 'next/navigation'
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

// ─── Order status management ────────────────────────────────────────────────

const VALID_ORDER_STATUSES = ['pending', 'paid', 'picking', 'shipped', 'complete', 'cancelled']

export type OrderStatusActionState =
  | { errors: Record<string, string[]> }
  | null

export async function updateOrderStatus(
  id: string,
  _prev: OrderStatusActionState,
  formData: FormData
): Promise<OrderStatusActionState> {
  const status = formData.get('status') as string

  if (!VALID_ORDER_STATUSES.includes(status)) {
    return { errors: { form: ['Invalid status value.'] } }
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      orderItems: { select: { itemId: true, listingId: true } },
    },
  })

  if (!order) {
    return { errors: { form: ['Order not found.'] } }
  }

  // Collect the exact IDs from this order's OrderItem rows.
  // Never update by catalogId — each ItemInstance is a unique physical item.
  const itemIds = order.orderItems.map((oi) => oi.itemId)
  const listingIds = order.orderItems.map((oi) => oi.listingId)

  if (status === 'cancelled') {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { status: 'cancelled' } })
      // Only update items currently reserved — guards against double-effects and
      // avoids touching items that may have already moved to another status.
      await tx.itemInstance.updateMany({
        where: { id: { in: itemIds }, status: 'reserved' },
        data: { status: 'available' },
      })
      // Listings remain active so items can be re-listed if the order is cancelled.
    })
  } else if (status === 'complete') {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { status: 'complete' } })
      // Only update items currently reserved and listings currently active —
      // status guards prevent double-effects and scope writes to exact IDs only.
      await tx.itemInstance.updateMany({
        where: { id: { in: itemIds }, status: 'reserved' },
        data: { status: 'sold' },
      })
      await tx.listing.updateMany({
        where: { id: { in: listingIds }, status: 'active' },
        data: { status: 'sold' },
      })
    })
  } else {
    // paid | picking | shipped — only Order.status changes, no item or listing side effects.
    await prisma.order.update({ where: { id }, data: { status } })
  }

  redirect(`/admin/orders/${id}`)
}
