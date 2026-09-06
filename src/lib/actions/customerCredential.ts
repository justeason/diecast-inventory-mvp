'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { normalizeEmail } from '@/lib/normalizeEmail'
import { normalizeHandle, HANDLE_REGEX } from '@/lib/communityLeaderboards'
import { hashPassword, verifyPassword, getDummyHash } from '@/lib/passwordHash'
import {
  getBuyerSession,
  getBuyerSessionContext,
  createBuyerSession,
  revokeOtherBuyerSessions,
  recentMagicLinkReauth,
} from '@/lib/buyerSession'
import { isSafeAccountReturnTo } from '@/lib/customerModelIntent'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { logger } from '@/lib/serverLogger'
import { getRequestId } from '@/lib/requestId'

// ── Password rules (length-focused only, no composition theater) ─────────────
// Password is NEVER trimmed — leading/trailing whitespace some password
// managers pad with is significant. Confirm-field comparison likewise uses the
// raw, untrimmed value.
const PASSWORD_MIN_LENGTH = 10
const PASSWORD_MAX_LENGTH = 128

function validatePasswordRules(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`
  return null
}

function isPrismaP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

// ── Identifier resolution (email / handle / @handle) ──────────────────────────
// Trims the IDENTIFIER only — never the password. A leading '@' (and only a
// single leading '@' — "@@x" is not a handle) selects the handle path
// explicitly; otherwise '@' anywhere means email; otherwise bare handle. Handles
// never contain '@' (HANDLE_REGEX is [a-z0-9_] only), so this is unambiguous by
// construction, not a new syntax invented for this feature.
async function resolveCredential(rawIdentifier: string): Promise<{ profileId: string; passwordHash: string } | null> {
  const trimmed = rawIdentifier.trim()
  if (!trimmed) return null

  let profileId: string | null = null

  if (trimmed.startsWith('@') && !trimmed.slice(1).startsWith('@')) {
    profileId = await findProfileIdByHandle(normalizeHandle(trimmed.slice(1)))
  } else if (trimmed.includes('@')) {
    const email = normalizeEmail(trimmed)
    const found = await prisma.customerProfile.findUnique({ where: { email }, select: { id: true } })
    profileId = found?.id ?? null
  } else {
    profileId = await findProfileIdByHandle(normalizeHandle(trimmed))
  }

  if (!profileId) return null

  // Handle exists but no credential / handle doesn't exist / credential missing
  // — all converge here and produce the identical generic failure upstream.
  const credential = await prisma.customerCredential.findUnique({
    where: { profileId },
    select: { passwordHash: true },
  })
  if (!credential) return null

  return { profileId, passwordHash: credential.passwordHash }
}

async function findProfileIdByHandle(handle: string): Promise<string | null> {
  if (!HANDLE_REGEX.test(handle)) return null // invalid syntax — same generic failure, no distinct error
  const community = await prisma.customerCommunityProfile.findUnique({
    where: { handle },
    select: { profileId: true },
  })
  return community?.profileId ?? null
}

// ── loginWithPassword ──────────────────────────────────────────────────────────

export type LoginWithPasswordState =
  | { status: 'idle' }
  | { status: 'error'; message: string }

const GENERIC_LOGIN_ERROR = 'Invalid email/@handle or password.'
const GENERIC_RATE_LIMIT_ERROR = 'Too many sign-in attempts. Please try again later.'

const LOGIN_ID_MAX = 10
const LOGIN_ID_WINDOW_MS = 15 * 60 * 1000
const LOGIN_IP_MAX = 30
const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000

export async function loginWithPassword(
  _prev: LoginWithPasswordState,
  formData: FormData,
): Promise<LoginWithPasswordState> {
  const requestId = await getRequestId()

  const rawIdentifier = (formData.get('identifier') as string | null) ?? ''
  const password = (formData.get('password') as string | null) ?? ''
  const identifier = rawIdentifier.trim()

  if (!identifier || !password) {
    return { status: 'error', message: GENERIC_LOGIN_ERROR }
  }

  // Per-IP limiter — fails closed in production without RATE_LIMIT_SECRET,
  // mirroring loginAdmin's exact convention.
  const reqHeaders = await headers()
  const ipKey = rateLimitKeyFromHeaders(reqHeaders, ':pw_login_ip')
  if (ipKey === null) {
    logger.warn('customer.password_login.rate_limit_secret_missing', { requestId })
    return { status: 'error', message: 'Sign-in is temporarily unavailable. Please try again later.' }
  }
  if (!checkRateLimit(ipKey, LOGIN_IP_MAX, LOGIN_IP_WINDOW_MS).allowed) {
    logger.warn('customer.password_login.rate_limited_ip', { requestId, status: 429 })
    return { status: 'error', message: GENERIC_RATE_LIMIT_ERROR }
  }

  // Per-normalized-identifier limiter — separate namespace/key from the IP
  // limiter above. Lowercased so case variants of the same email/handle can't
  // be used to bypass the window.
  const identityKey = `pw_login_id:${identifier.toLowerCase()}`
  if (!checkRateLimit(identityKey, LOGIN_ID_MAX, LOGIN_ID_WINDOW_MS).allowed) {
    logger.warn('customer.password_login.rate_limited_identity', { requestId, status: 429 })
    return { status: 'error', message: GENERIC_RATE_LIMIT_ERROR }
  }

  const found = await resolveCredential(identifier)

  let ok: boolean
  if (found) {
    ok = await verifyPassword(password, found.passwordHash)
  } else {
    // Timing-only: pays the same scrypt cost as a real wrong-password check.
    // The dummy hash can never match a real submission, so the result is
    // discarded and ok is forced false regardless.
    await verifyPassword(password, await getDummyHash())
    ok = false
  }

  if (!found || !ok) {
    return { status: 'error', message: GENERIC_LOGIN_ERROR }
  }

  await createBuyerSession(found.profileId, 'password')

  const rawReturnTo = (formData.get('returnTo') as string | null) ?? null
  const safeReturnTo = isSafeAccountReturnTo(rawReturnTo)

  redirect(safeReturnTo ?? '/account')
}

// ── setPassword ────────────────────────────────────────────────────────────────
// Authenticated-session-only — never a first-time-signup path (see 19A section
// 2/17: password credential creation requires an already-AUTHENTICATED buyer
// session, never mere CustomerProfile existence).

export type SetPasswordState = {
  errors?: { password?: string[]; confirmPassword?: string[]; _form?: string[] }
  success?: boolean
} | null

export async function setPassword(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { _form: ['You must be signed in.'] } }

  const password = (formData.get('password') as string | null) ?? ''
  const confirmPassword = (formData.get('confirmPassword') as string | null) ?? ''

  const passwordError = validatePasswordRules(password)
  if (passwordError) return { errors: { password: [passwordError] } }
  if (password !== confirmPassword) return { errors: { confirmPassword: ['Passwords do not match.'] } }

  const existing = await prisma.customerCredential.findUnique({
    where: { profileId: session.profileId },
    select: { id: true },
  })
  if (existing) {
    return { errors: { _form: ['A password is already set for this account. Use Change Password instead.'] } }
  }

  const passwordHash = await hashPassword(password)

  try {
    await prisma.customerCredential.create({
      data: { profileId: session.profileId, passwordHash },
    })
  } catch (e) {
    // Two-tab race: profileId is @unique, so a concurrent Set Password from
    // another tab surfaces as P2002 here — a safe, specific message, never a
    // silently-ignored catch.
    if (isPrismaP2002(e)) {
      return { errors: { _form: ['A password was already configured for this account. Refresh and use Change Password instead.'] } }
    }
    throw e
  }

  revalidatePath('/account/profile')
  return { success: true }
}

// ── changePassword ──────────────────────────────────────────────────────────────

export type ChangePasswordState = {
  errors?: {
    currentPassword?: string[]
    newPassword?: string[]
    confirmPassword?: string[]
    _form?: string[]
  }
  success?: boolean
} | null

export async function changePassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const ctx = await getBuyerSessionContext()
  if (!ctx) return { errors: { _form: ['You must be signed in.'] } }

  const currentPassword = (formData.get('currentPassword') as string | null) ?? ''
  const newPassword = (formData.get('newPassword') as string | null) ?? ''
  const confirmPassword = (formData.get('confirmPassword') as string | null) ?? ''

  const newPasswordError = validatePasswordRules(newPassword)
  if (newPasswordError) return { errors: { newPassword: [newPasswordError] } }
  if (newPassword !== confirmPassword) return { errors: { confirmPassword: ['Passwords do not match.'] } }

  const credential = await prisma.customerCredential.findUnique({ where: { profileId: ctx.profileId } })
  if (!credential) {
    return { errors: { _form: ['No password is set for this account yet. Use Set Password instead.'] } }
  }

  // 19A section 10: a magic-link session created within the last 15 minutes
  // counts as recent email reauthentication and may replace the password
  // without the old one — this is the entire "forgot password" recovery path,
  // reusing the existing CustomerLoginToken flow instead of a second
  // reset-token system. authMethod=null (pre-19A sessions) and password
  // sessions never qualify, regardless of age.
  const bypassCurrentPassword = recentMagicLinkReauth(ctx)

  if (!bypassCurrentPassword) {
    if (!currentPassword) return { errors: { currentPassword: ['Enter your current password.'] } }
    const validCurrent = await verifyPassword(currentPassword, credential.passwordHash)
    // Generic failure — never reveals whether the account/credential state was
    // the problem, only that verification failed.
    if (!validCurrent) return { errors: { currentPassword: ['Current password is incorrect.'] } }
  }

  const newHash = await hashPassword(newPassword)

  // 19A Final Reconciliation §1: the credential update and other-session
  // revocation must commit or roll back TOGETHER — a password change must never
  // persist while revocation silently fails (leaving stale sessions live), and a
  // lost optimistic-concurrency race must never revoke anything. One shared
  // transaction; revokeOtherBuyerSessions accepts the same tx client so it never
  // duplicates the profileId/id-exclusion predicate that already lives in
  // buyerSession.ts.
  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.customerCredential.updateMany({
        where: { id: credential.id, updatedAt: credential.updatedAt },
        data: { passwordHash: newHash },
      })
      if (updated.count === 0) {
        throw new Error('CREDENTIAL_STALE')
      }

      // Only a CHANGE of an existing password revokes other sessions — initial
      // Set Password never does (see setPassword above, which never calls this).
      await revokeOtherBuyerSessions(ctx.profileId, ctx.id, tx)
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'CREDENTIAL_STALE') {
      return { errors: { _form: ['Your account was updated elsewhere. Please refresh and try again.'] } }
    }
    throw e
  }

  revalidatePath('/account/profile')
  return { success: true }
}
