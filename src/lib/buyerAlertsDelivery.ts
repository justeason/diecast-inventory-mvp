// 14A: Bounded delivery worker. Claims pending events via a leased, DB-verified claim
// (safe under concurrent/duplicate cron invocations and a simultaneous admin run — see
// buyerAlertsLease.ts), re-validates preferences/availability at send time, and sends
// via Resend with a deterministic idempotency key.
//
// Delivery semantics (be honest about what "sent" means):
//   - `sent`            — Resend confirmed acceptance (definitive).
//   - `failed`          — Resend explicitly rejected the request, or it was never
//                          attempted at all (e.g. missing config). Definitive; safe to
//                          retry with the same idempotency key.
//   - `suppressed`       — preferences/wanted-list/availability were no longer valid at
//                          send time. Definitive; not retried.
//   - `delivery_unknown` — our local timeout fired, or the SDK call threw before a
//                          structured response came back. Resend may or may not have
//                          received and processed the request. NEVER automatically or
//                          admin-retried — this codebase has no verified provider
//                          idempotency-window duration to retry safely within, so these
//                          rows are left for manual review instead of guessing. See
//                          retryFailedAlertEvent for the full rationale.

import { Resend } from 'resend'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/serverLogger'
import { buildWantedAvailableEmail, buildWantedPriceChangeEmail } from '@/lib/email/buyerAlertEmail'
import { generateClaimToken, staleBefore, DELIVERY_LEASE_MS } from '@/lib/buyerAlertsLease'

const DEFAULT_BATCH_SIZE = 50
const SEND_TIMEOUT_MS = 8_000

export type DeliveryOutcome = 'sent' | 'suppressed' | 'failed' | 'delivery_unknown'

export type ProcessResult = { claimed: number; sent: number; failed: number; suppressed: number; unknown: number }

type SendResult =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'failed'; code: string }
  | { outcome: 'unknown'; code: string }

// Sends one Resend email with a bounded timeout and a deterministic idempotency key
// derived only from the durable event id (never email/customer data). A retry of the
// same event always reuses the same key; different events always get different keys.
async function sendBounded(
  args: { to: string; subject: string; html: string; text: string },
  idempotencyKey: string,
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.BUYER_ALERTS_FROM_EMAIL || process.env.ORDER_DIGEST_FROM_EMAIL
  if (!apiKey || !fromEmail) return { outcome: 'failed', code: 'email_not_configured' }

  const resend = new Resend(apiKey)
  const sendPromise = resend.emails.send({ from: fromEmail, ...args }, { idempotencyKey })
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), SEND_TIMEOUT_MS)
  })
  sendPromise.catch(() => {}) // suppress unhandled rejection if the timeout wins

  try {
    const raced = await Promise.race([sendPromise, timeoutPromise])
    if (raced === 'timeout') {
      // The application-level wait is bounded, not the underlying HTTP request —
      // Resend may still accept and send the email after we stop waiting.
      return { outcome: 'unknown', code: 'email_timeout' }
    }
    const { data, error } = raced
    if (error) return { outcome: 'failed', code: error.name || 'resend_error' }
    return { outcome: 'sent', messageId: data.id }
  } catch (err) {
    // Thrown before any structured response (network failure, etc.) — we cannot tell
    // whether Resend received the request, so this is ambiguous, not a definitive failure.
    return { outcome: 'unknown', code: err instanceof Error ? err.name : 'unknown_error' }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

// Claims one event: fresh 'pending' rows, or a stale 'sending' lease (a prior worker
// crashed mid-send) whose claimedAt is older than DELIVERY_LEASE_MS.
async function claimEvent(id: string): Promise<string | null> {
  const token = generateClaimToken()
  const now = new Date()

  const fromPending = await prisma.buyerAlertEvent.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'sending', claimedAt: now, claimToken: token },
  })
  if (fromPending.count === 1) return token

  const fromStale = await prisma.buyerAlertEvent.updateMany({
    where: { id, status: 'sending', claimedAt: { lt: staleBefore(DELIVERY_LEASE_MS) } },
    data: { status: 'sending', claimedAt: now, claimToken: token },
  })
  return fromStale.count === 1 ? token : null
}

// Writes a terminal status only if this worker's claim is still current — if the lease
// was reclaimed by another worker in the meantime, this affects 0 rows and the caller's
// (now-stale) result is correctly discarded rather than clobbering a fresher one.
async function finalize(id: string, claimToken: string, data: Record<string, unknown>): Promise<boolean> {
  const result = await prisma.buyerAlertEvent.updateMany({ where: { id, claimToken }, data })
  return result.count === 1
}

async function deliverOne(eventId: string, claimToken: string): Promise<DeliveryOutcome> {
  const event = await prisma.buyerAlertEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true, customerProfileId: true, catalogModelId: true, listingId: true,
      alertType: true, previousPriceCents: true, currentPriceCents: true,
      catalogModel: { select: { brand: true, name: true, year: true } },
      customerProfile: { select: { email: true } },
    },
  })
  if (!event) return 'failed' // should not happen — claimed row disappeared

  const suppress = async (reason: string): Promise<DeliveryOutcome> => {
    await finalize(eventId, claimToken, { status: 'suppressed', failureCode: reason })
    return 'suppressed'
  }

  // Re-check the wanted relationship still exists (buyer may have removed it since creation).
  const stillWanted = await prisma.wantedCatalogModel.findUnique({
    where: { customerProfileId_catalogModelId: { customerProfileId: event.customerProfileId, catalogModelId: event.catalogModelId } },
    select: { id: true },
  })
  if (!stillWanted) return suppress('wanted_removed')

  // Re-check preferences fresh (buyer may have disabled email since creation).
  const pref = await prisma.buyerAlertPreference.findUnique({
    where: { customerProfileId: event.customerProfileId },
    select: { emailAlertsEnabled: true },
  })
  if (pref && !pref.emailAlertsEnabled) return suppress('email_disabled')

  // Re-check availability is still valid — same predicate as wantedListMatching.ts.
  let priceDollars: number | null = null
  let listingUrl = ''
  if (event.listingId) {
    const listing = await prisma.listing.findUnique({
      where: { id: event.listingId },
      select: { price: true, status: true, item: { select: { status: true } } },
    })
    if (!listing || listing.status !== 'active' || listing.item.status !== 'available') {
      return suppress('listing_unavailable')
    }
    priceDollars = listing.price
    const appUrl = (process.env.APP_URL ?? 'https://www.collectntrades.com').replace(/\/$/, '')
    listingUrl = `${appUrl}/browse/${event.listingId}`
  } else {
    await finalize(eventId, claimToken, { status: 'failed', failureCode: 'missing_listing' })
    return 'failed'
  }

  const modelName = `${event.catalogModel.brand} ${event.catalogModel.name}${event.catalogModel.year ? ` (${event.catalogModel.year})` : ''}`

  const built = event.alertType === 'wanted_available'
    ? buildWantedAvailableEmail({ modelName, priceDollars, listingUrl })
    : event.previousPriceCents !== null && event.currentPriceCents !== null
      ? buildWantedPriceChangeEmail({
          modelName,
          previousPriceDollars: event.previousPriceCents / 100,
          currentPriceDollars: event.currentPriceCents / 100,
          listingUrl,
          direction: event.alertType === 'wanted_price_decrease' ? 'decrease' : 'increase',
        })
      : null

  if (!built) {
    await finalize(eventId, claimToken, { status: 'failed', failureCode: 'invalid_event_shape' })
    return 'failed'
  }

  const idempotencyKey = `buyer-alert/${event.id}`
  const result = await sendBounded(
    { to: event.customerProfile.email, subject: built.subject, html: built.html, text: built.text },
    idempotencyKey,
  )

  if (result.outcome === 'sent') {
    await finalize(eventId, claimToken, { status: 'sent', sentAt: new Date(), providerMessageId: result.messageId })
    logger.info('buyerAlerts.send.sent', { eventId, alertType: event.alertType })
    return 'sent'
  }

  if (result.outcome === 'unknown') {
    await finalize(eventId, claimToken, { status: 'delivery_unknown', failureCode: result.code })
    logger.warn('buyerAlerts.send.unknown', { eventId, alertType: event.alertType, failureCode: result.code })
    return 'delivery_unknown'
  }

  await finalize(eventId, claimToken, { status: 'failed', failureCode: result.code })
  logger.error('buyerAlerts.send.failed', undefined, { eventId, alertType: event.alertType, failureCode: result.code })
  return 'failed'
}

// Claims and processes up to `batchSize` pending (or stale-leased) events, oldest first.
export async function processPendingBuyerAlerts(batchSize = DEFAULT_BATCH_SIZE): Promise<ProcessResult> {
  const candidates = await prisma.buyerAlertEvent.findMany({
    where: { OR: [{ status: 'pending' }, { status: 'sending', claimedAt: { lt: staleBefore(DELIVERY_LEASE_MS) } }] },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true },
  })

  const result: ProcessResult = { claimed: 0, sent: 0, failed: 0, suppressed: 0, unknown: 0 }

  for (const { id } of candidates) {
    const token = await claimEvent(id)
    if (!token) continue // lost the claim race to another worker
    result.claimed++

    const outcome = await deliverOne(id, token)
    if (outcome === 'sent') result.sent++
    else if (outcome === 'suppressed') result.suppressed++
    else if (outcome === 'delivery_unknown') result.unknown++
    else result.failed++
  }

  return result
}

// Admin-only explicit retry. Only 'failed' (a definitive, provider-confirmed rejection)
// is retryable — 'sent' is never retried, 'suppressed' is not retried without explicit
// re-validation (not implemented — suppression reasons are re-checked fresh on the next
// delivery attempt anyway, so a plain status reset is not offered for it here), and
// 'delivery_unknown' is deliberately NOT retryable here at all (see below). The retry
// reuses the SAME idempotency key (derived from the unchanging event id) and revalidates
// preferences/wanted-list/availability fresh — both handled by the normal deliverOne
// path once the row re-enters 'pending', not by this function.
//
// delivery_unknown is intentionally excluded: this codebase has no verified, documented
// value for how long Resend actually honors an Idempotency-Key, so there is no safe way
// to compute a "still within the window" cutoff here. Rather than guess a duration and
// risk a real duplicate send after the window has silently lapsed, delivery_unknown rows
// are left as an unresolved state for manual review (see the admin page) — never
// automatically or one-click retried. If a verified provider window is obtained in the
// future, a time-boxed retry can be added; until then this is the conservative choice.
export async function retryFailedAlertEvent(eventId: string): Promise<boolean> {
  const result = await prisma.buyerAlertEvent.updateMany({
    where: { id: eventId, status: 'failed' },
    data: { status: 'pending', failureCode: null, claimToken: null, claimedAt: null },
  })
  return result.count > 0
}
