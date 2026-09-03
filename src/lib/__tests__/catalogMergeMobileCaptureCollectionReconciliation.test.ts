// 18D: the final CatalogModel merge-integrity milestone. Two relations left
// unresolved by 18A-18C:
//
// 1. MobileCaptureItem.catalogModelId — required FK, no onDelete, blocks deletion.
//    Draft sessions are still actively customer-editable (addCaptureItem/
//    updateCaptureItem/removeCaptureItem/submitCaptureSession/cancelCaptureSession),
//    so ANY draft-session reference hard-blocks the merge outright — no retarget, no
//    overlap/non-overlap distinction, never rewriting live customer work. Terminal
//    (submitted/cancelled) sessions are frozen historical input records: a
//    non-overlap row retargets in place; an overlap (both models already captured in
//    the same session) collapses onto the canonical-associated row — quantity sums,
//    every other field (metadata/clientToken/payloadFingerprint) stays exactly the
//    canonical row's own original values, and the duplicate row is deleted.
//
// 2. CollectionItem — 18D's audit discovered @@unique([profileId, catalogId])
//    (16F Final) was never accounted for by the existing blind
//    collectionItem.updateMany. An overlapping profile (CollectionItem for both A and
//    B) previously crashed the whole merge with a generic P2002-driven "Merge failed"
//    error. 18D turns that into a deliberate, actionable precondition — still a
//    block, never an auto-sum, matching this product's existing customer-driven
//    duplicate-resolution precedent (checkCollectionDuplicate/
//    updateExistingCollectionQuantity).
//
// Locking architecture: this merge NEVER acquires MobileCaptureSession FOR UPDATE —
// addCaptureItem locks MobileCaptureSession then inserts a MobileCaptureItem whose FK
// needs FOR KEY SHARE on CatalogModel; if the merge also locked MobileCaptureSession,
// the two transactions could wait on each other in opposite order (deadlock). Instead
// only MobileCaptureItem rows are locked, via `FOR UPDATE OF mci` in a join that reads
// the parent session's status without ever locking the session row itself.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { count: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/catalogDataQualityQuery', () => ({ computeImpactCounts: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))
vi.mock('@/lib/actions/riskApprovals', () => ({
  checkRiskGate: vi.fn(() => Promise.resolve({ decision: 'allow' })),
  consumeApprovedRiskGate: vi.fn(),
  markApprovalConsumed: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { computeImpactCounts } from '@/lib/catalogDataQualityQuery'
import { mergeCatalogModels } from '@/lib/actions/catalog'

const ZERO_IMPACT = { itemInstances: 0, collectionItems: 0, wantedBy: 0, sellerSubmissions: 0, photos: 0, fingerprints: 0, activeListings: 0, soldItems: 0, externalObs: 0 }

type LockedRow = { id: string; sessionId: string; quantity: number; status: string }

// $queryRaw is shared by the CatalogModel FOR UPDATE lock loop (unused), the
// ExternalMarketObservation row lock (defaults to none), the 18D MobileCaptureItem
// row lock + session-status join (configurable), and the 18D CollectionItem overlap
// count (configurable).
function queryRawMock(opts: { mobileCaptureLocked?: LockedRow[]; collectionOverlapCount?: number } = {}) {
  const { mobileCaptureLocked = [], collectionOverlapCount = 0 } = opts
  return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings)
    if (text.includes('ExternalMarketObservation')) return Promise.resolve([])
    if (text.includes('MobileCaptureItem'))         return Promise.resolve(mobileCaptureLocked)
    if (text.includes('CollectionItem'))             return Promise.resolve([{ count: collectionOverlapCount }])
    return Promise.resolve(undefined)
  })
}

// canonicalRows: pre-existing canonical-B MobileCaptureItem rows keyed by sessionId,
// used by lockAndClassifyMobileCaptureItems's overlap classification query.
function makeTx(opts: {
  mobileCaptureLocked?: LockedRow[]
  canonicalRows?: Array<{ id: string; sessionId: string; quantity: number }>
  collectionOverlapCount?: number
  overrides?: Record<string, unknown>
} = {}) {
  const { mobileCaptureLocked = [], canonicalRows = [], collectionOverlapCount = 0, overrides = {} } = opts
  return {
    $queryRaw: queryRawMock({ mobileCaptureLocked, collectionOverlapCount }),
    catalogModel: {
      findUnique: vi.fn().mockImplementation((args: { where: { id: string } }) => Promise.resolve({ id: args.where.id, brand: 'Hot Wheels', name: 'Porsche 911' })),
      delete: vi.fn().mockResolvedValue({}),
    },
    itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    collectionItem: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    catalogSuggestion: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    sellerSubmission: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    catalogModelPhoto: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    wantedCatalogModel: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    buyerAlertEvent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    buyerAlertFanout: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    catalogPhotoFingerprint: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    externalMarketObservationAudit: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    intakeDraft: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    mobileCaptureItem: {
      findMany:   vi.fn().mockResolvedValue(canonicalRows),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      count:      vi.fn().mockResolvedValue(0),
    },
    catalogModelMergeAudit: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function formData(canonicalId: string, ...duplicateIds: string[]): FormData {
  const fd = new FormData()
  fd.set('canonicalId', canonicalId)
  for (const id of duplicateIds) fd.append('duplicateId', id)
  return fd
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.catalogModel.count as Mock).mockResolvedValue(2)
  ;(computeImpactCounts as Mock).mockResolvedValue(ZERO_IMPACT)
})

// ── 31: no MobileCaptureSession lock ────────────────────────────────────────────────

describe('18D: no MobileCaptureSession lock (31)', () => {
  it('catalog.ts never issues FOR UPDATE against MobileCaptureSession', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).not.toMatch(/FROM\s+"MobileCaptureSession"[^`]*FOR UPDATE/)
    // the MobileCaptureItem lock query DOES join MobileCaptureSession, but the
    // lock itself is scoped with `FOR UPDATE OF mci` — never the session alias.
    expect(src).toContain('FOR UPDATE OF mci')
  })

  it('the MobileCaptureItem lock query never says "FOR UPDATE OF mcs" or a bare session-locking FOR UPDATE', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function lockAndClassifyMobileCaptureItems')
    const fnSrc = src.slice(idx, src.indexOf('\n}\n', idx))
    expect(fnSrc).not.toContain('FOR UPDATE OF mcs')
  })
})

// ── 32: draft blocks — no mutation ──────────────────────────────────────────────────

describe('18D: draft session reference blocks the whole merge, no MobileCaptureItem mutation (5/32)', () => {
  it('draft session + duplicate model reference → merge rejected with actionable message', async () => {
    const tx = makeTx({ mobileCaptureLocked: [{ id: 'mci1', sessionId: 'sess1', quantity: 2, status: 'draft' }] })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/active capture session references this model/)
  })

  it('no mobileCaptureItem.updateMany/deleteMany commits when draft blocks the merge', async () => {
    const tx = makeTx({ mobileCaptureLocked: [{ id: 'mci1', sessionId: 'sess1', quantity: 2, status: 'draft' }] })
    mockTransaction(tx)
    await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(tx.mobileCaptureItem.updateMany).not.toHaveBeenCalled()
    expect(tx.mobileCaptureItem.deleteMany).not.toHaveBeenCalled()
  })

  it('draft blocks even when only the duplicate is referenced (no canonical overlap in that session)', async () => {
    const tx = makeTx({ mobileCaptureLocked: [{ id: 'mci1', sessionId: 'sess1', quantity: 1, status: 'draft' }], canonicalRows: [] })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/active capture session references this model/)
  })

  it('draft blocks the WHOLE merge — no relation for this duplicate is migrated, catalogModel.delete never called', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mci1', sessionId: 'sess1', quantity: 1, status: 'draft' }],
      overrides: { itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 5 }), count: vi.fn().mockResolvedValue(0) } },
    })
    mockTransaction(tx)
    await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(tx.itemInstance.updateMany).not.toHaveBeenCalled()
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
    expect(tx.catalogModelMergeAudit.create).not.toHaveBeenCalled()
  })
})

// ── 6/46: unexpected status safely aborts ───────────────────────────────────────────

describe('18D: only submitted/cancelled are reconciled — unexpected status safely aborts (6/46)', () => {
  it('an unrecognized session status aborts the merge rather than being treated as terminal', async () => {
    const tx = makeTx({ mobileCaptureLocked: [{ id: 'mci1', sessionId: 'sess1', quantity: 1, status: 'archived' }] })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toBe('Merge failed. Please try again.')
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
    expect(tx.mobileCaptureItem.updateMany).not.toHaveBeenCalled()
  })
})

// ── 8/33: terminal non-overlap retarget ─────────────────────────────────────────────

describe.each(['submitted', 'cancelled'])('18D: terminal (%s) non-overlap retarget (8/33)', (status) => {
  it('retargets via one set-based updateMany scoped to the locked id, preserving quantity/metadata/clientToken/payloadFingerprint/createdAt', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 4, status }],
      canonicalRows: [],
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.mobileCaptureItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['mciA'] }, catalogModelId: 'dupe1' },
      data: { catalogModelId: 'canon1' },
    })
    expect(tx.mobileCaptureItem.deleteMany).not.toHaveBeenCalled()
  })

  it('the update payload touches ONLY catalogModelId — quantity/metadata/clientToken/payloadFingerprint are never in the data object', async () => {
    const tx = makeTx({ mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 4, status }], canonicalRows: [] })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.mobileCaptureItem.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['catalogModelId'])
  })
})

// ── 9/13/34: terminal overlap collapse ──────────────────────────────────────────────

describe.each(['submitted', 'cancelled'])('18D: terminal (%s) overlap collapse (9/13/34)', (status) => {
  it('canonical row survives with combined quantity; duplicate row is deleted', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 2, status }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 3 }],
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.mobileCaptureItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'mciB', catalogModelId: 'canon1' },
      data: { quantity: 5 },
    })
    expect(tx.mobileCaptureItem.deleteMany).toHaveBeenCalledWith({
      where: { id: 'mciA', catalogModelId: 'dupe1' },
    })
  })

  it('the survivor quantity update touches ONLY quantity — never catalogModelId, metadata, clientToken, or payloadFingerprint', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 2, status }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 3 }],
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.mobileCaptureItem.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['quantity'])
  })
})

// ── 11/35: metadata conflicts never merged ──────────────────────────────────────────

describe('18D: metadata conflicts — canonical row wins unchanged (11/12/35)', () => {
  it('condition/acquisitionDate/notes/isPublic/saleTypePreference are never touched by the reconciliation — structural proof', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function applyMobileCaptureItemReconciliation')
    const fnSrc = src.slice(idx, src.indexOf('\n}\n', idx + 40))
    for (const field of ['condition', 'acquisitionDate', 'notes', 'isPublic', 'saleTypePreference', 'clientToken', 'payloadFingerprint']) {
      expect(fnSrc).not.toContain(`${field}:`)
    }
  })

  it('no concatenation, OR/AND, or "newest wins" logic exists in the reconciliation function', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function applyMobileCaptureItemReconciliation')
    const fnSrc = src.slice(idx, src.indexOf('\n}\n', idx + 40))
    expect(fnSrc).not.toMatch(/\|\|/)
    expect(fnSrc).not.toMatch(/&&/)
    expect(fnSrc).not.toContain('.join(')
  })
})

// ── 10/36: quantity limit — abort, never clamp ──────────────────────────────────────

describe('18D: overlap quantity limit — abort, never clamp (10/27/36)', () => {
  it('999 combined is allowed exactly', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 500, status: 'submitted' }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 499 }],
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.mobileCaptureItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'mciB', catalogModelId: 'canon1' },
      data: { quantity: 999 },
    })
  })

  it('1000 combined blocks the merge with an actionable message — nothing changes, no clamp to 999', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 500, status: 'submitted' }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 500 }],
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/exceed the capture quantity limit/)
    expect(tx.mobileCaptureItem.updateMany).not.toHaveBeenCalled()
    expect(tx.mobileCaptureItem.deleteMany).not.toHaveBeenCalled()
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('source contains no clamp/Math.min/truncate logic for quantity', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function applyMobileCaptureItemReconciliation')
    const fnSrc = src.slice(idx, src.indexOf('\n}\n', idx + 40))
    expect(fnSrc).not.toContain('Math.min')
    expect(fnSrc).not.toContain('999')
  })
})

// ── 17/37: multiple duplicates accumulate ───────────────────────────────────────────

describe('18D: multiple duplicates accumulate quantity onto the same canonical row (17/37)', () => {
  it('A qty1 + C qty2 merged into B qty3 (sequentially) yields a final combined quantity of 6 across two reconciliation calls', async () => {
    // First duplicate (dupe1=A, qty1) merges against canonical (qty3) -> update to 4.
    // Second duplicate (dupe2=C, qty2) is processed against a FRESH read of the
    // canonical row — in production this is the same transaction re-querying live
    // state; here we assert the two calls independently since each duplicate gets
    // its own lockAndClassifyMobileCaptureItems invocation with its own fixture.
    const txA = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 1, status: 'submitted' }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 3 }],
    })
    mockTransaction(txA)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(txA.mobileCaptureItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'mciB', catalogModelId: 'canon1' },
      data: { quantity: 4 },
    })

    const txC = makeTx({
      mobileCaptureLocked: [{ id: 'mciC', sessionId: 'sess1', quantity: 2, status: 'submitted' }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 4 }], // reflects post-A state
    })
    mockTransaction(txC)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe2'))).rejects.toThrow('REDIRECT')
    expect(txC.mobileCaptureItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'mciB', catalogModelId: 'canon1' },
      data: { quantity: 6 },
    })
  })

  it('a single merge call processing two duplicates in one transaction reconciles each sequentially, not concurrently, so quantity accumulates correctly', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    // the per-duplicate loop is a plain `for` loop (sequential), not a
    // duplicateIds.map(...).then(Promise.all) fan-out — accumulation across
    // duplicates depends on this.
    expect(src).toMatch(/for \(let i = 0; i < duplicateIds\.length; i\+\+\)/)
  })
})

// ── 15/38: payloadFingerprint never recomputed ──────────────────────────────────────

describe('18D: payloadFingerprint is never recomputed by the merge (15/38)', () => {
  it('catalog.ts contains no computePayloadFingerprint call and no crypto import', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).not.toContain('computePayloadFingerprint')
    expect(src).not.toContain("from 'crypto'")
  })

  it('non-overlap retarget payload never includes payloadFingerprint', async () => {
    const tx = makeTx({ mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 1, status: 'submitted' }], canonicalRows: [] })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.mobileCaptureItem.updateMany as Mock).mock.calls[0][0]
    expect(call.data).not.toHaveProperty('payloadFingerprint')
  })

  it('overlap survivor quantity update never includes payloadFingerprint', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 1, status: 'submitted' }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 1 }],
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.mobileCaptureItem.updateMany as Mock).mock.calls[0][0]
    expect(call.data).not.toHaveProperty('payloadFingerprint')
  })
})

// ── 14/39: clientToken never touched or copied ──────────────────────────────────────

describe('18D: clientToken — survivor keeps its own, duplicate loses its own, never copied (14/39)', () => {
  it('non-overlap retarget never writes clientToken', async () => {
    const tx = makeTx({ mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 1, status: 'cancelled' }], canonicalRows: [] })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.mobileCaptureItem.updateMany as Mock).mock.calls[0][0]
    expect(call.data).not.toHaveProperty('clientToken')
  })

  it('overlap collapse never writes clientToken on the survivor and never reads/moves the duplicate row\'s clientToken', async () => {
    const tx = makeTx({
      mobileCaptureLocked: [{ id: 'mciA', sessionId: 'sess1', quantity: 1, status: 'cancelled' }],
      canonicalRows: [{ id: 'mciB', sessionId: 'sess1', quantity: 1 }],
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const updateCall = (tx.mobileCaptureItem.updateMany as Mock).mock.calls[0][0]
    expect(updateCall.data).not.toHaveProperty('clientToken')
    // the locked query only selected id/sessionId/quantity/status — clientToken was
    // never read off the duplicate row in the first place, so nothing to move.
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function lockAndClassifyMobileCaptureItems')
    const fnSrc = src.slice(idx, src.indexOf('\n}\n', idx))
    expect(fnSrc).not.toContain('clientToken')
  })
})

// ── 19/40: final MobileCaptureItem integrity count ──────────────────────────────────

describe('18D: final integrity check includes MobileCaptureItem, unfiltered (19/40)', () => {
  it('a lingering MobileCaptureItem reference at final-check time aborts the merge — delete never called', async () => {
    const tx = makeTx({
      overrides: { mobileCaptureItem: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(1), // simulates an unaccounted-for row
      } },
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('the final integrity check array includes rmc (mobileCaptureItem.count) unfiltered by status', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('const [ri, rc, rs, rsub, rp, rw, rae, raf, rfp, reo, rid, rmc]')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, src.indexOf('])', idx))
    expect(block).toContain('tx.mobileCaptureItem.count({ where: { catalogModelId: dupeId } })')
    expect(src).toContain('const remaining = ri + rc + rs + rsub + rp + rw + rae + raf + rfp + reo + rid + rmc')
  })
})

// ── 20/21/41: CollectionItem overlap blocks ─────────────────────────────────────────

describe('18D: CollectionItem overlap blocks the merge deliberately — no P2002 reliance (20/21/22/41)', () => {
  it('a profile with both CollectionItem(A) and CollectionItem(B): merge rejected with actionable message, whole transaction rolled back', async () => {
    const tx = makeTx({ collectionOverlapCount: 1 })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/collection contains both the duplicate and canonical model/)
  })

  it('neither collection row is mutated when overlap blocks', async () => {
    const tx = makeTx({ collectionOverlapCount: 1 })
    mockTransaction(tx)
    await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(tx.collectionItem.updateMany).not.toHaveBeenCalled()
  })

  it('the merge does not rely on catching a P2002 error to detect this — the precondition is a deliberate count check, awaited before the updateMany', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('const collectionOverlapCount = await countCollectionItemOverlap')
    const updateIdx = src.indexOf('tx.collectionItem.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } })')
    expect(idx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(updateIdx)
    const fnIdx = src.indexOf('async function countCollectionItemOverlap')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}\n', fnIdx))
    expect(fnSrc).not.toContain('P2002')
    expect(fnSrc).not.toContain('catch')
  })
})

// ── 42: CollectionItem non-overlap unchanged ────────────────────────────────────────

describe('18D: CollectionItem non-overlap retargets exactly as before, no quantity change (23/42)', () => {
  it('profile has CollectionItem(A) only — retargets to B via the existing plain updateMany', async () => {
    const tx = makeTx({ collectionOverlapCount: 0 })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.collectionItem.updateMany).toHaveBeenCalledWith({
      where: { catalogId: 'dupe1' },
      data: { catalogId: 'canon1' },
    })
  })
})

// ── 43: no CollectionItem auto-sum ──────────────────────────────────────────────────

describe('18D: no CollectionItem quantity aggregation or delete/recreate was introduced (43)', () => {
  it('countCollectionItemOverlap only counts — no quantity arithmetic, no delete, no create', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnIdx = src.indexOf('async function countCollectionItemOverlap')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}\n', fnIdx))
    expect(fnSrc).not.toMatch(/collectionItem\.(delete|create)\(/)
    expect(fnSrc).not.toContain('quantity')
  })

  it('the existing collectionItem.updateMany migration is completely unchanged — still catalogId-only, still unconditional on overlap having been ruled out', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect((src.match(/tx\.collectionItem\.updateMany/g) ?? []).length).toBe(1)
  })
})

// ── 29/44: precondition order ───────────────────────────────────────────────────────

describe('18D: draft and collection-overlap preconditions run before their relevant mutations (29/44)', () => {
  it('lockAndClassifyMobileCaptureItems and its draft-block check occur before the Promise.all migration block', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const classifyIdx = src.indexOf('const mcClassification = await lockAndClassifyMobileCaptureItems')
    const promiseAllIdx = src.indexOf('items, collItems, suggestions, submissions, photos, wanted,')
    expect(classifyIdx).toBeGreaterThan(-1)
    expect(promiseAllIdx).toBeGreaterThan(-1)
    expect(classifyIdx).toBeLessThan(promiseAllIdx)
  })

  it('the CollectionItem overlap precondition occurs before both the draft-classification result is used for mutation and the collectionItem.updateMany call', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const overlapIdx = src.indexOf('const collectionOverlapCount = await countCollectionItemOverlap')
    const updateIdx = src.indexOf('tx.collectionItem.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } })')
    expect(overlapIdx).toBeGreaterThan(-1)
    expect(overlapIdx).toBeLessThan(updateIdx)
  })
})

// ── 45: query architecture ──────────────────────────────────────────────────────────

describe('18D: query architecture — set-based, no per-item N+1 (45)', () => {
  it('lockAndClassifyMobileCaptureItems issues exactly one $queryRaw lock and one set-based findMany for overlap classification — no per-row query', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function lockAndClassifyMobileCaptureItems')
    const fnSrc = src.slice(idx, src.indexOf('\n}\n', idx))
    expect((fnSrc.match(/tx\.\$queryRaw/g) ?? []).length).toBe(1)
    expect((fnSrc.match(/tx\.mobileCaptureItem\.findMany/g) ?? []).length).toBe(1)
    expect(fnSrc).toContain('sessionId: { in: sessionIds }')
  })

  it('applyMobileCaptureItemReconciliation issues one set-based updateMany for all non-overlap rows, and a loop only over overlap sessions (bounded by actual overlaps, not all locked rows)', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function applyMobileCaptureItemReconciliation')
    const fnSrc = src.slice(idx, src.indexOf('\n}\n', idx + 40))
    expect(fnSrc).toContain('id: { in: nonOverlapIds }')
    expect(fnSrc).toContain('for (const o of overlaps)')
  })

  it('countCollectionItemOverlap is a single query (one self-join), not a query per profile', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnIdx = src.indexOf('async function countCollectionItemOverlap')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}\n', fnIdx))
    expect((fnSrc.match(/tx\.\$queryRaw/g) ?? []).length).toBe(1)
  })
})

// ── zero-row clean path ─────────────────────────────────────────────────────────────

describe('18D: zero-row clean path stays simple', () => {
  it('no locked MobileCaptureItem rows and no CollectionItem overlap — merge proceeds normally with no extra mutation', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.mobileCaptureItem.updateMany).not.toHaveBeenCalled()
    expect(tx.mobileCaptureItem.deleteMany).not.toHaveBeenCalled()
  })
})

// ── schema/migration confirmation ───────────────────────────────────────────────────

describe('18D: zero schema/migration changes', () => {
  it('MobileCaptureItem and CollectionItem schema are unchanged from the 18D investigation baseline', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toContain('model MobileCaptureItem {')
    expect(schema).toContain('@@unique([sessionId, catalogModelId])')
    expect(schema).toContain('@@unique([profileId, catalogId])')
  })

  it('migration count is unchanged at 48 — 18D adds no new migration directory', () => {
    const dirs = fs.readdirSync(path.join(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
    expect(dirs.length).toBe(48)
  })
})
