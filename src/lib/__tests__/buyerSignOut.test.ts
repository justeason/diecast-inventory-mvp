/**
 * 16O: customer sign-out finalization. Behavioral tests for clearBuyerSession/
 * signOutBuyer (mocked next/headers cookies + prisma + next/navigation redirect)
 * plus structural/source-regex checks for the /account/profile placement and
 * CustomerHeader's pre-existing sign-out UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

type Mock = ReturnType<typeof vi.fn>

// ── Behavioral: clearBuyerSession / signOutBuyer ────────────────────────────────

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
}
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))
vi.mock('@/lib/prisma', () => ({
  prisma: { customerSession: { deleteMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() } },
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))

import { prisma } from '@/lib/prisma'
import { clearBuyerSession, getBuyerSession } from '@/lib/buyerSession'
import { signOutBuyer } from '@/lib/actions/buyerAuth'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('clearBuyerSession: deletes exactly the ONE session matching the current cookie', () => {
  it('when a cookie is present, hashes it and deletes by sessionHash — never by profileId', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'raw-token-abc' })
    ;(prisma.customerSession.deleteMany as Mock).mockResolvedValue({ count: 1 })

    await clearBuyerSession()

    expect(prisma.customerSession.deleteMany).toHaveBeenCalledTimes(1)
    const call = (prisma.customerSession.deleteMany as Mock).mock.calls[0][0]
    expect(call.where).toHaveProperty('sessionHash')
    expect(call.where).not.toHaveProperty('profileId')
  })

  it('always clears the cookie (name/path/maxAge:0), even when no cookie was present — idempotent, no crash', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    await clearBuyerSession()

    expect(prisma.customerSession.deleteMany).not.toHaveBeenCalled()
    expect(mockCookieStore.set).toHaveBeenCalledWith('buyer_session', '', expect.objectContaining({ maxAge: 0, path: '/', httpOnly: true }))
  })

  it('cookie is cleared with the exact same name/path/httpOnly/sameSite semantics used when set — same cookieOptions() helper, just maxAge:0', () => {
    const src = readSrc('src/lib/buyerSession.ts')
    expect(src).toContain("cookieStore.set(COOKIE_NAME, '', cookieOptions(0))")
    expect(src).toContain("cookieStore.set(COOKIE_NAME, rawToken, cookieOptions(SESSION_MAX_AGE_SECONDS))")
  })

  it('no extra business-data query — clearBuyerSession touches only customerSession, one deleteMany call', () => {
    const src = stripComments(readSrc('src/lib/buyerSession.ts'))
    const fnIdx = src.indexOf('export async function clearBuyerSession')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}', fnIdx))
    expect(fnSrc).not.toMatch(/customerProfile|collectionItem|wantedCatalogModel|order\.|sellerSubmission|sellerProfile|customerCommunityProfile|customerLoginToken/i)
  })
})

describe('signOutBuyer: invalidates session, clears cookie, redirects to /account', () => {
  it('calls clearBuyerSession then redirects to /account (not /account/orders)', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'raw-token-abc' })
    ;(prisma.customerSession.deleteMany as Mock).mockResolvedValue({ count: 1 })

    await expect(signOutBuyer()).rejects.toThrow('NEXT_REDIRECT:/account')
    expect(prisma.customerSession.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('anonymous call (no cookie) is safe — no crash, no DB call, still redirects to /account', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    await expect(signOutBuyer()).rejects.toThrow('NEXT_REDIRECT:/account')
    expect(prisma.customerSession.deleteMany).not.toHaveBeenCalled()
  })

  it('does not redirect to /admin, checkout, an external URL, or any user-controlled destination — the target is a source-level literal', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    const fnIdx = src.indexOf('export async function signOutBuyer')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}', fnIdx))
    expect(fnSrc).toContain("redirect('/account')")
    expect(fnSrc).not.toMatch(/formData\.get|searchParams|returnTo/)
  })

  it('does not accept/trust profileId, sessionId, or token from FormData — signOutBuyer takes no arguments at all', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    expect(src).toContain('export async function signOutBuyer(): Promise<void> {')
  })
})

describe('Multi-device: signing out on one device does not invalidate another session for the same profile', () => {
  it('a second CustomerSession row (different sessionHash, same profileId) is untouched — deleteMany where-clause has no profileId key at all', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'device-a-raw-token' })
    ;(prisma.customerSession.deleteMany as Mock).mockResolvedValue({ count: 1 })

    await clearBuyerSession()

    const call = (prisma.customerSession.deleteMany as Mock).mock.calls[0][0]
    // sessionHash is @unique in the schema — a where-clause keyed only by
    // sessionHash can structurally match at most the ONE row for this exact
    // cookie, never a sibling session for the same profileId.
    expect(Object.keys(call.where)).toEqual(['sessionHash'])
  })

  it('CustomerSession.sessionHash is confirmed @unique in schema — the structural guarantee behind single-session deletion', () => {
    const schema = readSrc('prisma/schema.prisma')
    const sessionBlock = schema.slice(schema.indexOf('model CustomerSession {'), schema.indexOf('model CustomerSession {') + 400)
    expect(sessionBlock).toMatch(/sessionHash\s+String\s+@unique/)
  })
})

describe('getBuyerSession after sign-out: fresh lookup returns null, no revival', () => {
  it('deleted session row + cleared cookie → getBuyerSession returns null on the next call', async () => {
    mockCookieStore.get.mockReturnValue(undefined) // cookie already cleared
    const result = await getBuyerSession()
    expect(result).toBeNull()
    expect(prisma.customerSession.findFirst).not.toHaveBeenCalled()
  })

  it('even if a stale cookie value were somehow still sent, the DB session no longer matches (deleted), so findFirst legitimately returns nothing', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'now-deleted-raw-token' })
    ;(prisma.customerSession.findFirst as Mock).mockResolvedValue(null)
    const result = await getBuyerSession()
    expect(result).toBeNull()
  })

  it('getBuyerSession never creates/revives a CustomerProfile or CustomerSession — read-only', () => {
    const src = stripComments(readSrc('src/lib/buyerSession.ts'))
    const fnIdx = src.indexOf('export async function getBuyerSession')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}', fnIdx))
    expect(fnSrc).not.toMatch(/\.(create|upsert|update)\(/)
  })
})

// ── CustomerLoginToken untouched by sign-out ────────────────────────────────────

describe('Sign-out never touches CustomerLoginToken — magic-link tokens remain exactly as consumed/unconsumed', () => {
  it('neither clearBuyerSession nor signOutBuyer reference customerLoginToken', () => {
    const buyerSessionSrc = stripComments(readSrc('src/lib/buyerSession.ts'))
    const buyerAuthSrc = readSrc('src/lib/actions/buyerAuth.ts')
    const signOutIdx = buyerAuthSrc.indexOf('export async function signOutBuyer')
    const signOutSrc = buyerAuthSrc.slice(signOutIdx, buyerAuthSrc.indexOf('\n}', signOutIdx))
    expect(buyerSessionSrc).not.toMatch(/customerLoginToken/)
    expect(signOutSrc).not.toMatch(/customerLoginToken/)
  })
})

// ── Business-data invariant ──────────────────────────────────────────────────────

describe('Sign-out mutates authentication state only — zero writes to business records', () => {
  it('signOutBuyer body calls only clearBuyerSession + redirect — no other statement', () => {
    const src = stripComments(readSrc('src/lib/actions/buyerAuth.ts'))
    const fnIdx = src.indexOf('export async function signOutBuyer')
    const fnEnd = src.indexOf('\n}', fnIdx)
    const fnSrc = src.slice(fnIdx, fnEnd)
    const statements = fnSrc.split('\n').map((l) => l.trim()).filter(Boolean).slice(1) // drop signature line
    expect(statements).toEqual(['await clearBuyerSession()', "redirect('/account')"])
  })
  it('no CollectionItem/WantedCatalogModel/Order/SellerSubmission/SellerProfile/CustomerCommunityProfile/CatalogModel reference anywhere in the sign-out path', () => {
    for (const rel of ['src/lib/buyerSession.ts', 'src/lib/actions/buyerAuth.ts']) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/collectionItem|wantedCatalogModel|sellerSubmission|sellerProfile|customerCommunityProfile|catalogModel\./i)
    }
  })
})
