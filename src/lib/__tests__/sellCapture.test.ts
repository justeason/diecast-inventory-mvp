// 19B: sellCapture.ts — the invisible backend-selection wrapper. Signed-in
// visitors use the existing, unmodified authenticated MobileCaptureSession
// pipeline; signed-out visitors use GuestSellerSession/Item. Neither
// mobileCapture.ts nor guestSeller.ts is modified.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { mobileCaptureSession: { findFirst: vi.fn() } },
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('@/lib/actions/mobileCapture', () => ({
  getOrCreateDraftSession: vi.fn(),
  addCaptureItem: vi.fn(),
  updateCaptureItem: vi.fn(),
  removeCaptureItem: vi.fn(),
  getCaptureSession: vi.fn(),
  submitCaptureSession: vi.fn(),
}))
vi.mock('@/lib/actions/guestSeller', () => ({
  addGuestSellerItem: vi.fn(),
  updateGuestSellerItem: vi.fn(),
  removeGuestSellerItem: vi.fn(),
  getGuestSellerBatch: vi.fn(),
}))
vi.mock('@/lib/catalogSearch', () => ({ searchCatalogModels: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { getOrCreateDraftSession, addCaptureItem, getCaptureSession, submitCaptureSession } from '@/lib/actions/mobileCapture'
import { addGuestSellerItem, updateGuestSellerItem, removeGuestSellerItem, getGuestSellerBatch } from '@/lib/actions/guestSeller'
import { addSellItem, updateSellItem, removeSellItem, getSellBatch, getUnclaimedGuestBatchCount, submitSellBatch } from '@/lib/actions/sellCapture'

const ITEM_INPUT = { catalogModelId: 'cat1', quantity: 1, condition: null, notes: null, saleTypePreference: 'unsure', clientToken: 'tok-1' }

beforeEach(() => {
  vi.resetAllMocks()
})

describe('addSellItem: backend selection', () => {
  it('signed out → GuestSellerSession/Item backend, MobileCapture never touched', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    ;(addGuestSellerItem as Mock).mockResolvedValue({ ok: true, data: {
      id: 'g1', catalogModelId: 'cat1', brand: 'Hot Wheels', name: 'Porsche', year: 1994,
      quantity: 1, condition: null, notes: null, saleTypePreference: 'unsure', clientToken: 'tok-1', updatedAt: '2026-01-01T00:00:00.000Z',
    } })

    const result = await addSellItem(ITEM_INPUT)
    expect(result.ok).toBe(true)
    expect(addGuestSellerItem).toHaveBeenCalledWith(ITEM_INPUT)
    expect(getOrCreateDraftSession).not.toHaveBeenCalled()
    expect(addCaptureItem).not.toHaveBeenCalled()
  })

  it('signed in → existing MobileCaptureSession(destination=\'sell\') backend, GuestSellerItem never touched', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getOrCreateDraftSession as Mock).mockResolvedValue({ ok: true, data: { sessionId: 'mcs1', itemCount: 0 } })
    ;(addCaptureItem as Mock).mockResolvedValue({ ok: true, data: {
      id: 'm1', catalogModelId: 'cat1', brand: 'Hot Wheels', name: 'Porsche', year: 1994,
      quantity: 1, acquisitionDate: null, condition: null, notes: null, isPublic: false,
      saleTypePreference: 'unsure', clientToken: 'tok-1', updatedAt: '2026-01-01T00:00:00.000Z',
    } })

    const result = await addSellItem(ITEM_INPUT)
    expect(result.ok).toBe(true)
    expect(getOrCreateDraftSession).toHaveBeenCalledWith('sell')
    expect(addCaptureItem).toHaveBeenCalledWith('mcs1', expect.objectContaining({ catalogModelId: 'cat1' }))
    expect(addGuestSellerItem).not.toHaveBeenCalled()
  })

  it('signed-in destination is always \'sell\' — never \'collection\'', () => {
    const src = readSrc('src/lib/actions/sellCapture.ts')
    expect(src).toContain("getOrCreateDraftSession('sell')")
  })
})

describe('getSellBatch: read-only, zero-write on GET', () => {
  it('signed out with no guest cookie → empty batch, guestSeller batch read only (no create)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    ;(getGuestSellerBatch as Mock).mockResolvedValue({ items: [] })

    const batch = await getSellBatch()
    expect(batch).toEqual({ items: [] })
    expect(getGuestSellerBatch).toHaveBeenCalledTimes(1)
  })

  it('signed in with no existing draft session → empty batch, getOrCreateDraftSession is NEVER called (peek only, never creates), and never falls through to reading an unrelated guest cookie', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.mobileCaptureSession.findFirst as Mock).mockResolvedValue(null)

    const batch = await getSellBatch()
    expect(batch).toEqual({ items: [] })
    expect(getOrCreateDraftSession).not.toHaveBeenCalled()
    expect(getCaptureSession).not.toHaveBeenCalled()
    expect(getGuestSellerBatch).not.toHaveBeenCalled()
  })

  it('signed in with an existing draft session reads it via getCaptureSession, no new session minted', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.mobileCaptureSession.findFirst as Mock).mockResolvedValue({ id: 'mcs1' })
    ;(getCaptureSession as Mock).mockResolvedValue({ ok: true, data: { id: 'mcs1', destination: 'sell', status: 'draft', items: [] } })

    await getSellBatch()
    expect(getCaptureSession).toHaveBeenCalledWith('mcs1')
    expect(getOrCreateDraftSession).not.toHaveBeenCalled()
  })

  it('the peek query is scoped to destination=\'sell\', status=\'draft\' — never picks up a collection-destination session', () => {
    const src = readSrc('src/lib/actions/sellCapture.ts')
    const idx = src.indexOf('async function peekMobileCaptureSessionId(')
    const fnSrc = src.slice(idx, src.indexOf('\n}', idx))
    expect(fnSrc).toContain("destination: 'sell'")
    expect(fnSrc).toContain("status: 'draft'")
  })
})

describe('updateSellItem/removeSellItem: authenticated-with-no-session never falls through to the guest backend (regression)', () => {
  it('updateSellItem: authenticated, no MobileCaptureSession yet → "Item not found", guest functions never touched', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.mobileCaptureSession.findFirst as Mock).mockResolvedValue(null)

    const result = await updateSellItem('item1', { quantity: 2 }, '2026-01-01T00:00:00.000Z')
    expect(result.ok).toBe(false)
    expect(updateGuestSellerItem).not.toHaveBeenCalled()
  })

  it('removeSellItem: authenticated, no MobileCaptureSession yet → removed:false, guest functions never touched', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.mobileCaptureSession.findFirst as Mock).mockResolvedValue(null)

    const result = await removeSellItem('item1')
    expect(result).toEqual({ ok: true, data: { removed: false } })
    expect(removeGuestSellerItem).not.toHaveBeenCalled()
  })
})

describe('getUnclaimedGuestBatchCount: signed-in-only notice, never merges/deletes', () => {
  it('anonymous visitor → 0 (they ARE the guest batch, nothing "extra" to report)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    const count = await getUnclaimedGuestBatchCount()
    expect(count).toBe(0)
    expect(getGuestSellerBatch).not.toHaveBeenCalled()
  })

  it('signed-in visitor with an existing unclaimed guest batch → reports the count, does not touch/merge/delete it', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getGuestSellerBatch as Mock).mockResolvedValue({ items: [{ id: 'g1' }, { id: 'g2' }] })

    const count = await getUnclaimedGuestBatchCount()
    expect(count).toBe(2)
  })

  it('never calls a claim/merge/delete guest-session function — structural proof this is read-only (only getGuestSellerBatch, a read, is called)', () => {
    const src = readSrc('src/lib/actions/sellCapture.ts')
    const idx = src.indexOf('export async function getUnclaimedGuestBatchCount')
    const fnSrc = src.slice(idx, src.indexOf('\n}', idx))
    expect(fnSrc).not.toMatch(/\.delete|claimGuest|mergeGuest|removeGuestSellerItem|updateGuestSellerItem/i)
    expect(fnSrc).toContain('getGuestSellerBatch()')
  })
})

describe('19C: submitSellBatch — the explicit final-submission action, authenticated only, reuses submitCaptureSession unmodified', () => {
  it('signed out → error, submitCaptureSession never called', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    const result = await submitSellBatch()
    expect(result.ok).toBe(false)
    expect(submitCaptureSession).not.toHaveBeenCalled()
  })

  it('signed in with no MobileCaptureSession yet → "No items to submit.", never falls through to a guest action', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.mobileCaptureSession.findFirst as Mock).mockResolvedValue(null)
    const result = await submitSellBatch()
    expect(result).toEqual({ ok: false, error: 'No items to submit.' })
    expect(submitCaptureSession).not.toHaveBeenCalled()
  })

  it('signed in with an existing draft session calls submitCaptureSession with the resolved session id — zero duplicate SellerSubmission logic', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.mobileCaptureSession.findFirst as Mock).mockResolvedValue({ id: 'mcs1' })
    ;(submitCaptureSession as Mock).mockResolvedValue({ ok: true, data: { submitted: true, results: [] } })

    const result = await submitSellBatch()
    expect(result).toEqual({ ok: true, data: { submitted: true } })
    expect(submitCaptureSession).toHaveBeenCalledWith('mcs1')
  })

  it('a submitCaptureSession failure is passed through unmodified', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.mobileCaptureSession.findFirst as Mock).mockResolvedValue({ id: 'mcs1' })
    ;(submitCaptureSession as Mock).mockResolvedValue({ ok: false, error: 'No items to submit.' })

    const result = await submitSellBatch()
    expect(result).toEqual({ ok: false, error: 'No items to submit.' })
  })

  it('structural: submitSellBatch never creates a SellerSubmission itself — no sellerSubmission.create reference in sellCapture.ts', () => {
    const src = readSrc('src/lib/actions/sellCapture.ts')
    expect(src).not.toMatch(/sellerSubmission\.create/i)
    expect(src).toContain('await submitCaptureSession(sessionId)')
  })
})

describe('19B: /sell page itself never creates any session merely by rendering (GET is zero-write)', () => {
  it('page.tsx only calls getSellBatch/getUnclaimedGuestBatchCount — both proven read-only above', () => {
    const src = readSrc('src/app/(store)/sell/page.tsx')
    expect(src).toContain('getSellBatch()')
    expect(src).toContain('getUnclaimedGuestBatchCount()')
    expect(src).not.toMatch(/getOrCreateDraftSession|addGuestSellerItem|addSellItem/)
  })
})

// 19B Final Runtime Reconciliation §4: a fast double-click/tap must not fire two
// concurrent first-add requests for the same model. React state
// (addPendingId) alone isn't sufficient — state updates are batched/async, so
// a second click can beat the re-render that disables the button. A
// synchronous ref-based guard is the actual source of truth.
describe('19B: SellCaptureFlow prevents double-submit on Confirm & Add / manual-search Add', () => {
  const src = readSrc('src/components/store/SellCaptureFlow.tsx')

  it('confirmCandidate guards synchronously via a ref (Set), checked and mutated before any await', () => {
    expect(src).toContain('const addInFlightRef = useRef<Set<string>>(new Set())')
    const idx = src.indexOf('async function confirmCandidate')
    const fnSrc = src.slice(idx, src.indexOf('\n  }', idx))
    const guardIdx = fnSrc.indexOf('if (addInFlightRef.current.has(catalogModelId)) return')
    const addIdx = fnSrc.indexOf('addInFlightRef.current.add(catalogModelId)')
    const awaitIdx = fnSrc.indexOf('await addSellItem(')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(addIdx).toBeGreaterThan(guardIdx)
    expect(awaitIdx).toBeGreaterThan(addIdx)
  })

  it('the in-flight guard is released in a finally block — a failed/successful add both unlock the model for a future legitimate retry', () => {
    const idx = src.indexOf('async function confirmCandidate')
    const fnSrc = src.slice(idx, src.indexOf('\n  }', idx))
    const finallyIdx = fnSrc.indexOf('} finally {')
    const deleteIdx = fnSrc.indexOf('addInFlightRef.current.delete(catalogModelId)')
    expect(finallyIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeGreaterThan(finallyIdx)
  })

  it('19C: the candidate-confirm button, the manual-search Add button, and the preselected-model Confirm & Add button all call the SAME confirmCandidate — one guarded entry point, not separate add paths', () => {
    const matches = [...src.matchAll(/onClick=\{\(\) => confirmCandidate\(/g)]
    expect(matches.length).toBe(3)
  })

  it('the visual disabled state still reflects addPendingId — the ref guard is a correctness backstop, not a replacement for the existing UI feedback', () => {
    expect(src).toContain('disabled={addPendingId === c.catalogModelId}')
    expect(src).toContain('disabled={addPendingId === m.id}')
  })
})
