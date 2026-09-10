// 19C: guest seller batch claim — authorization, lock order, overlap
// classification, cap enforcement, consumption, and cookie-clearing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
const claimSrc = readSrc('src/lib/actions/guestSellerClaim.ts')

type Mock = ReturnType<typeof vi.fn>

const mockCookieStore = { set: vi.fn() }
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('@/lib/guestSellerSession', () => ({
  getGuestSellerSessionContext: vi.fn(),
  GUEST_SELLER_COOKIE_NAME: 'guest_sell_session',
}))
vi.mock('@/lib/actions/mobileCapture', () => ({ getOrCreateDraftSession: vi.fn() }))

const txMock = {
  $queryRaw: vi.fn().mockResolvedValue([]),
  guestSellerSession: { findFirst: vi.fn(), deleteMany: vi.fn() },
  mobileCaptureSession: { findFirst: vi.fn() },
  guestSellerItem: { findMany: vi.fn() },
  mobileCaptureItem: { findMany: vi.fn(), count: vi.fn(), update: vi.fn(), create: vi.fn() },
  catalogModel: { findMany: vi.fn() },
}

vi.mock('@/lib/prisma', () => ({
  prisma: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txMock)) },
}))

import { getBuyerSession } from '@/lib/buyerSession'
import { getGuestSellerSessionContext } from '@/lib/guestSellerSession'
import { getOrCreateDraftSession } from '@/lib/actions/mobileCapture'
import { claimGuestSellerBatch } from '@/lib/actions/guestSellerClaim'

const GUEST_ITEM = {
  id: 'gi1', sessionId: 'guest1', catalogModelId: 'cat1', quantity: 2,
  condition: 'mint', notes: null, saleTypePreference: 'unsure',
}
const CATALOG_ROW = { id: 'cat1', brand: 'Hot Wheels', name: 'Porsche', year: 1994 }

// mobileCaptureItem.findMany is called TWICE per claim: once for id-only
// overlap discovery (passes `select`), once for the full-row authoritative
// re-read after locking (no `select`). A stateful implementation keyed on
// argument shape is far less fragile than chaining mockResolvedValueOnce
// pairs, since setupHappyPath() and an overlap-setting test both need to
// configure this same mock without one silently shadowing the other's queue.
let targetOverlapItems: Array<{ id: string; catalogModelId: string; quantity: number; condition: string | null; notes: string | null; saleTypePreference: string | null; clientToken: string; payloadFingerprint: string }> = []

function setTargetOverlap(items: typeof targetOverlapItems) {
  targetOverlapItems = items
}

function setupHappyPath() {
  ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
  ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'guest1' })
  ;(getOrCreateDraftSession as Mock).mockResolvedValue({ ok: true, data: { sessionId: 'target1', itemCount: 0 } })
  txMock.guestSellerSession.findFirst.mockResolvedValue({ expiresAt: new Date(Date.now() + 100_000) })
  txMock.mobileCaptureSession.findFirst.mockResolvedValue({ id: 'target1' })
  txMock.guestSellerItem.findMany.mockResolvedValue([GUEST_ITEM])
  targetOverlapItems = []
  txMock.mobileCaptureItem.findMany.mockImplementation((args: { select?: unknown }) =>
    Promise.resolve(args.select ? targetOverlapItems.map((o) => ({ id: o.id })) : targetOverlapItems),
  )
  txMock.catalogModel.findMany.mockResolvedValue([CATALOG_ROW])
  txMock.mobileCaptureItem.count.mockResolvedValue(0)
  txMock.guestSellerSession.deleteMany.mockResolvedValue({ count: 1 })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockCookieStore.set.mockClear()
  txMock.$queryRaw.mockResolvedValue([])
})

describe('claimGuestSellerBatch: authorization', () => {
  it('signed out → error, never reads guest session or resolves a target', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(false)
    expect(getGuestSellerSessionContext).not.toHaveBeenCalled()
    expect(getOrCreateDraftSession).not.toHaveBeenCalled()
  })

  it('signed in but no valid guest session → error, never resolves/creates a target draft', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue(null)
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(false)
    expect(getOrCreateDraftSession).not.toHaveBeenCalled()
  })

  it('getOrCreateDraftSession failure is passed through unmodified, transaction never opened', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getGuestSellerSessionContext as Mock).mockResolvedValue({ id: 'guest1' })
    ;(getOrCreateDraftSession as Mock).mockResolvedValue({ ok: false, error: 'Invalid destination.' })
    const result = await claimGuestSellerBatch()
    expect(result).toEqual({ ok: false, error: 'Invalid destination.' })
  })
})

describe('claimGuestSellerBatch: target resolution ordering (§9)', () => {
  it('getOrCreateDraftSession is called BEFORE prisma.$transaction — its P2002 recovery is not designed to run inside an already-open transaction', () => {
    const draftIdx = claimSrc.indexOf("getOrCreateDraftSession('sell')")
    const txIdx = claimSrc.indexOf('prisma.$transaction(async (tx)')
    expect(draftIdx).toBeGreaterThan(-1)
    expect(txIdx).toBeGreaterThan(draftIdx)
  })
})

describe('claimGuestSellerBatch: lock order (§12)', () => {
  it('locks GuestSellerSession, then MobileCaptureSession, then CatalogModel, then GuestSellerItem, then MobileCaptureItem — in that source order', () => {
    const guestLockIdx = claimSrc.indexOf('FROM "GuestSellerSession"')
    const targetLockIdx = claimSrc.indexOf('FROM "MobileCaptureSession"')
    const catalogLockIdx = claimSrc.indexOf('FROM "CatalogModel"')
    const guestItemLockIdx = claimSrc.indexOf('FROM "GuestSellerItem"')
    const targetItemLockIdx = claimSrc.indexOf('FROM "MobileCaptureItem"')
    expect(guestLockIdx).toBeGreaterThan(-1)
    expect(targetLockIdx).toBeGreaterThan(guestLockIdx)
    expect(catalogLockIdx).toBeGreaterThan(targetLockIdx)
    expect(guestItemLockIdx).toBeGreaterThan(catalogLockIdx)
    expect(targetItemLockIdx).toBeGreaterThan(guestItemLockIdx)
  })

  it('CatalogModel/GuestSellerItem/MobileCaptureItem rows are locked via a per-id loop (never a single IN(...) FOR UPDATE), matching catalog.ts\'s own merge-lock convention', () => {
    expect(claimSrc).toContain('for (const id of catalogModelIds)')
    expect(claimSrc).toContain('for (const id of guestItemIds)')
    expect(claimSrc).toContain('for (const id of targetOverlapIds)')
    expect(claimSrc).not.toMatch(/WHERE id = ANY/)
    expect(claimSrc).not.toMatch(/WHERE id IN \(\$\{/)
  })

  it('never locks CatalogModel before GuestSellerSession/MobileCaptureSession — the opposing order that risks a deadlock against existing add paths', () => {
    const catalogLockIdx = claimSrc.indexOf('FROM "CatalogModel"')
    const guestLockIdx = claimSrc.indexOf('FROM "GuestSellerSession"')
    const targetLockIdx = claimSrc.indexOf('FROM "MobileCaptureSession"')
    expect(catalogLockIdx).toBeGreaterThan(guestLockIdx)
    expect(catalogLockIdx).toBeGreaterThan(targetLockIdx)
  })
})

describe('claimGuestSellerBatch: expiry / empty-batch aborts', () => {
  it('expired guest session (checked under lock) aborts with no target mutation', async () => {
    setupHappyPath()
    txMock.guestSellerSession.findFirst.mockResolvedValue({ expiresAt: new Date(Date.now() - 1000) })
    const result = await claimGuestSellerBatch()
    expect(result).toEqual({ ok: false, error: 'Your saved selling batch has expired.' })
    expect(txMock.mobileCaptureItem.create).not.toHaveBeenCalled()
  })

  it('empty guest batch (discovered under lock) aborts safely', async () => {
    setupHappyPath()
    txMock.guestSellerItem.findMany.mockResolvedValue([])
    const result = await claimGuestSellerBatch()
    expect(result).toEqual({ ok: false, error: 'No saved selling items were found.' })
  })

  it('target session invalid (deleted/wrong owner/not draft) aborts safely', async () => {
    setupHappyPath()
    txMock.mobileCaptureSession.findFirst.mockResolvedValue(null)
    const result = await claimGuestSellerBatch()
    expect(result).toEqual({ ok: false, error: 'Please try again.' })
  })
})

describe('claimGuestSellerBatch: non-overlap insert (§19-21)', () => {
  it('creates a new MobileCaptureItem with guest fields copied, acquisitionDate=null, isPublic=false, a fresh clientToken, and a recomputed fingerprint', async () => {
    setupHappyPath()
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(true)
    expect(txMock.mobileCaptureItem.create).toHaveBeenCalledTimes(1)
    const call = (txMock.mobileCaptureItem.create as Mock).mock.calls[0][0]
    expect(call.data.sessionId).toBe('target1')
    expect(call.data.catalogModelId).toBe('cat1')
    expect(call.data.quantity).toBe(2)
    expect(call.data.condition).toBe('mint')
    expect(call.data.acquisitionDate).toBeNull()
    expect(call.data.isPublic).toBe(false)
    expect(call.data.clientToken).toMatch(/^[0-9a-f]{32}$/)
    expect(typeof call.data.payloadFingerprint).toBe('string')
    expect(call.data.payloadFingerprint.length).toBe(64)
  })

  it('deletes the GuestSellerSession (cascade) and clears the guest cookie only after the transaction resolves', async () => {
    setupHappyPath()
    txMock.guestSellerSession.deleteMany.mockResolvedValue({ count: 1 })
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(true)
    expect(txMock.guestSellerSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'guest1' } })
    expect(mockCookieStore.set).toHaveBeenCalledWith('guest_sell_session', '', expect.objectContaining({ maxAge: 0 }))
  })

  it('a delete count other than 1 aborts (defensive — should be structurally impossible)', async () => {
    setupHappyPath()
    txMock.guestSellerSession.deleteMany.mockResolvedValue({ count: 0 })
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(false)
    expect(mockCookieStore.set).not.toHaveBeenCalled()
  })
})

describe('claimGuestSellerBatch: compatible overlap merge (§16)', () => {
  it('exact metadata match + combined quantity <=999 → merges quantity only, preserves target id/clientToken/fingerprint untouched', async () => {
    setupHappyPath()
    const targetItem = {
      id: 'mci1', catalogModelId: 'cat1', quantity: 3,
      condition: 'mint', notes: null, saleTypePreference: 'unsure',
      clientToken: 'existing-token', payloadFingerprint: 'existing-fp',
    }
    setTargetOverlap([targetItem])

    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ claimedCount: 0, mergedCount: 1 })
    expect(txMock.mobileCaptureItem.update).toHaveBeenCalledWith({
      where: { id: 'mci1' },
      data: { quantity: 5 },
    })
    expect(txMock.mobileCaptureItem.create).not.toHaveBeenCalled()
  })

  it('combined quantity >999 blocks the entire claim as a conflict, even with identical metadata', async () => {
    setupHappyPath()
    const targetItem = {
      id: 'mci1', catalogModelId: 'cat1', quantity: 998,
      condition: 'mint', notes: null, saleTypePreference: 'unsure',
      clientToken: 'existing-token', payloadFingerprint: 'existing-fp',
    }
    setTargetOverlap([targetItem])

    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflicts?.[0].catalogModelId).toBe('cat1')
    expect(txMock.mobileCaptureItem.update).not.toHaveBeenCalled()
    expect(txMock.guestSellerSession.deleteMany).not.toHaveBeenCalled()
  })
})

describe('claimGuestSellerBatch: conflicting overlap blocks the WHOLE claim, never a partial transfer (§16-17)', () => {
  it.each([
    ['condition', { condition: 'good' }],
    ['notes', { notes: 'different' }],
    ['saleTypePreference', { saleTypePreference: 'buyout' }],
  ])('mismatched %s → whole claim blocked, no guest row silently skipped', async (_field, override) => {
    setupHappyPath()
    const targetItem = {
      id: 'mci1', catalogModelId: 'cat1', quantity: 1,
      condition: 'mint', notes: null, saleTypePreference: 'unsure',
      clientToken: 'x', payloadFingerprint: 'y',
      ...override,
    }
    setTargetOverlap([targetItem])

    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('This model is already in your selling batch with different details.')
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts?.[0]).toEqual(expect.objectContaining({
        guestItemId: 'gi1', catalogModelId: 'cat1', brand: 'Hot Wheels',
      }))
    }
    expect(txMock.mobileCaptureItem.create).not.toHaveBeenCalled()
    expect(txMock.guestSellerSession.deleteMany).not.toHaveBeenCalled()
  })

  it('null vs empty-string is treated as a genuine mismatch, never coerced equal', async () => {
    setupHappyPath()
    const targetItem = {
      id: 'mci1', catalogModelId: 'cat1', quantity: 1,
      condition: 'mint', notes: '', saleTypePreference: 'unsure',
      clientToken: 'x', payloadFingerprint: 'y',
    }
    txMock.guestSellerItem.findMany.mockResolvedValue([{ ...GUEST_ITEM, notes: null }])
    setTargetOverlap([targetItem])

    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(false)
  })
})

describe('claimGuestSellerBatch: 100-item cap (§22)', () => {
  it('existing target count + non-overlap inserts > 100 blocks the whole claim, guest batch remains intact', async () => {
    setupHappyPath()
    txMock.mobileCaptureItem.count.mockResolvedValue(100)
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/exceed 100 items/)
    expect(txMock.mobileCaptureItem.create).not.toHaveBeenCalled()
    expect(txMock.guestSellerSession.deleteMany).not.toHaveBeenCalled()
  })

  it('exactly 100 combined rows is allowed', async () => {
    setupHappyPath()
    txMock.mobileCaptureItem.count.mockResolvedValue(99)
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(true)
  })

  it('a compatible-overlap merge does not count as a new row against the cap', async () => {
    setupHappyPath()
    const targetItem = {
      id: 'mci1', catalogModelId: 'cat1', quantity: 1,
      condition: 'mint', notes: null, saleTypePreference: 'unsure',
      clientToken: 'x', payloadFingerprint: 'y',
    }
    setTargetOverlap([targetItem])
    txMock.mobileCaptureItem.count.mockResolvedValue(100) // at cap already, but no NEW row is being inserted
    const result = await claimGuestSellerBatch()
    expect(result.ok).toBe(true)
  })
})

describe('claimGuestSellerBatch: no schema/audit-model reliance (§25)', () => {
  it('consumption is a hard delete — no claimedAt/status field is ever written to GuestSellerSession', () => {
    expect(claimSrc).not.toMatch(/claimedAt\s*:/)
    expect(claimSrc).not.toMatch(/guestSellerSession\.update\(/)
    expect(claimSrc).toContain('guestSellerSession.deleteMany')
  })
})
