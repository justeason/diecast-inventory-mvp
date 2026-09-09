// 19B: guest anonymous seller session — token generation, hashing, cookie
// semantics, and lazy (never-revive) lookup behavior.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

type Mock = ReturnType<typeof vi.fn>

const mockCookieStore = { get: vi.fn(), set: vi.fn() }
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))
vi.mock('@/lib/prisma', () => ({
  prisma: { guestSellerSession: { findFirst: vi.fn() } },
}))

import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/hashToken'
import {
  GUEST_SELLER_COOKIE_NAME,
  GUEST_SELLER_TTL_SECONDS,
  getGuestSellerSessionContext,
  generateGuestSellerToken,
  setGuestSellerCookie,
} from '@/lib/guestSellerSession'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('GuestSellerSession: cookie name/independence', () => {
  it('cookie name is guest_sell_session — distinct from buyer_session/admin_session', () => {
    expect(GUEST_SELLER_COOKIE_NAME).toBe('guest_sell_session')
    expect(GUEST_SELLER_COOKIE_NAME).not.toBe('buyer_session')
    expect(GUEST_SELLER_COOKIE_NAME).not.toBe('admin_session')
  })

  it('TTL is exactly 7 days', () => {
    expect(GUEST_SELLER_TTL_SECONDS).toBe(60 * 60 * 24 * 7)
  })
})

describe('generateGuestSellerToken: 256-bit entropy, hashed, never stores raw', () => {
  it('produces a 64-hex-char raw token (32 bytes) and its SHA-256 hash via the shared hashToken helper', () => {
    const { rawToken, tokenHash } = generateGuestSellerToken()
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash).toBe(hashToken(rawToken))
  })

  it('two calls produce different tokens (real randomness, not a fixed value)', () => {
    const a = generateGuestSellerToken()
    const b = generateGuestSellerToken()
    expect(a.rawToken).not.toBe(b.rawToken)
    expect(a.tokenHash).not.toBe(b.tokenHash)
  })

  it('expiresAt is ~7 days from now', () => {
    const before = Date.now()
    const { expiresAt } = generateGuestSellerToken()
    const after = Date.now()
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + GUEST_SELLER_TTL_SECONDS * 1000 - 1000)
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + GUEST_SELLER_TTL_SECONDS * 1000 + 1000)
  })

  it('does not write to the DB or set a cookie — pure generation only', () => {
    generateGuestSellerToken()
    expect(prisma.guestSellerSession.findFirst).not.toHaveBeenCalled()
    expect(mockCookieStore.set).not.toHaveBeenCalled()
  })
})

describe('setGuestSellerCookie: exact flags', () => {
  it('httpOnly, sameSite lax, secure per NODE_ENV, path /, 7-day maxAge', async () => {
    await setGuestSellerCookie('some-raw-token')
    expect(mockCookieStore.set).toHaveBeenCalledWith('guest_sell_session', 'some-raw-token', expect.objectContaining({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: GUEST_SELLER_TTL_SECONDS,
    }))
  })

  it('secure flag is production-gated, exactly like buyer_session\'s own cookieOptions', () => {
    const src = readSrc('src/lib/guestSellerSession.ts')
    expect(src).toContain("secure: process.env.NODE_ENV === 'production'")
  })
})

describe('getGuestSellerSessionContext: read-only, never revives expired/unknown sessions', () => {
  it('no cookie present → null, zero DB calls', async () => {
    mockCookieStore.get.mockReturnValue(undefined)
    const ctx = await getGuestSellerSessionContext()
    expect(ctx).toBeNull()
    expect(prisma.guestSellerSession.findFirst).not.toHaveBeenCalled()
  })

  it('valid unexpired session → returns { id }', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'raw-token-abc' })
    ;(prisma.guestSellerSession.findFirst as Mock).mockResolvedValue({ id: 'sess1' })

    const ctx = await getGuestSellerSessionContext()
    expect(ctx).toEqual({ id: 'sess1' })

    const call = (prisma.guestSellerSession.findFirst as Mock).mock.calls[0][0]
    expect(call.where.tokenHash).toBe(hashToken('raw-token-abc'))
    expect(call.where).toHaveProperty('expiresAt')
  })

  it('lookup is scoped by tokenHash, never trusts a raw client-supplied session/token id directly', async () => {
    const src = readSrc('src/lib/guestSellerSession.ts')
    expect(src).toContain('const tokenHash = hashToken(cookie.value)')
    expect(src).toContain('where: { tokenHash, expiresAt: { gt: new Date() } }')
  })

  it('19B Final Runtime Reconciliation: expired/unknown session (findFirst returns null) → returns null and performs ZERO cookie mutation — never revives it, but also never clears it (cookies().set/delete is only legal from a Server Action/Route Handler, and this helper runs during Server Component render too)', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'raw-token-expired' })
    ;(prisma.guestSellerSession.findFirst as Mock).mockResolvedValue(null)

    const ctx = await getGuestSellerSessionContext()
    expect(ctx).toBeNull()
    expect(mockCookieStore.set).not.toHaveBeenCalled()
  })

  it('query itself always filters expiresAt > now — never omits the expiry check', () => {
    const src = readSrc('src/lib/guestSellerSession.ts')
    expect(src).toContain('expiresAt: { gt: new Date() }')
  })

  it('valid-session outcome also performs zero cookie mutation', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'raw-token-abc' })
    ;(prisma.guestSellerSession.findFirst as Mock).mockResolvedValue({ id: 'sess1' })
    await getGuestSellerSessionContext()
    expect(mockCookieStore.set).not.toHaveBeenCalled()
  })

  it('structural proof: the function body contains no cookieStore.set/delete call at all', () => {
    const src = readSrc('src/lib/guestSellerSession.ts')
    const idx = src.indexOf('export async function getGuestSellerSessionContext')
    const fnSrc = src.slice(idx, src.indexOf('\n}', idx))
    expect(fnSrc).not.toMatch(/cookieStore\.(set|delete)/)
  })
})

describe('19B scope guard: guest token hashing uses hashToken (SHA-256), never passwordHash', () => {
  it('guestSellerSession.ts never imports passwordHash', () => {
    const src = readSrc('src/lib/guestSellerSession.ts')
    expect(src).not.toContain('passwordHash')
    expect(src).toContain("import { hashToken } from '@/lib/hashToken'")
  })
})
