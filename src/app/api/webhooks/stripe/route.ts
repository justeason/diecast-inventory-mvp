// PRODUCTION WEBHOOK URL: https://www.collectntrades.com/api/webhooks/stripe
// Use the www subdomain when registering in the Stripe Dashboard.
// The non-www domain (collectntrades.com) redirects with HTTP 308, which Stripe
// does not follow — webhook delivery will fail silently if registered without www.

import type Stripe from 'stripe'
import { getStripe } from '@/lib/stripe'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  // Read raw body first — Stripe signature verification requires the original bytes
  const rawBody = await request.text()
  const sig = request.headers.get('stripe-signature') ?? ''

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe/webhook] STRIPE_WEBHOOK_SECRET is not set')
    return Response.json({ error: 'Webhook secret not configured' }, { status: 500 })
  }

  let event: Stripe.Event
  try {
    const stripe = getStripe()
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch {
    return Response.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const session = event.data.object as Stripe.Checkout.Session
  const orderId = session.metadata?.orderId ?? null

  // Ignore sessions not created by this app
  if (!orderId) return Response.json({ ok: true })

  if (event.type === 'checkout.session.completed') {
    await handleSessionCompleted(session, orderId)
  } else if (event.type === 'checkout.session.expired') {
    await handleSessionExpired(session, orderId)
  }

  return Response.json({ ok: true })
}

// ─── Payment confirmed ────────────────────────────────────────────────────────

async function handleSessionCompleted(
  session: Stripe.Checkout.Session,
  orderId: string
): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, stripeSessionId: session.id },
    select: { id: true, status: true, paymentStatus: true },
  })

  // Idempotency: already processed or order not found
  if (!order || order.paymentStatus === 'paid') return

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : null

  await prisma.order.update({
    where: { id: orderId },
    data: {
      paymentStatus:         'paid',
      paidAt:                new Date(),
      paymentMethod:         'stripe',
      paymentReference:      paymentIntentId,
      stripePaymentIntentId: paymentIntentId,
      stripeSessionId:       null,
      stripeSessionExpiresAt: null,
      // Only advance from pending → paid; never revert picking/shipped/complete/cancelled
      ...(order.status === 'pending' ? { status: 'paid' } : {}),
    },
  })
}

// ─── Session expired ──────────────────────────────────────────────────────────

async function handleSessionExpired(
  session: Stripe.Checkout.Session,
  orderId: string
): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, stripeSessionId: session.id },
    select: { id: true, paymentStatus: true, paymentMethod: true },
  })

  // Already paid or not found — nothing to clear
  if (!order || order.paymentStatus === 'paid') return

  await prisma.order.update({
    where: { id: orderId },
    data: {
      stripeSessionId:        null,
      stripeSessionExpiresAt: null,
      paymentStatus:          'unpaid',
      paymentLink:            null,
      // Only clear paymentMethod if it was set to stripe by us
      ...(order.paymentMethod === 'stripe' ? { paymentMethod: null, paymentRequestedAt: null } : {}),
    },
  })
}
