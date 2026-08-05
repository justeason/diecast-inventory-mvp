'use server'

import crypto from 'crypto'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { logger } from '@/lib/serverLogger'
import { normalizeError } from '@/lib/errors'
import { getRequestId } from '@/lib/requestId'

// 5 attempts per 15 minutes per IP (instance-local — see rateLimit.ts)
const LOGIN_RATE_LIMIT_MAX = 5
const LOGIN_RATE_LIMIT_MS  = 15 * 60 * 1000

export type LoginState = string | null

// Derives a session token from the admin password using HMAC-SHA256.
// The same derivation runs in proxy.ts (via Web Crypto) so the two stay in sync.
function deriveSessionToken(password: string): string {
  return crypto
    .createHmac('sha256', password)
    .update('diecast-admin-session')
    .digest('hex')
}

export async function loginAdmin(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const reqHeaders  = await headers()
  const requestId   = await getRequestId()
  const rateLimitKey = rateLimitKeyFromHeaders(reqHeaders, ':admin_login')

  // Fail closed: null key means RATE_LIMIT_SECRET is absent in production.
  if (rateLimitKey === null) {
    logger.warn('admin.login.rate_limit_secret_missing', { requestId })
    return 'Login is temporarily unavailable. Contact the administrator.'
  }

  const { allowed, resetMs } = checkRateLimit(rateLimitKey, LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_MS)
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    logger.warn('admin.login.rate_limited', { requestId, action: 'loginAdmin', status: 429 })
    return `Too many login attempts. Please wait ${secs} seconds.`
  }

  const password = process.env.ADMIN_PASSWORD
  if (!password) {
    logger.warn('admin.login.password_not_configured', { requestId })
    return 'Login is temporarily unavailable. Contact the administrator.'
  }

  const submitted = (formData.get('password') as string) ?? ''

  let match: boolean
  try {
    const submittedHash = crypto.createHash('sha256').update(submitted).digest()
    const expectedHash  = crypto.createHash('sha256').update(password).digest()
    match = crypto.timingSafeEqual(submittedHash, expectedHash)
  } catch (e) {
    const norm = normalizeError(e, { event: 'admin.login.unexpected_error', requestId })
    return norm.userMessage
  }

  if (!match) {
    logger.warn('admin.login.failed', { requestId, status: 401 })
    return 'Incorrect password.'
  }

  const cookieStore = await cookies()
  cookieStore.set('admin_session', deriveSessionToken(password), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })

  redirect('/admin')
}

export async function logoutAdmin(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set('admin_session', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    path: '/',
  })
  redirect('/admin/login')
}
