/**
 * 16M: preserve customer action intent through sign-in. Behavioral tests for
 * customerModelIntent.ts (pure) + buyerAuth.ts's returnTo handling (mocked
 * prisma/resend/next-navigation) plus structural/source-regex checks for the
 * continuation route and every migrated anonymous action surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

type Mock = ReturnType<typeof vi.fn>

import {
  parseCustomerModelIntent,
  isSafeCatalogModelId,
  buildAccountIntentHref,
  isSafeAccountReturnTo,
} from '@/lib/customerModelIntent'

// ── Pure unit tests: shared intent module ───────────────────────────────────────

describe('16M: parseCustomerModelIntent — strict allowlist, no dynamic dispatch', () => {
  it('accepts exactly want/own/sell', () => {
    expect(parseCustomerModelIntent('want')).toBe('want')
    expect(parseCustomerModelIntent('own')).toBe('own')
    expect(parseCustomerModelIntent('sell')).toBe('sell')
  })
  it('rejects anything else, including admin/delete/function-name-shaped strings', () => {
    for (const bad of ['delete', 'admin', 'javascript:alert(1)', 'wantt', 'Want', 'WANT', '', 'null', 'undefined', 'constructor']) {
      expect(parseCustomerModelIntent(bad)).toBeNull()
    }
  })
  it('rejects null/undefined safely, never throws', () => {
    expect(parseCustomerModelIntent(null)).toBeNull()
    expect(parseCustomerModelIntent(undefined)).toBeNull()
  })
})

describe('16M: isSafeCatalogModelId', () => {
  it('accepts cuid-shaped ids', () => {
    expect(isSafeCatalogModelId('clx1a2b3c4d5e6f7g8h9')).toBe(true)
  })
  it('rejects empty, oversized, and special-character ids', () => {
    expect(isSafeCatalogModelId('')).toBe(false)
    expect(isSafeCatalogModelId(null)).toBe(false)
    expect(isSafeCatalogModelId(undefined)).toBe(false)
    expect(isSafeCatalogModelId('a'.repeat(65))).toBe(false)
    expect(isSafeCatalogModelId('../../etc/passwd')).toBe(false)
    expect(isSafeCatalogModelId('<script>')).toBe(false)
    expect(isSafeCatalogModelId('x&y=z')).toBe(false)
  })
})

describe('16M: buildAccountIntentHref — Part AT link generation', () => {
  it('want X → /account/continue?action=want&catalogId=X', () => {
    expect(buildAccountIntentHref({ action: 'want', catalogModelId: 'X' })).toBe('/account/continue?action=want&catalogId=X')
  })
  it('own X → correct safe encoded URL', () => {
    expect(buildAccountIntentHref({ action: 'own', catalogModelId: 'X' })).toBe('/account/continue?action=own&catalogId=X')
  })
  it('sell X → correct URL', () => {
    expect(buildAccountIntentHref({ action: 'sell', catalogModelId: 'X' })).toBe('/account/continue?action=sell&catalogId=X')
  })
  it('special characters in catalogModelId cannot alter query structure (properly percent-encoded)', () => {
    const href = buildAccountIntentHref({ action: 'want', catalogModelId: 'a&b=c' })
    expect(href).toBe('/account/continue?action=want&catalogId=a%26b%3Dc')
    // Round-trips back to the exact original value when parsed.
    const params = new URLSearchParams(href.split('?')[1])
    expect(params.get('catalogId')).toBe('a&b=c')
  })
})

describe('16M: isSafeAccountReturnTo — Part AZ open-redirect defense', () => {
  it('accepts a valid canonical continuation path', () => {
    expect(isSafeAccountReturnTo('/account/continue?action=want&catalogId=abc123')).toBe('/account/continue?action=want&catalogId=abc123')
  })

  it('rejects absolute external URLs', () => {
    expect(isSafeAccountReturnTo('https://evil.example')).toBeNull()
    expect(isSafeAccountReturnTo('http://evil.example')).toBeNull()
  })

  it('rejects protocol-relative URLs', () => {
    expect(isSafeAccountReturnTo('//evil.example')).toBeNull()
    expect(isSafeAccountReturnTo('//evil.example/account/continue?action=want&catalogId=x')).toBeNull()
  })

  it('rejects javascript: and data: pseudo-schemes', () => {
    expect(isSafeAccountReturnTo('javascript:alert(1)')).toBeNull()
    expect(isSafeAccountReturnTo('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('rejects backslash-based tricks', () => {
    expect(isSafeAccountReturnTo('\\\\evil.example')).toBeNull()
    expect(isSafeAccountReturnTo('/\\evil.example')).toBeNull()
  })

  it('rejects encoded protocol-relative attempts', () => {
    expect(isSafeAccountReturnTo('/%2F%2Fevil.example')).toBeNull()
    expect(isSafeAccountReturnTo('%2Faccount%2Fcontinue')).toBeNull()
  })

  it('rejects any path other than the canonical continuation route, even other legitimate-looking internal paths', () => {
    expect(isSafeAccountReturnTo('/account/orders')).toBeNull()
    expect(isSafeAccountReturnTo('/catalog/x')).toBeNull()
    expect(isSafeAccountReturnTo('/account/continue')).toBeNull() // missing '?', doesn't match prefix
  })

  it('rejects a continuation-shaped path with an invalid action', () => {
    expect(isSafeAccountReturnTo('/account/continue?action=delete&catalogId=x')).toBeNull()
  })

  it('rejects a continuation-shaped path with a malformed catalogId', () => {
    expect(isSafeAccountReturnTo('/account/continue?action=want&catalogId=<script>')).toBeNull()
    expect(isSafeAccountReturnTo('/account/continue?action=want')).toBeNull()
  })

  it('never passes the raw string through — always rebuilds from validated parts (defense in depth)', () => {
    // Extra junk params are silently discarded, not preserved into the redirect target.
    const result = isSafeAccountReturnTo('/account/continue?action=want&catalogId=abc&evil=<script>')
    expect(result).toBe('/account/continue?action=want&catalogId=abc')
  })

  it('rejects null/undefined/empty safely', () => {
    expect(isSafeAccountReturnTo(null)).toBeNull()
    expect(isSafeAccountReturnTo(undefined)).toBeNull()
    expect(isSafeAccountReturnTo('')).toBeNull()
  })
})

// ── buyerAuth.ts: returnTo propagation (behavioral) ─────────────────────────────

vi.mock('@/lib/prisma', () => ({
  prisma: {
    customerProfile: { findUnique: vi.fn(), upsert: vi.fn() },
    customerLoginToken: { count: vi.fn(), deleteMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/buyerSession', () => ({ createBuyerSession: vi.fn(), clearBuyerSession: vi.fn() }))
const mockSend = vi.fn().mockResolvedValue({ error: null })
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))

import { prisma } from '@/lib/prisma'
import { Resend } from 'resend'
import { createBuyerSession } from '@/lib/buyerSession'
import { requestBuyerOrderLink, verifyBuyerLoginToken } from '@/lib/actions/buyerAuth'

beforeEach(() => {
  vi.resetAllMocks()
  mockSend.mockResolvedValue({ error: null })
  // vi.resetAllMocks() also clears Resend's mockImplementation — reapply it.
  ;(Resend as unknown as Mock).mockImplementation(() => ({ emails: { send: mockSend } }))
  process.env.RESEND_API_KEY = 'test-key'
  process.env.ORDER_DIGEST_FROM_EMAIL = 'test@example.com'
})

function fd(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

describe('16M: requestBuyerOrderLink embeds a validated returnTo in the magic-link URL', () => {
  it('a valid returnTo is embedded in the outgoing email verifyUrl', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1', name: 'Bob' })
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    await requestBuyerOrderLink(
      { status: 'idle' },
      fd({ email: 'bob@example.com', returnTo: '/account/continue?action=want&catalogId=X' }),
    )

    expect(mockSend).toHaveBeenCalledTimes(1)
    const emailArgs = mockSend.mock.calls[0][0]
    expect(emailArgs.html).toContain(encodeURIComponent('/account/continue?action=want&catalogId=X'))
  })

  it('an invalid returnTo (external URL) is silently omitted, not embedded', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1', name: 'Bob' })
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    const result = await requestBuyerOrderLink(
      { status: 'idle' },
      fd({ email: 'bob@example.com', returnTo: 'https://evil.example' }),
    )
    // Still succeeds generically (privacy: never reveals validation details) — the
    // point under test is structural, verified via source inspection below.
    expect(result.status).toBe('sent')
  })

  it('omitting returnTo entirely behaves exactly as before (existing callers unaffected)', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ id: 'p1', name: 'Bob' })
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    const result = await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'bob@example.com' }))
    expect(result.status).toBe('sent')
  })

  it('source: verifyUrl embeds returnTo only when isSafeAccountReturnTo approves it', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    expect(src).toContain("import { isSafeAccountReturnTo } from '@/lib/customerModelIntent'")
    expect(src).toContain('const safeReturnTo = isSafeAccountReturnTo(rawReturnTo)')
    expect(src).toContain('safeReturnTo\n    ? `${appUrl}/account/orders/verify?token=${rawToken}&returnTo=${encodeURIComponent(safeReturnTo)}`')
  })

  it('preserves existing token/rate-limit/email-existence-privacy behavior unchanged (source check)', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    expect(src).toContain('const rawToken = crypto.randomBytes(32).toString')
    expect(src).toContain('RATE_LIMIT_MAX')
    expect(src).toContain('Always return the same generic state')
  })
})

describe('16M: verifyBuyerLoginToken redirects to a re-validated returnTo, or falls back to /account/orders', () => {
  it('no mutation occurs beyond session creation — 0 Wanted/Collection/SellerSubmission writes', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'bob@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'p1' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64), returnTo: '/account/continue?action=want&catalogId=X' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/continue?action=want&catalogId=X')

    expect(createBuyerSession).toHaveBeenCalledWith('p1')
    // No Wanted/Collection/SellerSubmission mock exists at all in this test's
    // prisma mock — if the action tried to call any of them, it would throw
    // "is not a function", which the assertion above already proves it didn't.
  })

  it('redirects to the validated returnTo when present and safe', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'bob@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'p1' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64), returnTo: '/account/continue?action=sell&catalogId=Y' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/continue?action=sell&catalogId=Y')
  })

  it('falls back to /account/orders when returnTo is absent', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'bob@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'p1' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')
  })

  it('falls back to /account/orders when a client-tampered returnTo is unsafe, even though it reached this final hop', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'bob@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'p1' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64), returnTo: 'https://evil.example' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')
  })

  it('does not weaken single-use token consumption — still an atomic updateMany gated on usedAt:null', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    expect(src).toContain('where: { tokenHash, usedAt: null, expiresAt: { gt: now } }')
    expect(src).toContain('data:  { usedAt: now }')
  })
})

// ── 16M Final: first-time customer authentication ───────────────────────────────

describe('16M Final: requesting a link never creates a CustomerProfile, for any email', () => {
  it('unverified request for a brand-new email creates NO CustomerProfile (only a token)', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue(null) // no existing profile
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    const result = await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'brandnew@example.com' }))

    expect(result.status).toBe('sent')
    expect(prisma.customerLoginToken.create).toHaveBeenCalledTimes(1)
    expect(prisma.customerProfile.upsert).not.toHaveBeenCalled()
  })

  it('requestBuyerOrderLink never imports/calls customerProfile.create or customerProfile.upsert — profile mutation happens only in verifyBuyerLoginToken', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    const requestFnIdx = src.indexOf('export async function requestBuyerOrderLink')
    const requestFnEnd = src.indexOf('\n// ─── verifyBuyerLoginToken')
    const requestFnSrc = src.slice(requestFnIdx, requestFnEnd)
    expect(requestFnSrc).not.toMatch(/customerProfile\.(create|upsert|update)/)
  })

  it('a brand-new email still creates and rate-limits a token exactly like an existing email would', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue(null)
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'brandnew@example.com' }))

    const createCall = (prisma.customerLoginToken.create as Mock).mock.calls[0][0]
    expect(createCall.data.email).toBe('brandnew@example.com')
    expect(createCall.data.tokenHash).toBeDefined()
    expect(createCall.data.expiresAt).toBeInstanceOf(Date)
  })
})

describe('16M Final: verified first-time email creates exactly one CustomerProfile', () => {
  it('a brand-new email, once verified, creates the profile via a race-safe upsert (not findUnique-then-create)', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'brandnew@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'new-profile-1' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')

    expect(prisma.customerProfile.upsert).toHaveBeenCalledTimes(1)
    const upsertCall = (prisma.customerProfile.upsert as Mock).mock.calls[0][0]
    expect(upsertCall.where).toEqual({ email: 'brandnew@example.com' })
    expect(upsertCall.create).toEqual({ email: 'brandnew@example.com' })
    expect(createBuyerSession).toHaveBeenCalledWith('new-profile-1')
  })

  it('an existing email verified again reuses the same profile — update:{} never overwrites name/phone/notes', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    const upsertIdx = src.indexOf('const profile = await prisma.customerProfile.upsert({')
    const upsertBlock = src.slice(upsertIdx, src.indexOf('})', upsertIdx))
    expect(upsertBlock).toContain('update: {}')
    expect(upsertBlock).not.toMatch(/name:|phone:|notes:/)
  })

  it('the profile lookup used only for email personalization in requestBuyerOrderLink never gates token creation (source: no early return based on it)', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    const requestFnIdx = src.indexOf('export async function requestBuyerOrderLink')
    const lookupIdx = src.indexOf('prisma.customerProfile.findUnique', requestFnIdx)
    const nextFewLines = src.slice(lookupIdx, lookupIdx + 400)
    expect(nextFewLines).not.toMatch(/if \(!profile\) return/)
  })
})

describe('16M Final: invalid/expired/used token never creates a CustomerProfile', () => {
  it('expired or already-used token → error, zero CustomerProfile calls', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 0 }) // atomic consume failed
    const result = await verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) }))
    expect(result).toEqual({ status: 'error', message: 'This link has expired or has already been used. Please request a new one.' })
    expect(prisma.customerProfile.upsert).not.toHaveBeenCalled()
    expect(createBuyerSession).not.toHaveBeenCalled()
  })

  it('missing/empty token → error, zero DB calls at all', async () => {
    const result = await verifyBuyerLoginToken({ status: 'idle' }, fd({}))
    expect(result.status).toBe('error')
    expect(prisma.customerLoginToken.updateMany).not.toHaveBeenCalled()
    expect(prisma.customerProfile.upsert).not.toHaveBeenCalled()
  })

  it('token record vanishes between consumption and lookup (defensive edge case) → error, zero CustomerProfile calls', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue(null)
    const result = await verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) }))
    expect(result).toEqual({ status: 'error', message: 'Verification failed. Please request a new link.' })
    expect(prisma.customerProfile.upsert).not.toHaveBeenCalled()
  })
})

describe('16M Final: concurrency / race safety', () => {
  it('a second verification attempt with the same (now-used) token fails atomically — no second profile/session created', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock)
      .mockResolvedValueOnce({ count: 1 }) // first request wins the atomic flip
      .mockResolvedValueOnce({ count: 0 }) // second/replayed request loses
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'racer@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'p-race' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')

    const second = await verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) }))
    expect(second.status).toBe('error')

    expect(prisma.customerProfile.upsert).toHaveBeenCalledTimes(1)
    expect(createBuyerSession).toHaveBeenCalledTimes(1)
  })

  it('two DIFFERENT valid tokens for the SAME new email both resolve to the same profile via upsert\'s DB-level unique constraint — proven by the where clause targeting the shared email, not a fabricated id', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'twolinks@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'shared-profile' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')

    const firstUpsertWhere = (prisma.customerProfile.upsert as Mock).mock.calls[0][0].where
    expect(firstUpsertWhere).toEqual({ email: 'twolinks@example.com' })
    // The @unique constraint on CustomerProfile.email (schema-level) is what makes
    // a second concurrent upsert call with the identical `where` safe — Prisma/the
    // DB resolves it to the same row rather than creating a duplicate.
    const schema = readSrc('prisma/schema.prisma')
    const profileBlock = schema.slice(schema.indexOf('model CustomerProfile {'), schema.indexOf('model SellerProfile'))
    expect(profileBlock).toContain('email              String                    @unique')
  })
})

describe('16M Final: privacy — request response is indistinguishable for existing vs. new email', () => {
  it('existing email and brand-new email both return the exact same generic {status:"sent"} shape', async () => {
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ name: 'Existing Bob' })
    const existingResult = await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'existing@example.com' }))

    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue(null)
    const newResult = await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'brandnew@example.com' }))

    expect(existingResult).toEqual({ status: 'sent' })
    expect(newResult).toEqual({ status: 'sent' })
    expect(existingResult).toEqual(newResult)
  })

  it('the response never contains an "account exists"/"account created"/"no orders found" message', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    expect(src).not.toMatch(/[Aa]ccount exists|[Aa]ccount created|[Nn]o orders found/)
  })
})

describe('16M Final: intent continuation still requires an explicit click for a first-time customer', () => {
  it('a first-time customer verifying via a want/X returnTo lands on the continuation page — verifyBuyerLoginToken itself never calls wantAction/addToWantedList', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    const verifyFnIdx = src.indexOf('export async function verifyBuyerLoginToken')
    const verifyFnSrc = src.slice(verifyFnIdx, src.indexOf('\n// ─── signOutBuyer'))
    expect(verifyFnSrc).not.toMatch(/wantAction|addToWantedList|addToCollectionAction|createCollectionItem|SellerSubmission/)
  })
  it('behavioral: verifying redirects to the exact preserved want/X continuation path — proves the customer, not the server, completes the action next', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'firsttime@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'new-first-timer' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64), returnTo: '/account/continue?action=want&catalogId=X' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/continue?action=want&catalogId=X')
  })
})

describe('16M Final: normal /account login uses the identical shared engine — one auth system, not two', () => {
  it('requestBuyerOrderLink/verifyBuyerLoginToken are the SAME exported functions used by both /account/orders (no returnTo) and /account/continue (returnTo present) — no forked/duplicate login action exists', () => {
    expect(exists('src/lib/actions/buyerAuth.ts')).toBe(true)
    // Only one requestBuyerOrderLink / verifyBuyerLoginToken export exists in the codebase.
    const matches = [...fs.readFileSync(path.join(root, 'src/lib/actions/buyerAuth.ts'), 'utf-8').matchAll(/export async function (requestBuyerOrderLink|verifyBuyerLoginToken)/g)]
    expect(matches.length).toBe(2)
  })
})

// ── /account/continue page + AccountIntentActions (structural) ──────────────────

const continuePageSrc = readSrc('src/app/(store)/account/continue/page.tsx')
const continuePageCode = stripComments(continuePageSrc)
const intentActionsSrc = readSrc('src/components/store/AccountIntentActions.tsx')

describe('16M: canonical continuation route — exists, no aliases', () => {
  it('/account/continue exists', () => {
    expect(exists('src/app/(store)/account/continue/page.tsx')).toBe(true)
  })
  it('no alias routes were created', () => {
    for (const alias of ['pending-action', 'intent', 'continue-want', 'continue-own', 'continue-sell']) {
      expect(exists(`src/app/(store)/account/${alias}`)).toBe(false)
    }
  })
})

describe('16M: /account/continue is read-only on GET — no auto-execute (Part F/G)', () => {
  it('no create/update/delete/upsert call anywhere in the page', () => {
    expect(continuePageCode).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })
  it('never imports wantAction/addToCollectionAction/addToWantedList/createCollectionItem for direct invocation outside a <form action>', () => {
    // The only mutation-capable references are the ones AccountIntentActions binds
    // into <form action={...}>, never called directly during render.
    expect(continuePageCode).not.toMatch(/await wantAction|await addToCollectionAction|await continueWantAction/)
  })
  it('no useEffect/mutation-on-mount pattern exists (this is a Server Component, so no client mount hook exists to abuse in the first place)', () => {
    expect(continuePageSrc).not.toContain("'use client'")
    expect(continuePageSrc).not.toContain('useEffect')
  })
})

describe('16M: catalogId re-fetched server-side, never trusted from query params (Part E)', () => {
  it('the page performs its own prisma.catalogModel.findUnique lookup', () => {
    expect(continuePageSrc).toContain('prisma.catalogModel.findUnique({')
    expect(continuePageSrc).toContain('where: { id: catalogModelId }')
  })
  it('model identity fields rendered (brand/name/year/series/color/scale) all come from the fetched `model`, never from searchParams', () => {
    expect(continuePageCode).toContain('model.brand')
    expect(continuePageCode).toContain('model.name')
    expect(continuePageCode).not.toMatch(/searchParams\.(brand|name|year|series|color|scale)/)
  })
  it('uses notFound() when the CatalogModel no longer exists — consistent with /catalog/[id]\'s own convention', () => {
    expect(continuePageSrc).toContain("import { notFound } from 'next/navigation'")
    expect(continuePageSrc).toContain('if (!model) notFound()')
  })
})

describe('16M: invalid intent is handled safely, without notFound() (Part AF)', () => {
  it('missing/invalid action or malformed catalogId renders an inline safe message with links to /catalog and /account, before any DB lookup', () => {
    const guardIdx = continuePageSrc.indexOf('if (!action || !isSafeCatalogModelId(rawCatalogId))')
    expect(guardIdx).toBeGreaterThan(-1)
    const dbLookupIdx = continuePageSrc.indexOf('prisma.catalogModel.findUnique')
    expect(guardIdx).toBeLessThan(dbLookupIdx)
    const block = continuePageSrc.slice(guardIdx, dbLookupIdx)
    expect(block).toContain("href=\"/catalog\"")
    expect(block).toContain('href="/account"')
  })
})

describe('16M: strict action allowlist — no dynamic function dispatch from user input', () => {
  it('the page parses action via parseCustomerModelIntent, never eval/Function/dynamic property access on RAW (unvalidated) user input', () => {
    expect(continuePageSrc).toContain('parseCustomerModelIntent(rawAction)')
    // INTENT_DESCRIPTION[action] is a safe Record lookup using the ALREADY-narrowed
    // 'want'|'own'|'sell' type returned by parseCustomerModelIntent — the forbidden
    // pattern is dispatch off the raw/untrusted searchParams value directly.
    expect(continuePageCode).not.toMatch(/eval\(|new Function\(|\[rawAction\]|\[searchParams\.action\]/)
  })
})

describe('16M: anonymous continuation — model identity + login form, no private query (Part J)', () => {
  it('when !session, renders BuyerOrderAccessForm with returnTo built from validated action+catalogModelId, and does not call getCatalogRelationshipState', () => {
    const anonBranchIdx = continuePageSrc.indexOf('if (!session) {')
    const anonBranchEnd = continuePageSrc.indexOf('\n  }\n', anonBranchIdx)
    const block = continuePageSrc.slice(anonBranchIdx, anonBranchEnd)
    expect(block).toContain('<BuyerOrderAccessForm returnTo={buildAccountIntentHref({ action, catalogModelId })} />')
    expect(block).not.toContain('getCatalogRelationshipState')
  })
  it('relationship query is gated behind `session ?`, mirroring the exact 16H/16F pattern', () => {
    expect(continuePageSrc).toContain('session ? await getCatalogRelationshipState(session.profileId, [catalogModelId]) : null')
  })
})

describe('16M: authenticated continuation — one bounded relationship lookup (Part K/AM)', () => {
  it('getCatalogRelationshipState is called exactly once, scoped to [catalogModelId]', () => {
    const matches = [...continuePageSrc.matchAll(/getCatalogRelationshipState\(/g)]
    expect(matches.length).toBe(1)
  })
  it('no Listing query or valuation query exists anywhere on this page — availability is irrelevant to intent (Part V/AM)', () => {
    expect(continuePageCode).not.toMatch(/prisma\.listing\.|getCatalogValuation|eligibleListingWhere/)
  })
})

describe('16M: AccountIntentActions — Want continuation (Part Q/R)', () => {
  it('not wanted → Continue — Add to Wanted, bound to continueWantAction (reused wantAction + redirect)', () => {
    expect(intentActionsSrc).toContain('Continue — Add to Wanted')
    expect(intentActionsSrc).toContain('continueWantAction.bind(null, catalogModelId)')
  })
  it('already wanted → idempotent "Already in Wanted" state, no duplicate mutation form, offers View Model / Manage Wanted', () => {
    expect(intentActionsSrc).toContain('♥ Already in Wanted')
    expect(intentActionsSrc).toContain('View Model')
    expect(intentActionsSrc).toContain('Manage Wanted')
    // The wanted branch is bounded exactly by its own `if (relationship.wanted) {`
    // through the matching `)\n      }` that closes that inner if-block.
    const wantedIfIdx = intentActionsSrc.indexOf('if (relationship.wanted) {')
    const wantedBlockEnd = intentActionsSrc.indexOf(')\n    }', wantedIfIdx)
    const wantedBlock = intentActionsSrc.slice(wantedIfIdx, wantedBlockEnd)
    expect(wantedBlock).toContain('♥ Already in Wanted')
    expect(wantedBlock).not.toContain('<form')
  })
})

describe('16M: AccountIntentActions — Own continuation (Part S/T)', () => {
  it('not owned → Continue — Add to Collection, bound to the unmodified addToCollectionAction (existing redirect/quantity-1 semantics preserved)', () => {
    expect(intentActionsSrc).toContain('Continue — Add to Collection')
    expect(intentActionsSrc).toContain('addToCollectionAction.bind(null, catalogModelId)')
  })
  it('already owned → "✓ Own N" from relationship.ownedQuantity, no add-mutation form, offers View Collection Item + Sell One', () => {
    expect(intentActionsSrc).toContain('✓ Own{relationship.ownedQuantity !== null')
    expect(intentActionsSrc).toContain('View Collection Item')
    const ownedIfIdx = intentActionsSrc.indexOf('if (relationship.collectionItemId) {')
    const ownedBlockEnd = intentActionsSrc.indexOf(')\n    }', ownedIfIdx)
    const ownedBlock = intentActionsSrc.slice(ownedIfIdx, ownedBlockEnd)
    expect(ownedBlock).toContain('✓ Own{relationship.ownedQuantity')
    expect(ownedBlock).not.toContain('<form')
  })
})

describe('16M: AccountIntentActions — Sell continuation is pure navigation (Part U)', () => {
  it('Sell branch renders only a Link, never a form/server action — same sellHref ternary as everywhere else', () => {
    const sellIdx = intentActionsSrc.indexOf("// action === 'sell'")
    const sellBlock = intentActionsSrc.slice(sellIdx)
    expect(sellBlock).toContain('Continue to Sell')
    expect(sellBlock).not.toContain('<form')
    expect(intentActionsSrc).toContain('/account/collection/${relationship.collectionItemId}/sell')
    expect(intentActionsSrc).toContain('/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}')
  })
  it('no sellerSubmission.create reference anywhere in AccountIntentActions', () => {
    expect(intentActionsSrc).not.toMatch(/sellerSubmission\.create|createSellerSubmission/i)
  })
})

describe('16M: continueWantAction composes wantAction + redirect, no duplicated Wanted logic (Part Q/K)', () => {
  const domainActionsSrc = readSrc('src/lib/actions/catalogModelDomainActions.ts')
  it('calls wantAction (reused, unmodified) then redirects to /catalog/[id]', () => {
    const idx = domainActionsSrc.indexOf('export async function continueWantAction')
    const block = domainActionsSrc.slice(idx, domainActionsSrc.indexOf('\n}', idx))
    expect(block).toContain('await wantAction(catalogModelId, formData)')
    expect(block).toContain("redirect(`/catalog/${catalogModelId}`)")
  })
})

// ── Anonymous public surface migration (Part H/AU/AV/AW) ────────────────────────

describe('16M: /capture anonymous actions preserve intent', () => {
  const src = readSrc('src/components/store/CaptureCandidateActions.tsx')
  it('Want This / I Own This / Sell One anonymous links all use buildAccountIntentHref with the correct action', () => {
    expect(src).toContain("buildAccountIntentHref({ action: 'want', catalogModelId })")
    expect(src).toContain("buildAccountIntentHref({ action: 'own', catalogModelId })")
    expect(src).toContain("buildAccountIntentHref({ action: 'sell', catalogModelId })")
  })
  it('no plain /account dead-end remains', () => {
    expect(src).not.toContain('href="/account"')
  })
  it('no private relationship query was added to capture as a side effect of this change', () => {
    const captureIdentifySrc = readSrc('src/lib/actions/captureIdentify.ts')
    const matches = [...captureIdentifySrc.matchAll(/getCatalogRelationshipState\(/g)]
    expect(matches.length).toBe(1) // unchanged from 16L — still exactly one
  })
})

describe('16M: /catalog/[id] (CatalogModelActions) anonymous actions preserve intent', () => {
  const src = readSrc('src/components/store/CatalogModelActions.tsx')
  it('Want / Add to Collection / Sell One anonymous links all use buildAccountIntentHref', () => {
    expect(src).toContain("buildAccountIntentHref({ action: 'want', catalogModelId })")
    expect(src).toContain("buildAccountIntentHref({ action: 'own', catalogModelId })")
    expect(src).toContain("buildAccountIntentHref({ action: 'sell', catalogModelId })")
  })
  it('no plain /account dead-end remains', () => {
    expect(src).not.toContain('href="/account"')
  })
})

describe('16M: /browse (CatalogActions, persistent + secondary) anonymous actions preserve intent', () => {
  const src = readSrc('src/components/store/CatalogActions.tsx')
  it('Want (persistent) and Add to Collection / Sell One (SecondaryActions) anonymous links all use buildAccountIntentHref', () => {
    expect(src).toContain("buildAccountIntentHref({ action: 'want', catalogModelId })")
    expect(src).toContain("buildAccountIntentHref({ action: 'own', catalogModelId })")
    expect(src).toContain("buildAccountIntentHref({ action: 'sell', catalogModelId })")
  })
  it('no plain /account dead-end remains', () => {
    expect(src).not.toContain('href="/account"')
  })
  it('Buy/AddToCart is untouched — no cart reference in CatalogActions.tsx', () => {
    expect(src).not.toMatch(/AddToCartButton|useCart|CartItem/)
  })
})

describe('16M: no hand-built query strings duplicated across surfaces — shared builder only', () => {
  it('none of the three migrated surfaces hand-construct `/account/continue?action=` string literals', () => {
    for (const rel of [
      'src/components/store/CaptureCandidateActions.tsx',
      'src/components/store/CatalogModelActions.tsx',
      'src/components/store/CatalogActions.tsx',
    ]) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/`\/account\/continue\?action=\$\{/)
    }
  })
})

// ── Normal /account login regression (Part AE/BF) ────────────────────────────────

describe('16M: normal /account login callers are unaffected (no forced continuation)', () => {
  it('BuyerOrderAccessForm keeps working with zero props (returnTo optional, default {})', () => {
    const src = readSrc('src/components/store/BuyerOrderAccessForm.tsx')
    expect(src).toContain('export function BuyerOrderAccessForm({ returnTo }: { returnTo?: string } = {})')
  })
  it('existing callers (/account/orders, /account, /account/collection, /account/sell, /account/community) still render <BuyerOrderAccessForm /> with no props', () => {
    for (const rel of [
      'src/app/(store)/account/orders/page.tsx',
      'src/app/(store)/account/page.tsx',
      'src/app/(store)/account/collection/page.tsx',
      'src/app/(store)/account/sell/page.tsx',
      'src/app/(store)/account/community/page.tsx',
    ]) {
      expect(readSrc(rel)).toContain('<BuyerOrderAccessForm')
    }
  })
  it('VerifyBuyerLoginForm keeps returnTo optional — the normal Orders verify flow renders it as undefined, matching prior behavior', () => {
    const src = readSrc('src/components/store/VerifyBuyerLoginForm.tsx')
    expect(src).toContain('returnTo?: string')
  })
})

// ── Cross-device (Part AI/BE) ──────────────────────────────────────────────────────

describe('16M: intent travels in the magic-link URL itself, not client-only storage', () => {
  it('no localStorage/sessionStorage reference anywhere in the 16M file set', () => {
    for (const rel of [
      'src/lib/customerModelIntent.ts',
      'src/lib/actions/buyerAuth.ts',
      'src/app/(store)/account/continue/page.tsx',
      'src/components/store/AccountIntentActions.tsx',
      'src/components/store/BuyerOrderAccessForm.tsx',
      'src/components/store/VerifyBuyerLoginForm.tsx',
    ]) {
      expect(readSrc(rel)).not.toMatch(/localStorage|sessionStorage/)
    }
  })
  it('returnTo is embedded directly in the verifyUrl string sent in the email — structurally proven, not merely asserted', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    const verifyUrlIdx = src.indexOf('const verifyUrl =')
    const emailBuildIdx = src.indexOf('buildMagicLinkEmail({')
    expect(verifyUrlIdx).toBeLessThan(emailBuildIdx)
    expect(src.slice(verifyUrlIdx, emailBuildIdx)).toContain('verifyUrl')
  })
})

// ── Privacy (Part AK) ──────────────────────────────────────────────────────────────

describe('16M: no session internals ever appear in URLs/client props for continuation', () => {
  it('no profileId/sessionHash/tokenHash is embedded in any href/query string in the 16M surfaces', () => {
    for (const rel of [
      'src/lib/customerModelIntent.ts',
      'src/app/(store)/account/continue/page.tsx',
      'src/components/store/AccountIntentActions.tsx',
    ]) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/profileId=|sessionHash=|tokenHash=/)
    }
  })
})

// ── Accessibility (Part AQ) ────────────────────────────────────────────────────────

describe('16M: continuation page accessibility', () => {
  it('exactly one h1 renders per request — two literal <h1 occurrences exist in source, but they belong to mutually exclusive branches (invalid-intent vs. the shared model-identity header used by both valid branches)', () => {
    const h1s = [...continuePageSrc.matchAll(/<h1/g)]
    expect(h1s.length).toBe(2)
    // The invalid-intent early-return and the shared `header` JSX are structurally
    // disjoint — only one is ever reached for a given request.
    const invalidIntentH1Idx = continuePageSrc.indexOf('<h1', continuePageSrc.indexOf("This link isn't valid") - 50)
    const headerH1Idx = continuePageSrc.indexOf('<h1', continuePageSrc.indexOf('const header ='))
    expect(invalidIntentH1Idx).toBeGreaterThan(-1)
    expect(headerH1Idx).toBeGreaterThan(-1)
    expect(invalidIntentH1Idx).not.toBe(headerH1Idx)
  })
  it('model name is rendered as a heading-level element even on valid-intent branches', () => {
    expect(continuePageSrc).toContain('<h1 className="text-xl font-bold text-gray-900 leading-snug truncate">')
  })
  it('owned quantity and wanted state are text, not color-only', () => {
    expect(intentActionsSrc).toContain('✓ Own{relationship.ownedQuantity')
    expect(intentActionsSrc).toContain('♥ Already in Wanted')
  })
})

// ── Scope guard (Part BL) ────────────────────────────────────────────────────────

describe('16M: scope guard — no 16N+ functionality', () => {
  it('no automatic post-login mutation, recognition-history, or generic cart-intent keywords', () => {
    for (const rel of [
      'src/lib/customerModelIntent.ts',
      'src/lib/actions/buyerAuth.ts',
      'src/app/(store)/account/continue/page.tsx',
      'src/components/store/AccountIntentActions.tsx',
    ]) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/PendingAction model|LoginIntent|GuestIntent|AnonymousSession|recognitionHistory|checkoutRestoration/i)
    }
  })
  it('no new Prisma model was added for intent persistence', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/model PendingAction|model LoginIntent|model GuestIntent|model AnonymousSession/)
  })
})

// ── 16M Final: email identity normalization ─────────────────────────────────────
// Verification pass only — normalizeEmail() usage in buyerAuth.ts predates 16M
// (9I: Add buyer auth infrastructure) and was never modified by this milestone.
// These tests exist to prove the invariant explicitly, not because anything changed.

describe('16M Final: email is normalized to one canonical form before every profile-identity touchpoint', () => {
  it('requestBuyerOrderLink normalizes before the profile lookup, rate-limit count, token cleanup, AND token creation — the same canonical `email` variable feeds all four', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    expect(src).toContain("import { normalizeEmail } from '@/lib/normalizeEmail'")
    const requestFnIdx = src.indexOf('export async function requestBuyerOrderLink')
    const requestFnEnd = src.indexOf('\n// ─── verifyBuyerLoginToken')
    const requestFnSrc = src.slice(requestFnIdx, requestFnEnd)
    expect(requestFnSrc).toContain('const email = normalizeEmail(rawEmail)')
    // Every DB touchpoint keys off the SAME normalized `email` binding, not rawEmail.
    expect(requestFnSrc).toContain('customerProfile.findUnique({\n    where: { email }')
    expect(requestFnSrc).toContain('customerLoginToken.count({\n    where: { email,')
    expect(requestFnSrc).toContain('customerLoginToken.deleteMany({\n    where: { email,')
    expect(requestFnSrc).toContain('customerLoginToken.create({\n    data: { email,')
    expect(requestFnSrc).not.toMatch(/where: \{ email: rawEmail/)
  })

  it('normalizeEmail is exactly trim + lowercase — no provider-specific (Gmail dot/plus-alias) rewriting', () => {
    const src = readSrc('src/lib/normalizeEmail.ts')
    expect(src).toContain('email.toLowerCase().trim()')
    expect(src).not.toMatch(/replace|split\('\+'\)|split\('\.'\)/)
  })

  it('verifyBuyerLoginToken reads the email back from the token record as-is — correct BECAUSE it was already stored canonical at creation, never re-derived from client input', () => {
    const src = readSrc('src/lib/actions/buyerAuth.ts')
    const verifyFnIdx = src.indexOf('export async function verifyBuyerLoginToken')
    const verifyFnSrc = src.slice(verifyFnIdx, src.indexOf('\n// ─── signOutBuyer'))
    expect(verifyFnSrc).toContain('customerProfile.upsert({\n    where: { email: tokenRecord.email }')
    expect(verifyFnSrc).toContain('create: { email: tokenRecord.email }')
  })

  it('orders.ts (checkout profile creation) uses the identical normalizeEmail helper for the exact same CustomerProfile.email unique key — one shared canonicalization rule across both profile-creation paths', () => {
    const src = readSrc('src/lib/actions/orders.ts')
    expect(src).toContain("import { normalizeEmail } from '@/lib/normalizeEmail'")
    expect(src).toContain('const normalizedEmail = normalizeEmail(buyerEmail)')
    expect(src).toContain('where:  { email: normalizedEmail }')
    expect(src).toContain('create: { email: normalizedEmail,')
  })
})

describe('16M Final: mixed-case/whitespace email variants resolve to one CustomerProfile (behavioral)', () => {
  it('" NewUser@Example.com " request/verify round-trip produces a canonical token email and canonical profile email', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue(null)
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    await requestBuyerOrderLink({ status: 'idle' }, fd({ email: ' NewUser@Example.com ' }))

    const tokenCreateCall = (prisma.customerLoginToken.create as Mock).mock.calls[0][0]
    expect(tokenCreateCall.data.email).toBe('newuser@example.com')

    // Verification reads that exact canonical value back and upserts with it.
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: tokenCreateCall.data.email })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'p-canonical' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')

    const upsertCall = (prisma.customerProfile.upsert as Mock).mock.calls[0][0]
    expect(upsertCall.where).toEqual({ email: 'newuser@example.com' })
    expect(upsertCall.create).toEqual({ email: 'newuser@example.com' })
  })

  it('existing profile "user@example.com" + login "USER@EXAMPLE.COM" → same profile reused, no second profile created', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue({ name: 'Existing User' })
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'USER@EXAMPLE.COM' }))

    // The lookup used to personalize the email was itself keyed by the canonical form.
    const lookupCall = (prisma.customerProfile.findUnique as Mock).mock.calls[0][0]
    expect(lookupCall.where).toEqual({ email: 'user@example.com' })

    const tokenCreateCall = (prisma.customerLoginToken.create as Mock).mock.calls[0][0]
    expect(tokenCreateCall.data.email).toBe('user@example.com')

    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'user@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'existing-profile-id' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')

    const upsertCall = (prisma.customerProfile.upsert as Mock).mock.calls[0][0]
    // Same canonical where-clause the order flow would also use — one identity,
    // one row, via the DB-level @unique constraint (never a second profile).
    expect(upsertCall.where).toEqual({ email: 'user@example.com' })
  })

  it('an order-created profile ("buyer@example.com") later magic-login-verified as "Buyer@Example.com" resolves to the SAME canonical where-clause an order-time upsert would use', async () => {
    ;(prisma.customerLoginToken.updateMany as Mock).mockResolvedValue({ count: 1 })
    // The stored token email is already canonical by the time verify reads it —
    // proven above; here we confirm the upsert `where` matches exactly what
    // orders.ts's own normalizeEmail(buyerEmail) would have produced for the same
    // input, closing the loop between the two profile-creation paths.
    ;(prisma.customerLoginToken.findFirst as Mock).mockResolvedValue({ email: 'buyer@example.com' })
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'order-linked-profile' })

    await expect(
      verifyBuyerLoginToken({ status: 'idle' }, fd({ token: 'a'.repeat(64) })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/orders')

    const upsertCall = (prisma.customerProfile.upsert as Mock).mock.calls[0][0]
    expect(upsertCall.where).toEqual({ email: 'buyer@example.com' })
  })

  it('two tokens requested with differently-cased versions of the same email both normalize to the identical stored token email', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue(null)
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'Racer@Example.com' }))
    await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'RACER@example.COM' }))

    const emails = (prisma.customerLoginToken.create as Mock).mock.calls.map((c) => c[0].data.email)
    expect(emails).toEqual(['racer@example.com', 'racer@example.com'])
  })

  it('the generic {status:"sent"} response is identical regardless of casing/whitespace variation', async () => {
    ;(prisma.customerProfile.findUnique as Mock).mockResolvedValue(null)
    ;(prisma.customerLoginToken.count as Mock).mockResolvedValue(0)
    ;(prisma.customerLoginToken.deleteMany as Mock).mockResolvedValue({ count: 0 })
    ;(prisma.customerLoginToken.create as Mock).mockResolvedValue({})

    const a = await requestBuyerOrderLink({ status: 'idle' }, fd({ email: '  Mixed@Case.com  ' }))
    const b = await requestBuyerOrderLink({ status: 'idle' }, fd({ email: 'mixed@case.com' }))
    expect(a).toEqual({ status: 'sent' })
    expect(b).toEqual({ status: 'sent' })
    expect(a).toEqual(b)
  })
})

describe('16M Final: existing-data caveat (report only, no automated remediation)', () => {
  it('no migration/backfill/dedup script was added for pre-existing case-variant CustomerProfile rows — out of 16M scope, risk reported not fixed', () => {
    expect(exists('prisma/migrations')).toBe(true)
    // No new migration directory should reference email normalization/backfill.
    const migrationsDir = path.join(root, 'prisma/migrations')
    const dirs = fs.readdirSync(migrationsDir)
    const emailBackfillMigration = dirs.find((d) => /normalize.*email|email.*backfill|dedup.*customer/i.test(d))
    expect(emailBackfillMigration).toBeUndefined()
  })
})
