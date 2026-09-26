'use server'

import { z } from 'zod'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { normalizeEmail } from '@/lib/normalizeEmail'
import { ensureConsignmentPayoutLinesForCompletedOrder } from '@/lib/actions/sellerPayouts'
import { reconcileCollectionDisposalsForCompletedOrder } from '@/lib/collectionDisposalReconciliation'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import { computeInitialReservationExpiry } from '@/lib/orderReservation'
import { getBuyerSession } from '@/lib/buyerSession'

const OrderSchema = z.object({
  buyerName: z.string().min(1, 'Name is required'),
  buyerEmail: z.string().email('Valid email is required'),
  buyerPhone: z.string().optional(),
  notes: z.string().optional(),
})

export type OrderActionState =
  | { success: true; orderId: string }
  | { errors: Record<string, string[]> }
  | null

// Checkout reservation hotfix: internal control-flow signal only — thrown
// inside the transaction when a conditional reservation loses the
// available->reserved race, caught outside $transaction to translate into the
// existing honest "no longer available" checkout error. Never exposed to the
// caller as a raw error.
class ListingUnavailableError extends Error {}

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
    include: {
      // 21B: read once here, snapshotted onto the new OrderItem at creation below —
      // the authoritative source for the immutable sale-time facts.
      item: {
        select: {
          catalogId: true,
          marketVariantId: true,
          cardedOrLoose: true,
          condition: true,
          // 39B: durable consignor identity chain for the self-trade check below —
          // ItemInstance -> SellerAgreement -> SellerProfile -> CustomerProfile.id.
          // NEVER the buyer's typed checkout email. Company-owned inventory
          // (sellerAgreement null, or sellerAgreement.sellerProfile null) has no
          // determinable consignor and stays purchasable by design.
          sellerAgreement: { select: { sellerProfile: { select: { profileId: true } } } },
        },
      },
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

  // Find or create CustomerProfile — non-blocking, order proceeds even if upsert fails
  let profileId: string | null = null
  try {
    const normalizedEmail = normalizeEmail(buyerEmail)
    const profile = await prisma.customerProfile.upsert({
      where:  { email: normalizedEmail },
      update: { name: buyerName, phone: buyerPhone ?? null },
      create: { email: normalizedEmail, name: buyerName, phone: buyerPhone ?? null },
      select: { id: true },
    })
    profileId = profile.id
  } catch (err) {
    console.error('[createOrder] customerProfile upsert failed:', err instanceof Error ? err.name : 'UnknownError')
  }

  // 39B (corrected): self-trade hard block — uses ONLY the cryptographically
  // verified buyer session (getBuyerSession(), backed by CustomerSession —
  // established exclusively via a consumed magic-link token or a correct
  // password, never from a client-typed value read at request time). The
  // email-upserted `profileId` above is NOT proof of identity — a guest can
  // type ANY email, including a real consignor's, and the upsert would
  // resolve to that same CustomerProfile.id without ever proving the typed
  // email belongs to the person submitting this request. That profileId is
  // used only for the Order.customerProfileId lookup convenience field below,
  // never for this security decision.
  //
  // KNOWN LIMITATION (reported, not silently worked around): a guest checkout
  // with no verified session cannot have self-trade reliably prevented —
  // there is no durable, non-spoofable identity signal available for an
  // unauthenticated request. Only a logged-in buyer's session is checked here.
  const verifiedBuyerSession = await getBuyerSession()
  if (verifiedBuyerSession) {
    const selfTrade = listings.some(
      (listing) => listing.item.sellerAgreement?.sellerProfile?.profileId === verifiedBuyerSession.profileId,
    )
    if (selfTrade) {
      return {
        errors: {
          form: ['You cannot purchase an item you consigned. Please remove it from your cart and try again.'],
        },
      }
    }
  }

  let orderId: string
  try {
    const txResult = await prisma.$transaction(async (tx) => {
      // Checkout reservation hotfix (28A follow-up): the findMany availability
      // check above is a pre-filter only — under concurrent requests two
      // transactions can both read 'available' before either commits. The
      // conditional updateMany below (available -> reserved, count===1) is the
      // ONLY real concurrency guard, so every reservation is acquired FIRST,
      // before any persistent Order/OrderItem row exists — a losing
      // reservation throws immediately and rolls back the whole transaction
      // with nothing partially written (no Order, no OrderItem, no other
      // item's reservation left behind).
      //
      // Use listing.itemId (the FK stored directly on the Listing row) — not catalogId and not a
      // relation-derived id — because each physical ItemInstance is unique even when multiple items
      // share the same CatalogModel. Relation includes can resolve ambiguously in Prisma 5 + SQLite
      // when the same relation appears in both the where filter and the include.
      for (const listing of listings) {
        const reserved = await tx.itemInstance.updateMany({
          where: { id: listing.itemId, status: 'available' },
          data: { status: 'reserved' },
        })
        if (reserved.count !== 1) {
          throw new ListingUnavailableError()
        }
      }
      // Listing.status intentionally stays 'active'; ItemInstance.status = 'reserved' is the hold signal.
      // Browse filters out reserved items via the item.status = 'available' check.

      const order = await tx.order.create({
        data: {
          buyerName,
          buyerEmail,
          buyerPhone: buyerPhone ?? null,
          notes: notes ?? null,
          status: 'pending',
          customerProfileId: profileId,
          // 39B: protects the pre-Stripe-session interval (cart submitted, no
          // payment link generated yet). Extended to the Stripe session's own
          // expires_at once createAndSendStripeCheckoutSession runs.
          reservationExpiresAt: computeInitialReservationExpiry(),
        },
      })

      for (const listing of listings) {
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            itemId: listing.itemId,
            listingId: listing.id,
            price: listing.price,
            // 21B: mutable identity pointers + immutable sale-time snapshot, both
            // copied from the authoritative ItemInstance in this same creation flow.
            catalogModelId: listing.item.catalogId,
            marketVariantId: listing.item.marketVariantId,
            snapshotPackagingType: listing.item.cardedOrLoose,
            snapshotCondition: listing.item.condition,
            // 21C: every NEW OrderItem is captured live from the authoritative
            // ItemInstance — never caller-supplied, never anything but 'sale_time'.
            snapshotProvenance: 'sale_time',
          },
        })
      }

      return { orderId: order.id }
    })
    orderId = txResult.orderId
  } catch (err) {
    if (err instanceof ListingUnavailableError) {
      return {
        errors: {
          form: ['One or more items are no longer available. Please review your cart and try again.'],
        },
      }
    }
    throw err
  }

  return { success: true, orderId }
}

// ─── Order review fields ─────────────────────────────────────────────────────

export type OrderReviewActionState =
  | { success: true }
  | { errors: Record<string, string[]> }
  | null

export async function updateOrderReviewFields(
  id: string,
  _prev: OrderReviewActionState,
  formData: FormData
): Promise<OrderReviewActionState> {
  const rawShipping = (formData.get('estimatedShipping') as string).trim()
  const adminNotes = (formData.get('adminNotes') as string).trim() || null
  const followUpNotes = (formData.get('followUpNotes') as string).trim() || null

  let estimatedShipping: number | null = null
  if (rawShipping !== '') {
    const parsed = parseFloat(rawShipping)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { errors: { estimatedShipping: ['Enter a valid non-negative amount.'] } }
    }
    estimatedShipping = parsed
  }

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true } })
  if (!order) return { errors: { form: ['Order not found.'] } }

  await prisma.order.update({
    where: { id },
    data: { estimatedShipping, adminNotes, followUpNotes },
  })

  redirect(`/admin/orders/${id}`)
}

// ─── Order payment fields ─────────────────────────────────────────────────────

const VALID_PAYMENT_STATUSES = ['unpaid', 'requested', 'paid'] as const

export type OrderPaymentActionState =
  | { success: true }
  | { errors: Record<string, string[]> }
  | null

export async function updateOrderPayment(
  id: string,
  _prev: OrderPaymentActionState,
  formData: FormData
): Promise<OrderPaymentActionState> {
  const paymentStatus = (formData.get('paymentStatus') as string).trim()
  if (!VALID_PAYMENT_STATUSES.includes(paymentStatus as typeof VALID_PAYMENT_STATUSES[number])) {
    return { errors: { paymentStatus: ['Invalid payment status.'] } }
  }

  const paymentMethod    = (formData.get('paymentMethod')    as string).trim() || null
  const paymentReference = (formData.get('paymentReference') as string).trim() || null
  const paymentLink      = (formData.get('paymentLink')      as string).trim() || null

  const rawRequestedAt = (formData.get('paymentRequestedAt') as string).trim()
  const rawPaidAt      = (formData.get('paidAt')             as string).trim()

  let paymentRequestedAt: Date | null = null
  if (rawRequestedAt) {
    const d = new Date(rawRequestedAt)
    if (isNaN(d.getTime())) return { errors: { paymentRequestedAt: ['Invalid date.'] } }
    paymentRequestedAt = d
  }

  let paidAt: Date | null = null
  if (rawPaidAt) {
    const d = new Date(rawPaidAt)
    if (isNaN(d.getTime())) return { errors: { paidAt: ['Invalid date.'] } }
    paidAt = d
  }

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true } })
  if (!order) return { errors: { form: ['Order not found.'] } }

  await prisma.order.update({
    where: { id },
    data: { paymentStatus, paymentMethod, paymentReference, paymentLink, paymentRequestedAt, paidAt },
  })

  redirect(`/admin/orders/${id}`)
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
    select: {
      status: true,
      paymentStatus: true,
      stripeSessionId: true,
      completedAt: true,
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
    // 39B: a paid or completed order must never have its stock silently
    // returned to sale via a bare status change — this schema has no
    // refund/reversal process, so cancellation of a paid order is rejected
    // outright rather than faked. Before this guard, ANY order (including
    // paid/complete) could transition to 'cancelled' and release its items.
    if (order.paymentStatus === 'paid' || order.status === 'complete') {
      return {
        errors: {
          form: [
            'This order has already been paid or completed and cannot be cancelled here. A paid order requires a refund process (not currently supported) before its items can be released.',
          ],
        },
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          status: 'cancelled',
          // Follow-up fix: previously left set after cancellation, which let a
          // stale/replaced Stripe session still id+stripeSessionId-match this
          // (now-cancelled, released) Order in the webhook — a late payment on
          // that stale session could otherwise appear to target a live order.
          stripeSessionId: null,
          stripeSessionExpiresAt: null,
          reservationExpiresAt: null,
          paymentLink: null,
        },
      })
      // Only update items currently reserved — guards against double-effects and
      // avoids touching items that may have already moved to another status.
      await tx.itemInstance.updateMany({
        where: { id: { in: itemIds }, status: 'reserved' },
        data: { status: 'available' },
      })
      // Listings remain active so items can be re-listed if the order is cancelled.
    })

    // After DB transaction: expire any active Stripe session (fire-and-forget)
    if (order.stripeSessionId) {
      try {
        const stripe = getStripe()
        await stripe.checkout.sessions.expire(order.stripeSessionId)
      } catch {
        // Session may already be expired or key not configured — not a blocking failure
      }
    }
  } else if (status === 'complete') {
    // Set completedAt only on first transition to complete
    const completedAt = order.completedAt ?? new Date()

    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { status: 'complete', completedAt } })
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

    // Non-blocking: generate consignment payout lines after order completion.
    // Failure here does NOT roll back order completion — buyer lifecycle is primary.
    try {
      const result = await ensureConsignmentPayoutLinesForCompletedOrder(id)
      if (result.created > 0) {
        revalidatePath('/admin/seller-payouts')
        revalidatePath('/account/sell')
      }
    } catch (err) {
      console.error('[updateOrderStatus] Consignment payout line generation failed for order', id, ':', err instanceof Error ? err.message : 'UnknownError')
      // Order remains complete. Admin can use the reconciliation tool on the order detail page.
    }

    // Non-blocking: reconcile the seller's private Collection ownership —
    // must run AFTER payout-line generation above, since it reads the
    // resulting SellerPayoutLine.netAmount for Recorded Realized Gain/Loss.
    // Idempotent (sourceKey), so a retry here never double-decrements.
    try {
      await reconcileCollectionDisposalsForCompletedOrder(id)
    } catch (err) {
      console.error('[updateOrderStatus] Collection disposal reconciliation failed for order', id, ':', err instanceof Error ? err.message : 'UnknownError')
    }

    // Non-blocking: lifecycle events for each seller submission linked to this order.
    try {
      const sellerItems = await prisma.orderItem.findMany({
        where: { orderId: id, item: { sellerAgreement: { isNot: null } } },
        select: { item: { select: { sellerAgreement: { select: { submissionId: true } } } } },
      })
      const submissionIds = [
        ...new Set(
          sellerItems
            .map((oi) => oi.item.sellerAgreement?.submissionId)
            .filter((s): s is string => !!s),
        ),
      ]
      for (const sid of submissionIds) {
        await ensureSellerLifecycleEvent({
          eventKey: `order-completed:${id}:${sid}`,
          sellerSubmissionId: sid,
          eventType: 'order_completed',
          sourceEntityType: 'order',
          sourceEntityId: id,
          sellerVisible: true,
          sellerTitle: 'Sale completed',
          sellerDescription: 'The sale of your item was completed.',
          occurredAt: completedAt,
        })
        revalidatePath(`/account/sell/${sid}`)
      }
    } catch (err) {
      console.error('[updateOrderStatus] lifecycle event generation failed for order', id, ':', err instanceof Error ? err.message : 'UnknownError')
    }
  } else {
    // paid | picking | shipped — only Order.status changes, no item or listing side effects.
    await prisma.order.update({ where: { id }, data: { status } })
  }

  redirect(`/admin/orders/${id}`)
}
