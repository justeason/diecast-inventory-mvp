'use server'

import crypto from 'crypto'
import { redirect } from 'next/navigation'
import { Resend } from 'resend'
import { prisma } from '@/lib/prisma'
import { normalizeEmail } from '@/lib/normalizeEmail'
import { hashToken } from '@/lib/hashToken'
import { createBuyerSession, clearBuyerSession } from '@/lib/buyerSession'
import { buildMagicLinkEmail } from '@/lib/email/magicLinkEmail'

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

  const profile = await prisma.customerProfile.findUnique({
    where: { email },
    select: { id: true, name: true },
  })

  if (!profile) return SENT

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

  // Build verify URL using APP_URL — never trust a request Host header
  const appUrl = (process.env.APP_URL ?? 'https://www.collectntrades.com').replace(/\/$/, '')
  const verifyUrl = `${appUrl}/account/orders/verify?token=${rawToken}`

  // Send email (fire-tolerant: return SENT regardless of send outcome)
  if (process.env.RESEND_API_KEY && process.env.ORDER_DIGEST_FROM_EMAIL) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY)
      const { subject, html, text } = buildMagicLinkEmail({
        name: profile.name,
        verifyUrl,
        appUrl,
      })
      const { error } = await resend.emails.send({
        from: process.env.ORDER_DIGEST_FROM_EMAIL,
        to:   email,
        subject,
        html,
        text,
      })
      if (error) {
        console.error('[buyerAuth] Resend error sending magic link:', error.name)
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

  // Look up CustomerProfile by normalized email
  const profile = await prisma.customerProfile.findUnique({
    where: { email: tokenRecord.email },
    select: { id: true },
  })

  if (!profile) {
    return { status: 'error', message: 'No account found for this email. Please contact us if you believe this is an error.' }
  }

  // Create the authenticated buyer session and set the cookie
  await createBuyerSession(profile.id)

  redirect('/account/orders')
}

// ─── signOutBuyer ─────────────────────────────────────────────────────────────

export async function signOutBuyer(): Promise<void> {
  await clearBuyerSession()
  redirect('/account/orders')
}
