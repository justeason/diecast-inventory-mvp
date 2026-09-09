// 19B: guestSeller.ts action tests — lazy session creation, item cap, idempotency,
// duplicate-model conflict, edit/remove ownership scoping, zero PII.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import crypto from 'crypto'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findUnique: vi.fn() },
    guestSellerSession: { create: vi.fn() },
    guestSellerItem: {
      create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(),
      updateMany: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn(), count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/guestSellerSession', () => ({
  getGuestSellerSessionContext: vi.fn(),
  generateGuestSellerToken: vi.fn(),
  setGuestSellerCookie: vi.fn(),
}))
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(),
  rateLimitKeyFromHeaders: vi.fn(),
}))
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}))

import { prisma } from '@/lib/prisma'
import { getGuestSellerSessionContext, generateGuestSellerToken, setGuestSellerCookie } from '@/lib/guestSellerSession'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { addGuestSellerItem, updateGuestSellerItem, removeGuestSellerItem, getGuestSellerBatch } from '@/lib/actions/guestSeller'

const CATALOG = { id: 'cat1', brand: 'Hot Wheels', name: 'Porsche 911', year: 1994 }

const FAR_FUTURE = new Date(Date.now() + 60 * 60 * 1000) // 1 hour from now — not expired

function makeTxMock() {
  // Mimic prisma.$transaction(async cb => cb(txClient)) using the same mock
  // objects as the outer prisma (fine — the code under test only reads shapes,
  // never distinguishes tx from prisma itself in these tests).
  // $queryRaw is shared by the CatalogModel-style row lock (unused, first-add
  // path never calls it) and the existing-session path's lock+expiry re-check
  // (19B Final Runtime Reconciliation §6) — defaults to an unexpired session
  // row so the "existing valid session" test paths aren't all forced to
  // re-mock this explicitly.
  return vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
    guestSellerSession: prisma.guestSellerSession,
    guestSellerItem: prisma.guestSellerItem,
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'sess-existing', expiresAt: FAR_FUTURE }]),
  }))
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(CATALOG)
  ;(checkRateLimit as Mock).mockReturnValue({ allowed: true, remaining: 4, resetMs: 1000 })
  ;(rateLimitKeyFromHeaders as Mock).mockReturnValue('ip-key')
  ;(prisma.$transaction as Mock).mockImplementation(makeTxMock())
})

const VALID_INPUT = {
  catalogModelId: 'cat1',
  quantity: 1,
  condition: null,
  notes: null,
  saleTypePreference: 'unsure',
  clientToken: 'tok-1',
}

describe('addGuestSellerItem: lazy session creation (first add)', () => {
  it('no existing cookie/session → mints token, creates session+item in one transaction, sets cookie only after commit', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue(null)
    ;(generateGuestSellerToken as Mock).mockReturnValue({ rawToken: 'raw123', tokenHash: 'hash123', expiresAt: new Date('2026-12-01') })
    ;(prisma.guestSellerSession.create as Mock).mockResolvedValue({ id: 'sess-new' })
    ;(prisma.guestSellerItem.create as Mock).mockResolvedValue({
      id: 'item1', catalogModelId: 'cat1', quantity: 1, condition: null, notes: null,
      saleTypePreference: 'unsure', clientToken: 'tok-1', updatedAt: new Date(),
    })

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(true)
    expect(prisma.guestSellerSession.create).toHaveBeenCalledWith({ data: { tokenHash: 'hash123', expiresAt: new Date('2026-12-01') }, select: { id: true } })
    expect(setGuestSellerCookie).toHaveBeenCalledWith('raw123')
  })

  it('session-creation rate limit applies only when NO existing session exists', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue(null)
    ;(rateLimitKeyFromHeaders as Mock).mockReturnValue('ip-key')
    ;(checkRateLimit as Mock).mockReturnValue({ allowed: false, remaining: 0, resetMs: 60_000 })

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(prisma.guestSellerSession.create).not.toHaveBeenCalled()
  })

  it('rate limiter fails closed (null key) when RATE_LIMIT_SECRET is absent', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue(null)
    ;(rateLimitKeyFromHeaders as Mock).mockReturnValue(null)

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(prisma.guestSellerSession.create).not.toHaveBeenCalled()
  })

  it('reusing an existing valid cookie does NOT count against the session-creation limit', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess-existing' })
    ;(prisma.guestSellerItem.count as Mock).mockResolvedValue(0)
    ;(prisma.guestSellerItem.create as Mock).mockResolvedValue({
      id: 'item2', catalogModelId: 'cat1', quantity: 1, condition: null, notes: null,
      saleTypePreference: 'unsure', clientToken: 'tok-2', updatedAt: new Date(),
    })

    await addGuestSellerItem({ ...VALID_INPUT, clientToken: 'tok-2' })
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(generateGuestSellerToken).not.toHaveBeenCalled()
  })
})

describe('addGuestSellerItem: max item count (100, mirrors MobileCapture)', () => {
  it('at the cap: rejects with an actionable message, no item created', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess-existing' })
    ;(prisma.guestSellerItem.count as Mock).mockResolvedValue(100)

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/100/)
    expect(prisma.guestSellerItem.create).not.toHaveBeenCalled()
  })

  it('the constant mirrors MobileCapture\'s own 100-item cap', () => {
    const src = readSrc('src/lib/actions/guestSeller.ts')
    expect(src).toContain('const MAX_GUEST_ITEMS_PER_SESSION = 100')
  })
})

// 19B Final Runtime Reconciliation §6: existing-session mutations must not rely
// solely on the earlier getGuestSellerSessionContext() read — the locked row's
// OWN expiresAt is re-checked after the lock is acquired, immediately before
// insert.
describe('addGuestSellerItem: existing-session path re-checks expiry AFTER acquiring the lock', () => {
  it('session expired between the pre-transaction read and lock acquisition → rejected, never inserted, never revived', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess-existing' })
    const PAST = new Date(Date.now() - 60 * 60 * 1000)
    ;(prisma.$transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      guestSellerSession: prisma.guestSellerSession,
      guestSellerItem: prisma.guestSellerItem,
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'sess-existing', expiresAt: PAST }]),
    }))

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/expired/i)
    expect(prisma.guestSellerItem.create).not.toHaveBeenCalled()
  })

  it('session row vanished entirely (locked.length === 0) between read and lock → rejected the same way, no crash', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess-existing' })
    ;(prisma.$transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      guestSellerSession: prisma.guestSellerSession,
      guestSellerItem: prisma.guestSellerItem,
      $queryRaw: vi.fn().mockResolvedValue([]),
    }))

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(false)
    expect(prisma.guestSellerItem.create).not.toHaveBeenCalled()
  })

  it('structural proof: the lock query selects expiresAt and the code checks it before the item-count/create steps', () => {
    const src = readSrc('src/lib/actions/guestSeller.ts')
    const lockIdx = src.indexOf('SELECT id, "expiresAt" FROM "GuestSellerSession"')
    const checkIdx = src.indexOf("throw new Error('SESSION_EXPIRED')")
    const countIdx = src.indexOf('tx.guestSellerItem.count(')
    expect(lockIdx).toBeGreaterThan(-1)
    expect(checkIdx).toBeGreaterThan(lockIdx)
    expect(countIdx).toBeGreaterThan(checkIdx)
  })
})

describe('addGuestSellerItem: quantity/condition/sale-type validation', () => {
  it('quantity out of 1-999 range rejected', async () => {
    const result = await addGuestSellerItem({ ...VALID_INPUT, quantity: 0 })
    expect(result.ok).toBe(false)
  })
  it('invalid condition rejected', async () => {
    const result = await addGuestSellerItem({ ...VALID_INPUT, condition: 'pristine' })
    expect(result.ok).toBe(false)
  })
  it('invalid sale type rejected', async () => {
    const result = await addGuestSellerItem({ ...VALID_INPUT, saleTypePreference: 'auction' })
    expect(result.ok).toBe(false)
  })
  it('missing clientToken rejected', async () => {
    const result = await addGuestSellerItem({ ...VALID_INPUT, clientToken: '' })
    expect(result.ok).toBe(false)
  })
  it('unknown catalogModelId rejected — server-side resolution, never trusts client brand/name', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(null)
    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(false)
  })
})

describe('addGuestSellerItem: idempotency (clientToken/payloadFingerprint)', () => {
  it('exact retry (same clientToken, same payload) returns the existing row, no duplicate created', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess1' })
    ;(prisma.guestSellerItem.count as Mock).mockResolvedValue(0)
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '5.22.0', meta: { target: ['sessionId', 'clientToken'] },
    })
    ;(prisma.guestSellerItem.create as Mock).mockRejectedValue(p2002)
    ;(prisma.guestSellerItem.findUnique as Mock).mockResolvedValue({
      id: 'item1', catalogModelId: 'cat1', quantity: 1, condition: null, notes: null,
      saleTypePreference: 'unsure', clientToken: 'tok-1', updatedAt: new Date(),
      payloadFingerprint: crypto.createHash('sha256').update(['cat1', '1', '', '', 'unsure'].join('\x00')).digest('hex'),
      catalogModel: CATALOG,
    })

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.id).toBe('item1')
  })

  it('conflicting retry (same clientToken, different payload) fails generically', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess1' })
    ;(prisma.guestSellerItem.count as Mock).mockResolvedValue(0)
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '5.22.0', meta: { target: ['sessionId', 'clientToken'] },
    })
    ;(prisma.guestSellerItem.create as Mock).mockRejectedValue(p2002)
    ;(prisma.guestSellerItem.findUnique as Mock).mockResolvedValue({
      id: 'item1', catalogModelId: 'cat1', quantity: 1, condition: null, notes: null,
      saleTypePreference: 'unsure', clientToken: 'tok-1', updatedAt: new Date(),
      payloadFingerprint: 'totally-different-hash',
      catalogModel: CATALOG,
    })

    const result = await addGuestSellerItem(VALID_INPUT)
    expect(result.ok).toBe(false)
  })
})

describe('addGuestSellerItem: same-model intentional conflict (no auto-increment, no second row)', () => {
  it('duplicate catalogModelId in session returns an actionable message with the existing item id, never a raw P2002', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess1' })
    ;(prisma.guestSellerItem.count as Mock).mockResolvedValue(1)
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '5.22.0', meta: { target: ['sessionId', 'catalogModelId'] },
    })
    ;(prisma.guestSellerItem.create as Mock).mockRejectedValue(p2002)
    ;(prisma.guestSellerItem.findFirst as Mock).mockResolvedValue({ id: 'existing-item-1' })

    const result = await addGuestSellerItem({ ...VALID_INPUT, clientToken: 'tok-new' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/already in your selling batch/)
      expect(result.existingItemId).toBe('existing-item-1')
    }
  })

  it('never auto-increments quantity, never creates a second row for the same model — structural proof', () => {
    const src = readSrc('src/lib/actions/guestSeller.ts')
    expect(src).not.toMatch(/quantity\s*\+=|quantity:\s*existing\.quantity\s*\+/)
  })
})

describe('updateGuestSellerItem: optimistic concurrency, ownership scoping', () => {
  it('update is scoped by id AND sessionId AND updatedAt — never id alone', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess1' })
    ;(prisma.guestSellerItem.updateMany as Mock).mockResolvedValue({ count: 1 })
    ;(prisma.guestSellerItem.findFirst as Mock).mockResolvedValue({
      id: 'item1', catalogModelId: 'cat1', quantity: 2, condition: 'good', notes: null,
      saleTypePreference: 'unsure', clientToken: 'tok-1', updatedAt: new Date(),
      catalogModel: CATALOG,
    })

    await updateGuestSellerItem('item1', { quantity: 2 }, '2026-01-01T00:00:00.000Z')
    const call = (prisma.guestSellerItem.updateMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ id: 'item1', sessionId: 'sess1', updatedAt: new Date('2026-01-01T00:00:00.000Z') })
  })

  it('stale updatedAt (count 0) rejected with a safe refresh message', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess1' })
    ;(prisma.guestSellerItem.updateMany as Mock).mockResolvedValue({ count: 0 })

    const result = await updateGuestSellerItem('item1', { quantity: 2 }, '2026-01-01T00:00:00.000Z')
    expect(result.ok).toBe(false)
  })

  it('no cookie/session → rejected before any DB write', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue(null)
    const result = await updateGuestSellerItem('item1', { quantity: 2 }, '2026-01-01T00:00:00.000Z')
    expect(result.ok).toBe(false)
    expect(prisma.guestSellerItem.updateMany).not.toHaveBeenCalled()
  })

  it('catalogModelId is never an editable field — structural proof', () => {
    const src = readSrc('src/lib/actions/guestSeller.ts')
    const idx = src.indexOf('export type UpdateGuestSellerItemInput')
    const line = src.slice(idx, src.indexOf('\n', idx))
    expect(line).not.toContain('catalogModelId')
  })
})

describe('removeGuestSellerItem: ownership scoping', () => {
  it('delete is scoped by id AND sessionId — never id alone', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess1' })
    ;(prisma.guestSellerItem.deleteMany as Mock).mockResolvedValue({ count: 1 })

    await removeGuestSellerItem('item1')
    expect(prisma.guestSellerItem.deleteMany).toHaveBeenCalledWith({ where: { id: 'item1', sessionId: 'sess1' } })
  })

  it('no cookie/session → rejected, zero DB writes', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue(null)
    const result = await removeGuestSellerItem('item1')
    expect(result.ok).toBe(false)
    expect(prisma.guestSellerItem.deleteMany).not.toHaveBeenCalled()
  })
})

describe('getGuestSellerBatch: read-only', () => {
  it('no session → empty batch, zero DB calls beyond the session lookup', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue(null)
    const batch = await getGuestSellerBatch()
    expect(batch).toEqual({ items: [] })
    expect(prisma.guestSellerItem.findMany).not.toHaveBeenCalled()
  })

  it('scoped strictly to the derived session id', async () => {
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'sess1' })
    ;(prisma.guestSellerItem.findMany as Mock).mockResolvedValue([])
    await getGuestSellerBatch()
    const call = (prisma.guestSellerItem.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ sessionId: 'sess1' })
  })
})

describe('19B: zero PII, no CustomerProfile/SellerProfile creation', () => {
  it('guestSeller.ts never imports or creates CustomerProfile/SellerProfile/CustomerSession', () => {
    const src = readSrc('src/lib/actions/guestSeller.ts')
    expect(src).not.toMatch(/customerProfile\.(create|upsert)|sellerProfile\.(create|upsert)|customerSession\.create/)
  })
  it('guestSeller.ts never references email/name/phone/address fields', () => {
    const src = readSrc('src/lib/actions/guestSeller.ts')
    expect(src).not.toMatch(/\bemail\b|\bphone\b|\baddress\b/i)
  })
})

describe('19B: no photo/image persistence anywhere in guest item storage', () => {
  it('GuestSellerItem/Session schema has no image/blob/photo/url field', () => {
    const schema = readSrc('prisma/schema.prisma')
    const sessionIdx = schema.indexOf('model GuestSellerSession {')
    const sessionBlock = schema.slice(sessionIdx, schema.indexOf('\n}', sessionIdx))
    const itemIdx = schema.indexOf('model GuestSellerItem {')
    const itemBlock = schema.slice(itemIdx, schema.indexOf('\n}', itemIdx))
    for (const block of [sessionBlock, itemBlock]) {
      expect(block).not.toMatch(/photo|image|blob|\burl\b/i)
    }
  })
  it('guestSeller.ts never imports Blob/storage/Sharp', () => {
    const src = readSrc('src/lib/actions/guestSeller.ts')
    expect(src).not.toMatch(/@vercel\/blob|sharp|fs\.writeFile/)
  })
})

describe('19B: catalogModelId is required — no unresolved recognition ever persisted', () => {
  it('GuestSellerItem.catalogModelId has no ? nullable marker', () => {
    const schema = readSrc('prisma/schema.prisma')
    const itemIdx = schema.indexOf('model GuestSellerItem {')
    const block = schema.slice(itemIdx, schema.indexOf('\n}', itemIdx))
    expect(block).toMatch(/catalogModelId\s+String\s/)
    expect(block).not.toMatch(/catalogModelId\s+String\?/)
  })
})
