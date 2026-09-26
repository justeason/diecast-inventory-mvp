// 39B: shared reservation-deadline and safe-release logic — used by BOTH the
// cron job (src/app/api/cron/order-reservations/route.ts) and the Stripe
// webhook's handleSessionExpired (src/app/api/webhooks/stripe/route.ts), so
// there is exactly one release code path, never two independently-maintained
// copies of the same safety-critical transition.
//
// Design constraint from 39A: a DB transaction cannot atomically roll back an
// external Stripe action. Every release therefore either (a) has no Stripe
// session yet (pre-session release — pure DB guard), or (b) reconciles the
// actual provider session state FIRST, and only releases once non-payment is
// conclusively established. A provider API failure is treated conservatively
// (retain the reservation, try again next run) — never as proof of non-payment.
import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { logger } from '@/lib/serverLogger'
import { internalPriceToCents } from '@/lib/marketMoney'

export const RESERVATION_INITIAL_MINUTES = 30
const RELEASE_BATCH_SIZE = 100

// No Order.currency column exists — the codebase's single-currency invariant
// (src/lib/actions/stripe.ts hardcodes currency: 'usd' on every line item) is
// the expectation here, not an assumption of multi-currency support. Shared
// by every "mark paid" caller (webhook + cron) via verifyAndMarkOrderPaid.
export const EXPECTED_CURRENCY = 'usd'

export function computeInitialReservationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + RESERVATION_INITIAL_MINUTES * 60 * 1000)
}

export type AttachSessionOutcome = 'attached' | 'reservation_lost'

// Session-creation-vs-cron-release race: creating a Stripe Checkout Session
// (an external API call) and writing stripeSessionId to the DB are NOT one
// atomic operation. Between the pre-flight order read in
// createAndSendStripeCheckoutSession and this write, the cron can release
// this Order's pre-session reservation entirely (deadline passed while the
// Stripe API call was in flight). Guards the attachment on the SAME Order
// fields the release path itself guards on, AND on the underlying
// ItemInstances still being reserved at write time — if either has moved,
// the freshly-created Stripe session is orphaned: the caller must expire it
// in Stripe and refuse to hand back a payable URL, never revive the
// already-released Order and never re-reserve stock as a side effect of
// sending a payment link.
export async function attachStripeSession(
  orderId: string,
  itemIds: string[],
  data: {
    stripeSessionId: string
    stripeSessionExpiresAt: Date
    reservationExpiresAt: Date
    paymentLink: string | null
    paymentRequestedAt: Date
  },
  now: Date = new Date(),
): Promise<AttachSessionOutcome> {
  return prisma.$transaction(async (tx) => {
    const reservedCount = await tx.itemInstance.count({ where: { id: { in: itemIds }, status: 'reserved' } })
    if (reservedCount !== itemIds.length) return 'reservation_lost'

    const updated = await tx.order.updateMany({
      // reservationExpiresAt: { gt: now } — the Order's initial (pre-session)
      // deadline must be STRICTLY in the future at this exact write. A
      // reservation whose deadline has already passed but that the cron
      // hasn't processed yet must not be handed a brand-new payment window —
      // "exactly at the deadline" is rejected too (gt, never gte).
      where: { id: orderId, status: 'pending', paymentStatus: 'unpaid', stripeSessionId: null, reservationExpiresAt: { gt: now } },
      data: {
        stripeSessionId:        data.stripeSessionId,
        stripeSessionExpiresAt: data.stripeSessionExpiresAt,
        reservationExpiresAt:   data.reservationExpiresAt,
        paymentLink:            data.paymentLink,
        paymentStatus:          'requested',
        paymentRequestedAt:     data.paymentRequestedAt,
        paymentMethod:          'stripe',
      },
    })
    return updated.count === 1 ? 'attached' : 'reservation_lost'
  })
}

type OrderForRelease = {
  id: string
  status: string
  paymentStatus: string
  stripeSessionId: string | null
  estimatedShipping: number | null
  orderItems: { itemId: string; price: number }[]
}

// The ONE guarded release transition — conditional on every fact that must
// still hold true, so a concurrently-changed Order (payment arrived, admin
// already cancelled/completed it, a session was replaced) safely no-ops
// instead of forcing a transition. Mirrors createOrder's own
// conditional-updateMany-is-the-real-guard pattern (28A/39A).
async function releaseGuarded(
  order: OrderForRelease,
  expectedStripeSessionId: string | null,
): Promise<'released' | 'no_op'> {
  const itemIds = order.orderItems.map((oi) => oi.itemId)

  return prisma.$transaction(async (tx) => {
    // Every fact this release depends on is re-checked in the WHERE clause
    // itself, not just read-then-trusted — status, paymentStatus, and the
    // exact session identity this caller reasoned about must ALL still hold.
    const released = await tx.order.updateMany({
      where: {
        id: order.id,
        status: 'pending',
        paymentStatus: { in: ['unpaid', 'requested'] },
        stripeSessionId: expectedStripeSessionId,
      },
      data: {
        stripeSessionId: null,
        stripeSessionExpiresAt: null,
        reservationExpiresAt: null,
        paymentStatus: 'unpaid',
        paymentLink: null,
        ...(order.paymentStatus === 'requested' ? { paymentMethod: null, paymentRequestedAt: null } : {}),
      },
    })
    if (released.count !== 1) return 'no_op'

    // Status-scoped, exact-ID-scoped — never releases an item that has moved
    // on to sold/available-for-another-reason since this order last touched it.
    await tx.itemInstance.updateMany({
      where: { id: { in: itemIds }, status: 'reserved' },
      data: { status: 'available' },
    })
    return 'released'
  })
}

export type MarkOrderPaidOutcome = 'paid' | 'not_paid' | 'no_match' | 'amount_mismatch' | 'reservation_released_exception'

export type SessionPaymentFacts = {
  id: string
  payment_status: string
  amount_total: number | null
  currency: string | null
  payment_intent: string | null
}

// The ONE verified path to Order.paymentStatus = 'paid' — used by the Stripe
// webhook's checkout.session.completed AND checkout.session.async_payment_succeeded
// handlers, AND the cron's late-payment reconciliation. Every caller gets the
// identical set of checks: payment_status === 'paid' (the ONLY value that
// proves funds were received for this app's positive-value, mode:'payment'
// Buy Now orders — 'no_payment_required' is deliberately excluded, since this
// app never creates a zero-value Checkout Session and that state does not
// prove payment), current stripeSessionId identity, non-cancelled/
// not-already-paid Order state, independently-computed amount/currency match,
// and — critically — that this Order's inventory is STILL reserved at the
// moment of marking paid. This is the single authority; no caller may mark an
// Order paid through any other path.
export async function verifyAndMarkOrderPaid(orderId: string, session: SessionPaymentFacts): Promise<MarkOrderPaidOutcome> {
  if (session.payment_status !== 'paid') {
    // Defense in depth — callers should already only invoke this once a
    // session is known to be paid, but this function is the one authority,
    // so it re-asserts the gate itself rather than trusting the caller.
    return 'not_paid'
  }

  const order = await prisma.order.findFirst({
    // status:{not:'cancelled'} — a cancelled Order's stripeSessionId is now
    // always cleared going forward (see orders.ts updateOrderStatus), but this
    // guards pre-existing/legacy rows too: a late payment on a stale session
    // must never resurrect a cancelled order.
    where: { id: orderId, stripeSessionId: session.id, status: { not: 'cancelled' } },
    select: {
      id: true, status: true, paymentStatus: true, estimatedShipping: true,
      orderItems: { select: { itemId: true, price: true } },
    },
  })
  // No match: stale/replaced/cancelled session, or (paymentStatus==='paid')
  // already idempotently handled by a concurrent caller — both benign no-ops,
  // never logged as an error.
  if (!order || order.paymentStatus === 'paid') return 'no_match'

  const expectedCents = computeExpectedOrderAmountCents(order)
  if (session.amount_total === null || session.amount_total !== expectedCents || session.currency !== EXPECTED_CURRENCY) {
    logger.error('orders.payment.amountMismatch', undefined, {
      orderId, sessionId: session.id, expectedCents, actualCents: session.amount_total,
      expectedCurrency: EXPECTED_CURRENCY, actualCurrency: session.currency,
    })
    return 'amount_mismatch'
  }

  const itemIds = order.orderItems.map((oi) => oi.itemId)

  return prisma.$transaction(async (tx) => {
    // §12/§4 exception: payment confirmed AFTER this order's reservation was
    // already released (cron/webhook-expiry beat the payment here, or the
    // items were re-reserved for a different Order entirely). Never silently
    // convert a released Order back to paid — no fabricated refund, no
    // automatic re-reservation, no assumption the stock is still available.
    const reservedCount = await tx.itemInstance.count({ where: { id: { in: itemIds }, status: 'reserved' } })
    if (reservedCount !== itemIds.length) {
      // No durable escalation/reconciliation-issue mechanism currently exists
      // for this exact exception (39A found operationalReconciliation.ts is a
      // broad read-time detection report, not a live event log — wiring into
      // it here would be a scope-expanding guess at its categorization).
      // Logged so it is at least greppable/alertable; a real escalation
      // surface is deferred, reported explicitly rather than silently assumed.
      logger.error('orders.payment.paidAfterReservationReleased', undefined, { orderId, sessionId: session.id })
      return 'reservation_released_exception'
    }

    const updated = await tx.order.updateMany({
      where: { id: orderId, stripeSessionId: session.id, paymentStatus: { not: 'paid' }, status: { not: 'cancelled' } },
      data: {
        paymentStatus: 'paid',
        paidAt: new Date(),
        paymentMethod: 'stripe',
        paymentReference: session.payment_intent,
        stripePaymentIntentId: session.payment_intent,
        stripeSessionId: null,
        stripeSessionExpiresAt: null,
        reservationExpiresAt: null,
        ...(order.status === 'pending' ? { status: 'paid' } : {}),
      },
    })
    return updated.count === 1 ? 'paid' : 'no_match'
  })
}

function sessionPaymentFacts(sessionId: string, session: { payment_status: string; amount_total: number | null; currency: string | null; payment_intent: unknown }): SessionPaymentFacts {
  return {
    id: sessionId,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    currency: session.currency,
    payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
  }
}

// Terminal PaymentIntent states after an asynchronous payment method's final
// attempt has definitively failed (Stripe does not auto-retry within
// Checkout): 'requires_payment_method' is the documented outcome; 'canceled'
// covers an explicitly cancelled intent. Neither is reachable while a payment
// is still genuinely processing.
const TERMINAL_FAILED_PAYMENT_INTENT_STATUSES = new Set(['requires_payment_method', 'canceled'])

// Reconciles ONE Order that has an attached Stripe session and has passed its
// local reservationExpiresAt deadline. Stripe is the source of truth here —
// local deadline/paymentStatus alone are never sufficient to conclude
// non-payment (39A §5/§8).
async function reconcileSessionedOrder(order: OrderForRelease): Promise<'released' | 'retained' | 'reconciled_paid'> {
  const sessionId = order.stripeSessionId!
  const stripe = getStripe()

  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.retrieve>>
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId)
  } catch (err) {
    // Provider API failure is NOT proof of non-payment — retain and retry later.
    logger.warn('orders.reservation.stripeRetrieveFailed', { orderId: order.id, sessionId, err: err instanceof Error ? err.name : 'UnknownError' })
    return 'retained'
  }

  if (session.payment_status === 'paid') {
    const outcome = await verifyAndMarkOrderPaid(order.id, sessionPaymentFacts(sessionId, session))
    return outcome === 'paid' ? 'reconciled_paid' : 'retained'
  }

  if (session.status === 'open') {
    // Still genuinely payable — expire it first (closes the payment window),
    // then re-verify its terminal state before releasing anything. A customer
    // who completes payment in the same instant this runs must never lose
    // both their payment attempt AND their reservation.
    try {
      session = await stripe.checkout.sessions.expire(sessionId)
    } catch (err) {
      logger.warn('orders.reservation.stripeExpireFailed', { orderId: order.id, sessionId, err: err instanceof Error ? err.name : 'UnknownError' })
      return 'retained'
    }
    if (session.payment_status === 'paid') {
      const outcome = await verifyAndMarkOrderPaid(order.id, sessionPaymentFacts(sessionId, session))
      return outcome === 'paid' ? 'reconciled_paid' : 'retained'
    }
  }

  // §3/§4: status:'complete' with payment_status !== 'paid' means Checkout
  // itself finished but an asynchronous payment method's outcome is not
  // reflected on the SESSION at all — Stripe leaves payment_status:'unpaid'
  // whether the payment is still processing OR has since definitively
  // failed. payment_status alone cannot distinguish these — the underlying
  // PaymentIntent must be inspected for a terminal-failure signal. This is
  // the webhook-delivery backstop: if the async_payment_failed webhook was
  // never delivered (or arrives late), this is what still recovers the
  // reservation, bounded by the cron's own cadence.
  if (session.status === 'complete') {
    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null
    if (!paymentIntentId) {
      logger.warn('orders.reservation.asyncPaymentPending', { orderId: order.id, sessionId, paymentStatus: session.payment_status })
      return 'retained'
    }

    let paymentIntent: Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)
    } catch (err) {
      // Provider API failure is NOT proof of anything — retain and retry later.
      logger.warn('orders.reservation.stripePaymentIntentRetrieveFailed', { orderId: order.id, sessionId, err: err instanceof Error ? err.name : 'UnknownError' })
      return 'retained'
    }

    if (paymentIntent.status === 'succeeded') {
      // The Session object can lag the PaymentIntent's own settlement — never
      // synthesize payment_status here (that would weaken the shared
      // verification's one true gate, which requires the SESSION itself to
      // report 'paid'). Re-retrieve the Session fresh instead; only proceed
      // through the real, unmodified shared transition if IT now genuinely
      // reports paid.
      let refreshed: Awaited<ReturnType<typeof stripe.checkout.sessions.retrieve>>
      try {
        refreshed = await stripe.checkout.sessions.retrieve(sessionId)
      } catch (err) {
        logger.warn('orders.reservation.stripeRetrieveFailed', { orderId: order.id, sessionId, err: err instanceof Error ? err.name : 'UnknownError' })
        return 'retained'
      }

      if (refreshed.payment_status === 'paid') {
        const outcome = await verifyAndMarkOrderPaid(order.id, sessionPaymentFacts(sessionId, refreshed))
        return outcome === 'paid' ? 'reconciled_paid' : 'retained'
      }

      // Genuine provider-state discrepancy: the PaymentIntent conclusively
      // succeeded but the refreshed Checkout Session still does not report
      // payment_status:'paid'. Never release (a real payment may have been
      // taken), never mark paid (the shared verification's real gate does
      // not confirm it) — retained, and reported as a genuine operational
      // reconciliation requirement, never as a resolved/successful outcome.
      logger.warn('orders.reservation.sessionPaymentIntentMismatch', {
        orderId: order.id, sessionId, sessionPaymentStatus: refreshed.payment_status, paymentIntentStatus: paymentIntent.status,
      })
      return 'retained'
    }

    if (TERMINAL_FAILED_PAYMENT_INTENT_STATUSES.has(paymentIntent.status)) {
      // Confirmed terminal failure — never leaves inventory reserved forever.
      const outcome = await releaseGuarded(order, sessionId)
      return outcome === 'released' ? 'released' : 'retained'
    }

    // Still genuinely processing (e.g. 'processing', 'requires_action',
    // 'requires_confirmation') — not proof of failure, never released.
    // Exposed honestly as an operational reconciliation requirement, not
    // "automatic recovery": until Stripe reaches a terminal state, this
    // order can only be retained and re-checked on the next cron run.
    logger.warn('orders.reservation.asyncPaymentPending', { orderId: order.id, sessionId, paymentIntentStatus: paymentIntent.status })
    return 'retained'
  }

  if (session.status !== 'expired') {
    // Any other/unrecognized non-terminal status — conservative retain,
    // never treat provider ambiguity as proof of non-payment.
    logger.warn('orders.reservation.unexpectedSessionStatus', { orderId: order.id, sessionId, sessionStatus: session.status })
    return 'retained'
  }

  // status === 'expired' and payment_status !== 'paid' — the only
  // conclusive non-payment terminal state reachable from the session alone.
  // Safe to release.
  const outcome = await releaseGuarded(order, sessionId)
  return outcome === 'released' ? 'released' : 'retained'
}

// Reconciles ONE Order with NO Stripe session yet, past its local deadline —
// the pre-session interval (cart submitted, payment link never generated).
// Pure DB guard: no external reconciliation needed since no provider session
// could possibly have been paid.
async function releasePreSessionOrder(order: OrderForRelease): Promise<'released' | 'retained'> {
  const outcome = await releaseGuarded(order, null)
  return outcome === 'released' ? 'released' : 'retained'
}

export type ReleaseResult = {
  checked: number
  released: number
  retained: number
  reconciledPaid: number
}

// §6/§13: the durable, idempotent, authenticated expiration job. Bounded to
// RELEASE_BATCH_SIZE per invocation — a duplicate/overlapping cron run only
// ever re-checks already-conditional, already-guarded transitions, so it can
// never double-release, double-mark-paid, or otherwise duplicate an effect.
export async function releaseExpiredReservations(now: Date = new Date()): Promise<ReleaseResult> {
  const candidates = await prisma.order.findMany({
    where: {
      status: 'pending',
      paymentStatus: { in: ['unpaid', 'requested'] },
      reservationExpiresAt: { lt: now },
    },
    select: {
      id: true, status: true, paymentStatus: true, stripeSessionId: true, estimatedShipping: true,
      orderItems: { select: { itemId: true, price: true } },
    },
    take: RELEASE_BATCH_SIZE,
  })

  const result: ReleaseResult = { checked: candidates.length, released: 0, retained: 0, reconciledPaid: 0 }

  for (const order of candidates) {
    const outcome = order.stripeSessionId
      ? await reconcileSessionedOrder(order)
      : await releasePreSessionOrder(order)

    if (outcome === 'released') result.released++
    else if (outcome === 'reconciled_paid') result.reconciledPaid++
    else result.retained++
  }

  return result
}

// Shared by BOTH the webhook's checkout.session.expired handler AND its
// checkout.session.async_payment_failed handler — two different Stripe event
// types that both represent "this session's payment is confirmed to have
// NOT succeeded," reduced to the exact same guarded release. Reused rather
// than reimplemented per-event, so no two release code paths can drift.
export async function releaseOnConfirmedNonPayment(orderId: string, sessionId: string): Promise<'released' | 'no_op'> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, stripeSessionId: sessionId },
    select: {
      id: true, status: true, paymentStatus: true, stripeSessionId: true, estimatedShipping: true,
      orderItems: { select: { itemId: true, price: true } },
    },
  })
  if (!order) return 'no_op' // stale/replaced session — never releases the current reservation
  if (order.paymentStatus === 'paid') return 'no_op' // payment already won the race — idempotent no-op
  return releaseGuarded(order, sessionId)
}

// §16: expected paid amount, computed independently from authoritative
// persisted Order/OrderItem data — never from a client cart snapshot. Same
// canonical integer-cents conversion used throughout the codebase.
export function computeExpectedOrderAmountCents(order: { estimatedShipping: number | null; orderItems: { price: number }[] }): number {
  const subtotalCents = order.orderItems.reduce((sum, oi) => sum + internalPriceToCents(oi.price), 0)
  const shippingCents = order.estimatedShipping ? internalPriceToCents(order.estimatedShipping) : 0
  return subtotalCents + shippingCents
}
