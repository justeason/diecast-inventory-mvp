'use server'

import type Stripe from 'stripe'
import { redirect } from 'next/navigation'
import { Resend } from 'resend'
import { getStripe } from '@/lib/stripe'
import { prisma } from '@/lib/prisma'
import { buildPaymentLinkEmail } from '@/lib/email/paymentLinkEmail'

export type StripeActionState =
  | { success: true }
  | { errors: Record<string, string[]> }
  | null

// Stripe requires expires_at to be less than 24 hours from session creation.
const STRIPE_CHECKOUT_EXPIRY_HOURS = 23

// ─── Create Checkout Session + send buyer email ───────────────────────────────

export async function createAndSendStripeCheckoutSession(
  orderId: string,
  _prev: StripeActionState,
  _formData: FormData
): Promise<StripeActionState> {
  // 1. Fetch order
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      buyerName: true,
      buyerEmail: true,
      status: true,
      paymentStatus: true,
      estimatedShipping: true,
      stripeSessionId: true,
      orderItems: {
        select: {
          price: true,
          listing: { select: { title: true } },
        },
      },
    },
  })

  if (!order) {
    return { errors: { form: ['Order not found.'] } }
  }

  // 2. Guards
  if (order.status === 'complete' || order.status === 'cancelled') {
    return { errors: { form: ['Cannot send a payment link for a completed or cancelled order.'] } }
  }
  if (order.paymentStatus === 'paid') {
    return { errors: { form: ['This order is already paid.'] } }
  }
  if (order.stripeSessionId !== null) {
    return { errors: { form: ['A payment link already exists. Expire it before generating a new one.'] } }
  }
  if (order.estimatedShipping === null) {
    return { errors: { form: ['Enter estimated shipping before generating a payment link. Use 0 for free shipping.'] } }
  }

  // 3. Env var checks
  for (const v of ['STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'ORDER_DIGEST_FROM_EMAIL', 'APP_URL']) {
    if (!process.env[v]) {
      return { errors: { form: [`Server configuration error: ${v} is not set.`] } }
    }
  }

  const stripe = getStripe()

  // 4. Calculate amounts server-side — never trust client input
  const subtotal = order.orderItems.reduce((sum, oi) => sum + oi.price, 0)
  const shipping = order.estimatedShipping // non-null after guard
  const total    = subtotal + shipping
  const subtotalCents  = Math.round(subtotal * 100)
  const shippingCents  = Math.round(shipping * 100)
  const appUrl = process.env.APP_URL!.replace(/\/$/, '')

  // 5. Pre-flight log — safe values only, no secrets
  console.log('[stripe] pre-flight', {
    orderId: order.id,
    itemCount: order.orderItems.length,
    subtotal,
    estimatedShipping: shipping,
    total,
    subtotalCents,
    shippingCents,
    hasStripeKey: Boolean(process.env.STRIPE_SECRET_KEY),
    hasAppUrl:    Boolean(process.env.APP_URL),
    appUrl,
    successUrl: `${appUrl}/order-confirmation/${order.id}?payment=success`,
  })

  // 6. Amount validation — Stripe requires positive integers in cents
  if (subtotal <= 0) {
    return { errors: { form: ['Order subtotal must be greater than zero.'] } }
  }
  if (total <= 0) {
    return { errors: { form: ['Order total must be greater than zero.'] } }
  }
  if (subtotalCents <= 0 || !Number.isInteger(subtotalCents)) {
    return { errors: { form: [`Invalid subtotal amount: ${subtotal}. Must be a positive value with at most 2 decimal places.`] } }
  }
  if (shipping > 0 && (shippingCents <= 0 || !Number.isInteger(shippingCents))) {
    return { errors: { form: [`Invalid shipping amount: ${shipping}. Must be a positive value with at most 2 decimal places.`] } }
  }

  const totalCents = subtotalCents + (shipping > 0 ? shippingCents : 0)
  if (totalCents < 50) {
    return { errors: { form: ['Stripe requires the total payment amount to be at least $0.50.'] } }
  }

  const expiresAt = Math.floor(Date.now() / 1000) + STRIPE_CHECKOUT_EXPIRY_HOURS * 60 * 60

  // 7. Build line items
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Order – ${order.orderItems.length} item${order.orderItems.length !== 1 ? 's' : ''}`,
          description:
            order.orderItems
              .slice(0, 3)
              .map((oi) => oi.listing.title)
              .join(', ') + (order.orderItems.length > 3 ? ` +${order.orderItems.length - 3} more` : ''),
        },
        unit_amount: subtotalCents,
      },
      quantity: 1,
    },
  ]

  if (shipping > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'Estimated Shipping' },
        unit_amount: shippingCents,
      },
      quantity: 1,
    })
  }

  // 8. Create Stripe Checkout Session
  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: order.buyerEmail,
      line_items: lineItems,
      metadata: { orderId: order.id },
      success_url: `${appUrl}/order-confirmation/${order.id}?payment=success`,
      cancel_url: `${appUrl}/order-status`,
      expires_at: expiresAt,
    })
    console.log('[stripe] session created:', session.id)
  } catch (err) {
    const name    = err instanceof Error ? err.name    : 'UnknownError'
    const type    = (err as Record<string, unknown>).type    as string | undefined
    const code    = (err as Record<string, unknown>).code    as string | undefined
    const message = (err as Record<string, unknown>).message as string | undefined
    console.error('[stripe] session create error:', { name, type, code, message })
    return { errors: { form: ['Failed to create Stripe Checkout Session. Please try again.'] } }
  }

  // 7. Save session to DB
  try {
    await prisma.order.update({
      where: { id: order.id },
      data: {
        stripeSessionId:        session.id,
        stripeSessionExpiresAt: new Date(expiresAt * 1000),
        paymentLink:            session.url,
        paymentStatus:          'requested',
        paymentRequestedAt:     new Date(),
        paymentMethod:          'stripe',
      },
    })
  } catch (err) {
    // DB write failed — expire the session so it's not orphaned in Stripe
    const name = err instanceof Error ? err.name : 'UnknownError'
    console.error('[stripe] DB update error after session create:', name)
    try {
      await stripe.checkout.sessions.expire(session.id)
    } catch {
      // best-effort
    }
    return { errors: { form: ['Failed to save payment session. Please try again.'] } }
  }

  // 8. Send buyer email (fire-and-forget on failure — session already saved)
  try {
    const resend = new Resend(process.env.RESEND_API_KEY)
    const { subject, html, text } = buildPaymentLinkEmail(
      { ...order, estimatedShipping: shipping },
      session.url!,
      appUrl
    )
    const { error } = await resend.emails.send({
      from: process.env.ORDER_DIGEST_FROM_EMAIL!,
      to:   order.buyerEmail,
      subject,
      html,
      text,
    })
    if (error) {
      console.error('[stripe] Resend error sending payment link email:', error.name)
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError'
    console.error('[stripe] Unexpected email error:', name)
  }

  redirect(`/admin/orders/${orderId}`)
}

// ─── Resend buyer payment email (no new session created) ─────────────────────

export async function resendStripePaymentEmail(
  orderId: string,
  _prev: StripeActionState,
  _formData: FormData
): Promise<StripeActionState> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      buyerName: true,
      buyerEmail: true,
      estimatedShipping: true,
      paymentStatus: true,
      paymentLink: true,
      stripeSessionId: true,
      stripeSessionExpiresAt: true,
      orderItems: {
        select: {
          price: true,
          listing: { select: { title: true } },
        },
      },
    },
  })

  if (!order) {
    return { errors: { form: ['Order not found.'] } }
  }
  if (!order.stripeSessionId || !order.paymentLink) {
    return { errors: { form: ['No active payment session. Generate a new payment link first.'] } }
  }
  if (order.paymentStatus === 'paid') {
    return { errors: { form: ['This order is already paid.'] } }
  }
  if (order.estimatedShipping === null) {
    return { errors: { form: ['Order is missing a shipping amount.'] } }
  }
  // Do not resend an expired link — admin should expire and regenerate instead
  if (order.stripeSessionExpiresAt && order.stripeSessionExpiresAt < new Date()) {
    return { errors: { form: ['This payment link has expired. Please expire it and generate a new one.'] } }
  }

  for (const v of ['RESEND_API_KEY', 'ORDER_DIGEST_FROM_EMAIL', 'APP_URL']) {
    if (!process.env[v]) {
      return { errors: { form: [`Server configuration error: ${v} is not set.`] } }
    }
  }

  const appUrl = process.env.APP_URL!.replace(/\/$/, '')

  try {
    const resend = new Resend(process.env.RESEND_API_KEY)
    const { subject, html, text } = buildPaymentLinkEmail(
      { ...order, estimatedShipping: order.estimatedShipping },
      order.paymentLink,
      appUrl
    )
    const { error } = await resend.emails.send({
      from: process.env.ORDER_DIGEST_FROM_EMAIL!,
      to:   order.buyerEmail,
      subject,
      html,
      text,
    })
    if (error) {
      console.error('[stripe] Resend error resending payment email:', error.name)
      return { errors: { form: ['Failed to send email. Copy the payment link above and send it manually.'] } }
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError'
    console.error('[stripe] Unexpected error resending payment email:', name)
    return { errors: { form: ['Unexpected error. Copy the payment link above and send it manually.'] } }
  }

  return { success: true }
}

// ─── Expire active session ────────────────────────────────────────────────────

export async function expireStripeSession(
  orderId: string,
  _prev: StripeActionState,
  _formData: FormData
): Promise<StripeActionState> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, stripeSessionId: true, paymentStatus: true },
  })

  if (!order) {
    return { errors: { form: ['Order not found.'] } }
  }
  if (!order.stripeSessionId) {
    return { errors: { form: ['No active payment session to expire.'] } }
  }
  if (order.paymentStatus === 'paid') {
    return { errors: { form: ['Cannot expire a session for a paid order.'] } }
  }

  // Expire in Stripe (may already be expired — that's fine)
  try {
    const stripe = getStripe()
    await stripe.checkout.sessions.expire(order.stripeSessionId)
  } catch {
    // Session may already be expired; proceed with DB clear
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      stripeSessionId:        null,
      stripeSessionExpiresAt: null,
      paymentStatus:          'unpaid',
      paymentLink:            null,
      paymentMethod:          null,
      paymentRequestedAt:     null,
    },
  })

  redirect(`/admin/orders/${orderId}`)
}
