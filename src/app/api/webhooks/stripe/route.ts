// PRODUCTION WEBHOOK URL: https://www.collectntrades.com/api/webhooks/stripe
// Use the www subdomain when registering in the Stripe Dashboard.
// The non-www domain (collectntrades.com) redirects with HTTP 308, which Stripe
// does not follow — webhook delivery will fail silently if registered without www.
//
// REQUIRED EVENT SUBSCRIPTIONS (must be configured in the Stripe Dashboard —
// registering a handler in THIS file does not, by itself, cause Stripe to
// deliver that event type; the Dashboard's endpoint configuration is the
// actual subscription list):
//   - checkout.session.completed
//   - checkout.session.expired
//   - checkout.session.async_payment_succeeded  (added — see handlePaymentSucceededEvent)
//   - checkout.session.async_payment_failed      (added — see handleAsyncPaymentFailed)
// If asynchronous payment methods are enabled on this Stripe account and the
// Dashboard endpoint is not updated to include the last two, a definitively
// failed async payment will only ever be recovered by the reservation cron's
// own PaymentIntent-inspection fallback (src/lib/orderReservation.ts), not by
// this webhook — bounded by the cron's cadence, not "automatic recovery."

import type Stripe from 'stripe'
import { getStripe } from '@/lib/stripe'
import { logger } from '@/lib/serverLogger'
import { releaseOnConfirmedNonPayment, verifyAndMarkOrderPaid } from '@/lib/orderReservation'

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

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await handlePaymentSucceededEvent(session, orderId)
  } else if (event.type === 'checkout.session.expired') {
    await handleSessionExpired(session, orderId)
  } else if (event.type === 'checkout.session.async_payment_failed') {
    await handleAsyncPaymentFailed(session, orderId)
  }

  return Response.json({ ok: true })
}

// ─── Payment confirmed ────────────────────────────────────────────────────────
// Handles BOTH checkout.session.completed (the common synchronous-payment
// case, and also the very first event an asynchronous-method session fires —
// often still unpaid at that point) AND checkout.session.async_payment_succeeded
// (fired once an asynchronous payment method's settlement later succeeds).
// Both payloads are Checkout.Session objects; both route through the exact
// SAME verified transition — never a second, weaker "mark paid" path.

async function handlePaymentSucceededEvent(
  session: Stripe.Checkout.Session,
  orderId: string
): Promise<void> {
  // verifyAndMarkOrderPaid itself re-asserts payment_status === 'paid' as its
  // one authoritative gate (only that value proves funds were received for
  // this app's positive-value orders — 'no_payment_required' is deliberately
  // excluded). This check here is just to avoid unnecessary work/logging for
  // the common "completed but still awaiting async settlement" case.
  if (session.payment_status !== 'paid') {
    logger.warn('stripe.webhook.asyncPaymentPending', { orderId, sessionId: session.id, paymentStatus: session.payment_status })
    return
  }

  await verifyAndMarkOrderPaid(orderId, {
    id: session.id,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    currency: session.currency,
    payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
  })
}

// ─── Session expired ──────────────────────────────────────────────────────────

async function handleSessionExpired(
  session: Stripe.Checkout.Session,
  orderId: string
): Promise<void> {
  const outcome = await releaseOnConfirmedNonPayment(orderId, session.id)
  if (outcome === 'released') {
    logger.info('stripe.webhook.sessionExpiredReleased', { orderId, sessionId: session.id })
  }
}

// ─── Asynchronous payment definitively failed ────────────────────────────────
// This event only fires once Stripe has confirmed the async payment method's
// attempt failed — unlike the cron's own reconciliation (which must inspect
// the PaymentIntent itself to distinguish "still pending" from "failed"
// because the session alone is ambiguous), this event IS that confirmation,
// so no further inspection is needed here.

async function handleAsyncPaymentFailed(
  session: Stripe.Checkout.Session,
  orderId: string
): Promise<void> {
  // Shared with checkout.session.expired — same guarded release, so cron/
  // webhook/either failure event can never drift into different behavior.
  // Idempotent (paid orders and stale/replaced session IDs are a no-op) and
  // atomic across every item on a multi-item order — no partial release.
  const outcome = await releaseOnConfirmedNonPayment(orderId, session.id)
  if (outcome === 'released') {
    logger.info('stripe.webhook.asyncPaymentFailedReleased', { orderId, sessionId: session.id })
  }
}
