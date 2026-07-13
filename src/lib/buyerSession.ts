import crypto from 'crypto'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'

const COOKIE_NAME = 'buyer_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  }
}

export async function createBuyerSession(profileId: string): Promise<void> {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const sessionHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000)

  await prisma.customerSession.create({
    data: { profileId, sessionHash, expiresAt },
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

export async function clearBuyerSession(): Promise<void> {
  const cookieStore = await cookies()
  const cookie = cookieStore.get(COOKIE_NAME)

  if (cookie?.value) {
    const sessionHash = hashToken(cookie.value)
    await prisma.customerSession.deleteMany({ where: { sessionHash } })
  }

  cookieStore.set(COOKIE_NAME, '', cookieOptions(0))
}
