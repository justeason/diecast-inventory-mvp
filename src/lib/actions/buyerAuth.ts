'use server'

import crypto from 'crypto'
import { redirect } from 'next/navigation'
import { Resend } from 'resend'
import { prisma } from '@/lib/prisma'
import { normalizeEmail } from '@/lib/normalizeEmail'
import { hashToken } from '@/lib/hashToken'
import { createBuyerSession, clearBuyerSession } from '@/lib/buyerSession'
import { buildMagicLinkEmail } from '@/lib/email/magicLinkEmail'
import { isSafeAccountReturnTo } from '@/lib/customerModelIntent'

const TOKEN_TTL_MS        = 15 * 60 * 1000  // 15 minutes
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000  // 10 minutes
const RATE_LIMIT_MAX       = 3

// ─── Action state types ───────────────────────────────────────────────────────

export type RequestLinkState =
  | { status: 'idle' }
  | { status: 'sent' }
  | { status: 'error'; message: string }

export type VerifyTokenState =
  | { status: 'idle' }
  | { status: 'error'; message: string }

// ─── requestBuyerOrderLink ────────────────────────────────────────────────────

export async function requestBuyerOrderLink(
  _prev: RequestLinkState,
  formData: FormData
): Promise<RequestLinkState> {
  const rawEmail = (formData.get('email') as string | null)?.trim() ?? ''

  if (!rawEmail || !rawEmail.includes('@')) {
    return { status: 'error', message: 'Please enter a valid email address.' }
  }

  const email = normalizeEmail(rawEmail)

  // Always return the same generic state — do not reveal whether the profile exists.
  const SENT: RequestLinkState = { status: 'sent' }

  // 16M Final: a CustomerProfile is NOT required to request a link — first-time
  // customers (no profile yet) can request one too; CustomerLoginToken.email is
  // an independent field, not an FK, so nothing here depends on a profile
  // existing. The profile itself is created later, only inside
  // verifyBuyerLoginToken, after email ownership is actually proven. This lookup
  // is read-only and used solely to personalize the email greeting for existing
  // customers — it never gates whether a token is created or an email is sent.
  const profile = await prisma.customerProfile.findUnique({
    where: { email },
    select: { name: true },
  })

  // Rate limit: max RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS)
  const recentCount = await prisma.customerLoginToken.count({
    where: { email, createdAt: { gt: windowStart } },
  })
  if (recentCount >= RATE_LIMIT_MAX) return SENT

  // Clean up expired tokens for this email before inserting a new one
  await prisma.customerLoginToken.deleteMany({
    where: { email, expiresAt: { lt: new Date() } },
  })

  // Generate and store hashed token
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

  await prisma.customerLoginToken.create({
    data: { email, tokenHash, expiresAt },
  })

  // 16M: optional local continuation destination, re-validated here (never trust
  // the client-submitted hidden field as-is) before it is allowed anywhere near
  // the outgoing email URL. Invalid/absent → simply omitted; existing behavior.
  const rawReturnTo = (formData.get('returnTo') as string | null) ?? null
  const safeReturnTo = isSafeAccountReturnTo(rawReturnTo)

  // Build verify URL using APP_URL — never trust a request Host header
  const appUrl = (process.env.APP_URL ?? 'https://www.collectntrades.com').replace(/\/$/, '')
  const verifyUrl = safeReturnTo
    ? `${appUrl}/account/orders/verify?token=${rawToken}&returnTo=${encodeURIComponent(safeReturnTo)}`
    : `${appUrl}/account/orders/verify?token=${rawToken}`

  // Send email (fire-tolerant: return SENT regardless of send outcome)
  if (process.env.RESEND_API_KEY && process.env.ORDER_DIGEST_FROM_EMAIL) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY)
      const { subject, html, text } = buildMagicLinkEmail({
        name: profile?.name,
        verifyUrl,
        appUrl,
      })
      // Bounded timeout. The Resend SDK does not expose an AbortSignal, so we
      // race against a local timer. The sendPromise gets a terminal .catch() to
      // prevent an unhandled rejection when the timeout fires first and the send
      // resolves/rejects later. Note: the underlying HTTP request is not aborted —
      // only the application-level wait is bounded.
      const sendPromise = resend.emails.send({
        from: process.env.ORDER_DIGEST_FROM_EMAIL, to: email, subject, html, text,
      })
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('email_timeout')), 8_000)
      })
      // Attach terminal handler to the loser to suppress unhandled rejection.
      sendPromise.catch(() => {})
      try {
        const { error } = await Promise.race([sendPromise, timeoutPromise])
        if (error) {
          console.error('[buyerAuth] Resend error sending magic link:', error.name)
        }
      } finally {
        clearTimeout(timeoutHandle)
      }
    } catch (err) {
      console.error('[buyerAuth] Unexpected error sending magic link:', err instanceof Error ? err.name : 'UnknownError')
    }
  } else {
    console.error('[buyerAuth] Cannot send magic link: RESEND_API_KEY or ORDER_DIGEST_FROM_EMAIL not set')
  }

  return SENT
}

// ─── verifyBuyerLoginToken ────────────────────────────────────────────────────

export async function verifyBuyerLoginToken(
  _prev: VerifyTokenState,
  formData: FormData
): Promise<VerifyTokenState> {
  const rawToken = (formData.get('token') as string | null)?.trim() ?? ''

  if (!rawToken) {
    return { status: 'error', message: 'Invalid or missing verification link.' }
  }

  const tokenHash = hashToken(rawToken)
  const now = new Date()

  // Atomically consume the token — updateMany returns count 0 if already used/expired/invalid
  const consumed = await prisma.customerLoginToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data:  { usedAt: now },
  })

  if (consumed.count === 0) {
    return { status: 'error', message: 'This link has expired or has already been used. Please request a new one.' }
  }

  // Retrieve the email from the now-consumed token record
  const tokenRecord = await prisma.customerLoginToken.findFirst({
    where: { tokenHash },
    select: { email: true },
  })

  if (!tokenRecord) {
    return { status: 'error', message: 'Verification failed. Please request a new link.' }
  }

  // 16M Final: token consumption above is already atomic/single-use, so by this
  // point email ownership is proven — safe to create a CustomerProfile now, exactly
  // once, if one doesn't already exist. Race-safe via the DB-level @unique
  // constraint on CustomerProfile.email (upsert, not findUnique-then-create) —
  // the exact same pattern already used by checkout (createOrder in orders.ts).
  // Never touches name/phone/notes on an existing profile — a login attempt
  // carries no such data to update, unlike checkout.
  const profile = await prisma.customerProfile.upsert({
    where: { email: tokenRecord.email },
    update: {},
    create: { email: tokenRecord.email },
    select: { id: true },
  })

  // Create the authenticated buyer session and set the cookie
  await createBuyerSession(profile.id)

  // 16M: re-validate the client-submitted returnTo one final time, right before
  // the redirect — the earlier hops (form render, email URL) already validated
  // it, but a hidden field is still user-editable, so this is the hop that
  // actually matters for open-redirect defense (Part M/N).
  const rawReturnTo = (formData.get('returnTo') as string | null) ?? null
  const safeReturnTo = isSafeAccountReturnTo(rawReturnTo)

  redirect(safeReturnTo ?? '/account/orders')
}

// ─── signOutBuyer ─────────────────────────────────────────────────────────────

// 16O: destination changed to /account (Part J) — shows login state immediately
// and implies no particular product context, unlike /account/orders. No
// user-controlled returnTo; clearBuyerSession() already safely no-ops when
// called anonymously (Part M), and only ever deletes the ONE CustomerSession
// row matching the current cookie's hash — never all sessions for the profile
// (Part AK) — so another device's session is untouched.
export async function signOutBuyer(): Promise<void> {
  await clearBuyerSession()
  redirect('/account')
}
