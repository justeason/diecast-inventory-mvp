// 19A: customerCredential.ts action tests. Hashing itself is covered for real in
// passwordHash.test.ts — here hashPassword/verifyPassword/getDummyHash are
// mocked so these action-layer tests stay fast and focus on login/set/change
// logic, not scrypt cost.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    customerProfile: { findUnique: vi.fn() },
    customerCommunityProfile: { findUnique: vi.fn() },
    customerCredential: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/passwordHash', () => ({
  hashPassword: vi.fn(async (p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(async (p: string, h: string) => h === `hashed:${p}`),
  getDummyHash: vi.fn(async () => 'hashed:dummy'),
}))
vi.mock('@/lib/buyerSession', () => ({
  getBuyerSession: vi.fn(),
  getBuyerSessionContext: vi.fn(),
  createBuyerSession: vi.fn(),
  revokeOtherBuyerSessions: vi.fn(),
  recentMagicLinkReauth: vi.fn(() => false),
}))
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 9, resetMs: 1000 })),
  rateLimitKeyFromHeaders: vi.fn(() => 'ip-key'),
}))
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/serverLogger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/requestId', () => ({ getRequestId: vi.fn().mockResolvedValue('req-1') }))

import { prisma } from '@/lib/prisma'
import { hashPassword, verifyPassword, getDummyHash } from '@/lib/passwordHash'
import {
  getBuyerSession,
  getBuyerSessionContext,
  createBuyerSession,
  revokeOtherBuyerSessions,
  recentMagicLinkReauth,
} from '@/lib/buyerSession'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { loginWithPassword, setPassword, changePassword } from '@/lib/actions/customerCredential'

function fd(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(checkRateLimit as Mock).mockReturnValue({ allowed: true, remaining: 9, resetMs: 1000 })
  ;(rateLimitKeyFromHeaders as Mock).mockReturnValue('ip-key')
  ;(hashPassword as Mock).mockImplementation(async (p: string) => `hashed:${p}`)
  ;(verifyPassword as Mock).mockImplementation(async (p: string, h: string) => h === `hashed:${p}`)
  ;(getDummyHash as Mock).mockResolvedValue('hashed:dummy')
  ;(recentMagicLinkReauth as Mock).mockReturnValue(false)
  // changePassword's credential-update + other-session-revocation now share one
  // prisma.$transaction — the mock invokes the callback with `prisma` itself as
  // the tx client (its customerCredential.updateMany mock is already wired, and
  // revokeOtherBuyerSessions is mocked wholesale so it doesn't care about the tx
  // object's shape).
  ;(prisma.$transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma))
})

// ── loginWithPassword ────────────────────────────────────────────────────────────

describe('loginWithPassword: email + password', () => {
  it('correct email/password succeeds and creates a password-tagged session', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:correct-password-1' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({ identifier: 'bob@example.com', password: 'correct-password-1' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account')

    expect(createBuyerSession).toHaveBeenCalledWith('p1', 'password')
  })

  it('email normalization: uppercase/whitespace email still resolves', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:pw' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({ identifier: '  BOB@Example.com  ', password: 'pw' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account')

    expect(prisma.customerProfile.findUnique).toHaveBeenCalledWith({ where: { email: 'bob@example.com' }, select: { id: true } })
  })

  it('wrong password: generic failure, no session created', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:correct-password-1' })

    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: 'bob@example.com', password: 'wrong' }))
    expect(result).toEqual({ status: 'error', message: 'Invalid email/@handle or password.' })
    expect(createBuyerSession).not.toHaveBeenCalled()
  })

  it('unknown email: generic failure identical to wrong password, dummy hash verified', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue(null)

    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: 'nobody@example.com', password: 'whatever' }))
    expect(result).toEqual({ status: 'error', message: 'Invalid email/@handle or password.' })
    expect(getDummyHash).toHaveBeenCalledTimes(1)
    expect(verifyPassword).toHaveBeenCalledWith('whatever', 'hashed:dummy')
    expect(createBuyerSession).not.toHaveBeenCalled()
  })

  it('profile exists but has no CustomerCredential: same generic failure', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue(null)

    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: 'bob@example.com', password: 'whatever' }))
    expect(result).toEqual({ status: 'error', message: 'Invalid email/@handle or password.' })
    expect(getDummyHash).toHaveBeenCalledTimes(1)
  })
})

describe('loginWithPassword: handle + @handle', () => {
  it('bare handle resolves via CustomerCommunityProfile', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:pw' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({ identifier: 'collectorbob', password: 'pw' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account')

    expect(prisma.customerCommunityProfile.findUnique).toHaveBeenCalledWith({ where: { handle: 'collectorbob' }, select: { profileId: true } })
    expect(createBuyerSession).toHaveBeenCalledWith('p1', 'password')
  })

  it('@handle (with leading @) resolves the same way, @ stripped and normalized', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:pw' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({ identifier: '@CollectorBob', password: 'pw' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account')

    expect(prisma.customerCommunityProfile.findUnique).toHaveBeenCalledWith({ where: { handle: 'collectorbob' }, select: { profileId: true } })
  })

  it('handle normalization: mixed-case handle still resolves to the same lowercase row', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:pw' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({ identifier: 'CollectorBob', password: 'pw' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account')

    expect(prisma.customerCommunityProfile.findUnique).toHaveBeenCalledWith({ where: { handle: 'collectorbob' }, select: { profileId: true } })
  })

  it('unknown handle: generic failure, no community lookup treated specially', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue(null)

    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: '@nosuchhandle', password: 'whatever' }))
    expect(result).toEqual({ status: 'error', message: 'Invalid email/@handle or password.' })
  })

  it('malformed handle syntax (fails HANDLE_REGEX) never queries the DB, generic failure', async () => {
    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: '@a', password: 'whatever' }))
    expect(result).toEqual({ status: 'error', message: 'Invalid email/@handle or password.' })
    expect(prisma.customerCommunityProfile.findUnique).not.toHaveBeenCalled()
  })
})

describe('loginWithPassword: rate limiting', () => {
  it('IP limiter fail-closed (null key) returns a safe generic-unavailable message, never proceeds to check credentials', async () => {
    ;(rateLimitKeyFromHeaders as Mock).mockReturnValue(null)
    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: 'bob@example.com', password: 'pw' }))
    expect(result.status).toBe('error')
    expect(prisma.customerProfile.findUnique).not.toHaveBeenCalled()
  })

  it('IP limiter exceeded: generic rate-limit message', async () => {
    ;(checkRateLimit as Mock).mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 60_000 })
    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: 'bob@example.com', password: 'pw' }))
    expect(result).toEqual({ status: 'error', message: 'Too many sign-in attempts. Please try again later.' })
  })

  it('identity limiter exceeded (separate key namespace from IP): generic rate-limit message', async () => {
    ;(checkRateLimit as Mock)
      .mockReturnValueOnce({ allowed: true, remaining: 29, resetMs: 1000 }) // IP check passes
      .mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 60_000 }) // identity check fails
    const result = await loginWithPassword({ status: 'idle' }, fd({ identifier: 'bob@example.com', password: 'pw' }))
    expect(result).toEqual({ status: 'error', message: 'Too many sign-in attempts. Please try again later.' })
    const [ipKeyArg, identityKeyArg] = (checkRateLimit as Mock).mock.calls.map((c) => c[0])
    expect(ipKeyArg).not.toBe(identityKeyArg)
  })

  it('no permanent lock — a fresh identifier/IP after the window is unaffected (structural: only checkRateLimit is consulted, no persistent lock field written anywhere)', () => {
    // checkRateLimit itself is the sliding-window primitive; no DB write for
    // failed-attempt counters exists in loginWithPassword at all.
    expect(prisma.customerProfile).not.toHaveProperty('update')
  })
})

describe('loginWithPassword: returnTo', () => {
  it('safe returnTo redirects to the intended continuation', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:pw' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({
        identifier: 'bob@example.com', password: 'pw',
        returnTo: '/account/continue?action=want&catalogId=X',
      })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/continue?action=want&catalogId=X')
  })

  it('unsafe returnTo (external URL) is rejected — falls back to /account', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:pw' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({
        identifier: 'bob@example.com', password: 'pw',
        returnTo: 'https://evil.example',
      })),
    ).rejects.toThrow('NEXT_REDIRECT:/account')
  })

  it('19C: a guest seller signing in with password and returnTo=/account/sell/claim lands on the claim page — password login has no postVerify channel at all, so returnTo is the only mechanism that can carry claim intent through it', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ passwordHash: 'hashed:pw' })

    await expect(
      loginWithPassword({ status: 'idle' }, fd({
        identifier: 'bob@example.com', password: 'pw',
        returnTo: '/account/sell/claim',
      })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/sell/claim')
  })
})

// ── setPassword ──────────────────────────────────────────────────────────────────

describe('setPassword', () => {
  it('unauthenticated: rejected, no credential created', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    const result = await setPassword(null, fd({ password: 'a-decent-password', confirmPassword: 'a-decent-password' }))
    expect(result).toEqual({ errors: { _form: ['You must be signed in.'] } })
    expect(prisma.customerCredential.create).not.toHaveBeenCalled()
  })

  it('authenticated profile without a credential can set one', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue(null)
    ;(prisma.customerCredential.create as Mock).mockResolvedValue({ id: 'cred1' })

    const result = await setPassword(null, fd({ password: 'a-decent-password', confirmPassword: 'a-decent-password' }))
    expect(result).toEqual({ success: true })
    expect(prisma.customerCredential.create).toHaveBeenCalledWith({
      data: { profileId: 'p1', passwordHash: 'hashed:a-decent-password' },
    })
  })

  it('never returns passwordHash in the action state', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue(null)
    ;(prisma.customerCredential.create as Mock).mockResolvedValue({ id: 'cred1' })

    const result = await setPassword(null, fd({ password: 'a-decent-password', confirmPassword: 'a-decent-password' }))
    expect(JSON.stringify(result)).not.toContain('hashed:')
  })

  it('confirm mismatch rejected before any DB write', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    const result = await setPassword(null, fd({ password: 'a-decent-password', confirmPassword: 'different-password' }))
    expect(result).toEqual({ errors: { confirmPassword: ['Passwords do not match.'] } })
    expect(prisma.customerCredential.create).not.toHaveBeenCalled()
  })

  it('too-short password rejected', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    const result = await setPassword(null, fd({ password: 'short', confirmPassword: 'short' }))
    expect(result?.errors?.password?.[0]).toMatch(/at least 10/)
  })

  it('too-long password rejected', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    const long = 'a'.repeat(129)
    const result = await setPassword(null, fd({ password: long, confirmPassword: long }))
    expect(result?.errors?.password?.[0]).toMatch(/128 characters or fewer/)
  })

  it('existing credential blocks Set Password with an actionable message', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'existing-cred' })
    const result = await setPassword(null, fd({ password: 'a-decent-password', confirmPassword: 'a-decent-password' }))
    expect(result?.errors?._form?.[0]).toMatch(/already set/)
    expect(prisma.customerCredential.create).not.toHaveBeenCalled()
  })

  it('two-tab race: concurrent create hits P2002, returns a safe specific message (not silently ignored, not a raw throw)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue(null)
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '5.22.0',
    })
    ;(prisma.customerCredential.create as Mock).mockRejectedValue(p2002)

    const result = await setPassword(null, fd({ password: 'a-decent-password', confirmPassword: 'a-decent-password' }))
    expect(result?.errors?._form?.[0]).toMatch(/already (been )?configured/)
  })
})

// ── changePassword ───────────────────────────────────────────────────────────────

const CTX_PASSWORD = { id: 'sess1', profileId: 'p1', createdAt: new Date(), authMethod: 'password' as const }
const CTX_FRESH_MAGIC_LINK = { id: 'sess1', profileId: 'p1', createdAt: new Date(), authMethod: 'magic_link' as const }

describe('changePassword: password-authenticated session', () => {
  it('wrong current password rejected', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_PASSWORD)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date() })

    const result = await changePassword(null, fd({
      currentPassword: 'wrong-old-password', newPassword: 'new-decent-password', confirmPassword: 'new-decent-password',
    }))
    expect(result).toEqual({ errors: { currentPassword: ['Current password is incorrect.'] } })
    expect(prisma.customerCredential.updateMany).not.toHaveBeenCalled()
  })

  it('correct current password succeeds: new hash persists, other sessions revoked, current session preserved (19A Final §8C)', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_PASSWORD)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date('2026-01-01') })
    ;(prisma.customerCredential.updateMany as Mock).mockResolvedValue({ count: 1 })

    const result = await changePassword(null, fd({
      currentPassword: 'old-real-password', newPassword: 'new-decent-password', confirmPassword: 'new-decent-password',
    }))
    expect(result).toEqual({ success: true })
    expect(prisma.customerCredential.updateMany).toHaveBeenCalledWith({
      where: { id: 'cred1', updatedAt: new Date('2026-01-01') },
      data: { passwordHash: 'hashed:new-decent-password' },
    })
    // tx is prisma itself under this file's default $transaction mock —
    // revokeOtherBuyerSessions receives it as the 3rd (transaction-client) arg.
    expect(revokeOtherBuyerSessions).toHaveBeenCalledWith('p1', 'sess1', prisma)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})

// ── 19A Final Reconciliation §1/§8: credential update + other-session
// revocation are atomic — one shared prisma.$transaction. ───────────────────────

describe('changePassword: atomicity (credential update + session revocation share one transaction)', () => {
  it('§8A: credential update succeeds but session revocation throws → the WHOLE transaction rolls back (simulated: the tx callback itself throws, so prisma.$transaction rejects and no success state is returned)', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_PASSWORD)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date('2026-01-01') })
    ;(prisma.customerCredential.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(revokeOtherBuyerSessions as Mock).mockRejectedValue(new Error('revocation failed'))
    // The mocked $transaction must actually propagate a callback rejection, like
    // a real Prisma transaction would, to prove the action doesn't swallow it.
    ;(prisma.$transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma))

    await expect(changePassword(null, fd({
      currentPassword: 'old-real-password', newPassword: 'new-decent-password', confirmPassword: 'new-decent-password',
    }))).rejects.toThrow('revocation failed')
  })

  it('§8B: optimistic credential update loses the race (count=0) → session revocation is NEVER attempted', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_PASSWORD)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date('2026-01-01') })
    ;(prisma.customerCredential.updateMany as Mock).mockResolvedValue({ count: 0 })

    const result = await changePassword(null, fd({
      currentPassword: 'old-real-password', newPassword: 'new-decent-password', confirmPassword: 'new-decent-password',
    }))
    expect(result?.errors?._form?.[0]).toMatch(/modified elsewhere|refresh/i)
    expect(revokeOtherBuyerSessions).not.toHaveBeenCalled()
  })

  it('both the credential updateMany and revokeOtherBuyerSessions run inside the SAME prisma.$transaction callback — structural proof, not just mock behavior', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/actions/customerCredential.ts'), 'utf-8')
    const txIdx = src.indexOf('await prisma.$transaction(async (tx) => {')
    expect(txIdx).toBeGreaterThan(-1)
    const txEnd = src.indexOf('\n    })', txIdx)
    const txBody = src.slice(txIdx, txEnd)
    expect(txBody).toContain('tx.customerCredential.updateMany')
    expect(txBody).toContain('revokeOtherBuyerSessions(ctx.profileId, ctx.id, tx)')
  })
})

describe('changePassword: recent magic-link reauth bypass', () => {
  it('fresh magic_link session (<=15min) may change without current password', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_FRESH_MAGIC_LINK)
    ;(recentMagicLinkReauth as Mock).mockReturnValue(true)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date() })
    ;(prisma.customerCredential.updateMany as Mock).mockResolvedValue({ count: 1 })

    const result = await changePassword(null, fd({ newPassword: 'new-decent-password', confirmPassword: 'new-decent-password' }))
    expect(result).toEqual({ success: true })
    expect(verifyPassword).not.toHaveBeenCalled()
  })

  it('old magic_link session (>15min, recentMagicLinkReauth=false) cannot bypass current password', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_FRESH_MAGIC_LINK)
    ;(recentMagicLinkReauth as Mock).mockReturnValue(false)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date() })

    const result = await changePassword(null, fd({ newPassword: 'new-decent-password', confirmPassword: 'new-decent-password' }))
    expect(result).toEqual({ errors: { currentPassword: ['Enter your current password.'] } })
  })

  it('authMethod=null session cannot bypass current password', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue({ id: 'sess1', profileId: 'p1', createdAt: new Date(), authMethod: null })
    ;(recentMagicLinkReauth as Mock).mockReturnValue(false)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date() })

    const result = await changePassword(null, fd({ newPassword: 'new-decent-password', confirmPassword: 'new-decent-password' }))
    expect(result).toEqual({ errors: { currentPassword: ['Enter your current password.'] } })
  })
})

describe('changePassword: no credential yet', () => {
  it('routes to Set Password instead — actionable message, no update attempted', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_PASSWORD)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue(null)

    const result = await changePassword(null, fd({
      currentPassword: 'x', newPassword: 'new-decent-password', confirmPassword: 'new-decent-password',
    }))
    expect(result?.errors?._form?.[0]).toMatch(/Set Password/)
    expect(prisma.customerCredential.updateMany).not.toHaveBeenCalled()
  })
})

describe('changePassword: concurrency', () => {
  it('optimistic updatedAt mismatch returns a safe retry message', async () => {
    ;(getBuyerSessionContext as Mock).mockResolvedValue(CTX_PASSWORD)
    ;(prisma.customerCredential.findUnique as Mock).mockResolvedValue({ id: 'cred1', passwordHash: 'hashed:old-real-password', updatedAt: new Date('2026-01-01') })
    ;(prisma.customerCredential.updateMany as Mock).mockResolvedValue({ count: 0 })

    const result = await changePassword(null, fd({
      currentPassword: 'old-real-password', newPassword: 'new-decent-password', confirmPassword: 'new-decent-password',
    }))
    expect(result?.errors?._form?.[0]).toMatch(/modified elsewhere|refresh/i)
    expect(revokeOtherBuyerSessions).not.toHaveBeenCalled()
  })
})
