import crypto from 'crypto'
import { cookies } from 'next/headers'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/hashToken'

const COOKIE_NAME = 'buyer_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  }
}

export type BuyerAuthMethod = 'magic_link' | 'password'

export async function createBuyerSession(profileId: string, authMethod: BuyerAuthMethod): Promise<void> {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const sessionHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000)

  await prisma.customerSession.create({
    data: { profileId, sessionHash, expiresAt, authMethod },
  })

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, rawToken, cookieOptions(SESSION_MAX_AGE_SECONDS))
}

export async function getBuyerSession(): Promise<{ profileId: string } | null> {
  const cookieStore = await cookies()
  const cookie = cookieStore.get(COOKIE_NAME)
  if (!cookie?.value) return null

  const sessionHash = hashToken(cookie.value)

  const session = await prisma.customerSession.findFirst({
    where: { sessionHash, expiresAt: { gt: new Date() } },
    select: { profileId: true },
  })

  return session ? { profileId: session.profileId } : null
}

export type BuyerSessionContext = {
  id: string
  profileId: string
  createdAt: Date
  authMethod: BuyerAuthMethod | null
}

// 19A: server-only — used exclusively by password change-flow logic (recent
// magic-link reauth check, other-session revocation). Never passed to a Client
// Component; existing customer authorization elsewhere continues to use the
// plain getBuyerSession() above unchanged.
export async function getBuyerSessionContext(): Promise<BuyerSessionContext | null> {
  const cookieStore = await cookies()
  const cookie = cookieStore.get(COOKIE_NAME)
  if (!cookie?.value) return null

  const sessionHash = hashToken(cookie.value)

  const session = await prisma.customerSession.findFirst({
    where: { sessionHash, expiresAt: { gt: new Date() } },
    select: { id: true, profileId: true, createdAt: true, authMethod: true },
  })
  if (!session) return null

  return {
    id: session.id,
    profileId: session.profileId,
    createdAt: session.createdAt,
    authMethod: session.authMethod === 'magic_link' || session.authMethod === 'password' ? session.authMethod : null,
  }
}

// 19A: called only after a successful password CHANGE (never Sign Out, never
// initial Set Password) — deletes every OTHER CustomerSession row for this
// profile, keeping currentSessionId untouched. This is the one supported "revoke
// all other devices" primitive; ordinary sign-out remains current-session-only
// via clearBuyerSession below, unchanged.
//
// Accepts an optional transaction client so the caller (changePassword) can run
// this in the SAME transaction as the credential update — the two must commit
// or roll back together (19A Final Reconciliation §1). Defaults to the plain
// `prisma` client so every other/older call site behaves exactly as before.
export async function revokeOtherBuyerSessions(
  profileId: string,
  currentSessionId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.customerSession.deleteMany({
    where: { profileId, id: { not: currentSessionId } },
  })
}

const RECENT_MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000

// 19A: forgot-password recovery without a second reset-token system — a
// magic-link session created within the last 15 minutes counts as recent email
// reauthentication. authMethod=null (pre-19A sessions) and 'password' sessions
// never qualify, regardless of age; neither does an old magic-link session.
export function recentMagicLinkReauth(ctx: BuyerSessionContext): boolean {
  if (ctx.authMethod !== 'magic_link') return false
  return Date.now() - ctx.createdAt.getTime() <= RECENT_MAGIC_LINK_WINDOW_MS
}

export async function clearBuyerSession(): Promise<void> {
  const cookieStore = await cookies()
  const cookie = cookieStore.get(COOKIE_NAME)

  if (cookie?.value) {
    const sessionHash = hashToken(cookie.value)
    await prisma.customerSession.deleteMany({ where: { sessionHash } })
  }

  cookieStore.set(COOKIE_NAME, '', cookieOptions(0))
}
