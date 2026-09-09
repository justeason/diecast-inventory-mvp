import crypto from 'crypto'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/hashToken'

// 19B: anonymous seller capture session. Deliberately independent of
// buyer_session/admin_session — a guest token must never be reusable as an
// authenticated CustomerSession, and 19C's future claim is the only code
// allowed to convert one into authenticated state.
export const GUEST_SELLER_COOKIE_NAME = 'guest_sell_session'
export const GUEST_SELLER_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  }
}

export type GuestSellerSessionContext = { id: string }

// 19B Final Runtime Reconciliation: this helper is called from Server
// COMPONENT render paths (getSellBatch/getUnclaimedGuestBatchCount on the
// /sell page's GET), not only from Server Actions — Next.js only permits
// cookies().set()/delete() from a Server Action or Route Handler, never from a
// component render. An earlier version of this function proactively cleared
// an expired/unknown cookie here, which would throw (or otherwise misbehave)
// whenever it ran during render. Fixed by making this TRULY read-only: no
// cookie mutation under any outcome. A stale/expired/unknown cookie is left
// alone — harmless, since every lookup (here and at mutation time) always
// re-validates tokenHash + expiresAt fresh; nothing ever trusts the cookie's
// mere presence. The stale cookie is naturally overwritten the next time
// addGuestSellerItem's first-add path mints a new session (see
// setGuestSellerCookie), with no requirement to delete the old DB row inline.
export async function getGuestSellerSessionContext(): Promise<GuestSellerSessionContext | null> {
  const cookieStore = await cookies()
  const cookie = cookieStore.get(GUEST_SELLER_COOKIE_NAME)
  if (!cookie?.value) return null

  const tokenHash = hashToken(cookie.value)
  const session = await prisma.guestSellerSession.findFirst({
    where: { tokenHash, expiresAt: { gt: new Date() } },
    select: { id: true },
  })

  return session ? { id: session.id } : null
}

// Generates a fresh raw token + its SHA-256 hash. Reusing hashToken() here is
// correct — this is a 256-bit random token, not a password, so a fast hash is
// appropriate (same reasoning 19A used for CustomerSession/CustomerLoginToken).
// Does NOT write to the DB or set a cookie — the caller creates the
// GuestSellerSession row itself, inside the SAME transaction as the first
// item, so the two commit atomically; the cookie is set only after that
// transaction has actually committed (see setGuestSellerCookie).
export function generateGuestSellerToken(): { rawToken: string; tokenHash: string; expiresAt: Date } {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + GUEST_SELLER_TTL_SECONDS * 1000)
  return { rawToken, tokenHash, expiresAt }
}

export async function setGuestSellerCookie(rawToken: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(GUEST_SELLER_COOKIE_NAME, rawToken, cookieOptions(GUEST_SELLER_TTL_SECONDS))
}
