// 19B: GuestSellerItem is the newest CatalogModel FK relation. This file proves:
// an unexpired (active) guest reference hard-blocks the whole duplicate's merge
// outright (no retarget, no overlap reconciliation — GuestSellerSession has no
// "customer support" surface the way authenticated MobileCapture sessions do);
// an expired (already-inaccessible) reference is simply deleted, never
// retargeted (avoiding a @@unique([sessionId, catalogModelId]) collision risk);
// GuestSellerSession is NEVER locked by the merge (mirrors the 18D lesson for
// MobileCaptureSession) — only the affected GuestSellerItem rows are, via a
// parameterized join that reads expiresAt without ever locking the session row.
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

type LockedGuestRow = { id: string; sessionId: string; expiresAt: Date }

// $queryRaw is shared by the CatalogModel FOR UPDATE lock loop (unused), the
// ExternalMarketObservation row lock (defaults to none), the MobileCaptureItem
// row lock+session-status join (defaults to none), the CollectionItem overlap
// count (defaults to zero), and the GuestSellerItem row lock+session-expiresAt
// join (configurable).
function queryRawMock(guestLocked: LockedGuestRow[] = []) {
  return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings)
    if (text.includes('ExternalMarketObservation')) return Promise.resolve([])
    if (text.includes('MobileCaptureItem'))         return Promise.resolve([])
    if (text.includes('GuestSellerItem'))           return Promise.resolve(guestLocked)
    if (text.includes('CollectionItem'))            return Promise.resolve([{ count: 0 }])
    return Promise.resolve(undefined)
  })
}

function makeTx(opts: { guestLocked?: LockedGuestRow[]; overrides?: Record<string, unknown> } = {}) {
  const { guestLocked = [], overrides = {} } = opts
  return {
    $queryRaw: queryRawMock(guestLocked),
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
      findMany:   vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count:      vi.fn().mockResolvedValue(0),
    },
    guestSellerItem: {
      deleteMany: vi.fn().mockResolvedValue({ count: guestLocked.length }),
      count:      vi.fn().mockResolvedValue(0),
    },
    // 21B: no MarketVariant rows by default — reconcileMarketVariantMerge's
    // findMany calls both resolve empty, so its per-variant updates/deleteMany
    // are simply never reached in the clean path.
    marketVariant: {
      findMany:   vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count:      vi.fn().mockResolvedValue(0),
    },
    // 21B: OrderItem now has a direct catalogModelId identity pointer and a
    // marketVariantId child reference, both reconciled during merge.
    orderItem: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
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

const FUTURE = new Date(Date.now() + 60 * 60 * 1000) // 1 hour from now — active
const PAST = new Date(Date.now() - 60 * 60 * 1000)   // 1 hour ago — expired

// ── active guest reference blocks deliberately ──────────────────────────────────

describe('19B: active (unexpired) GuestSellerItem reference blocks the merge deliberately', () => {
  it('merge rejected with the actionable, PII-free message; no relation for this duplicate migrated; delete never called', async () => {
    const tx = makeTx({
      guestLocked: [{ id: 'gsi1', sessionId: 'gsess1', expiresAt: FUTURE }],
      overrides: { itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 5 }), count: vi.fn().mockResolvedValue(0) } },
    })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toBe('An active guest selling batch references this model. Complete or allow the guest batch to expire before merging.')
    expect(result?.errors?.form?.[0]).not.toMatch(/sessionId|gsess1|profileId|email/i)

    expect(tx.itemInstance.updateMany).not.toHaveBeenCalled()
    expect(tx.guestSellerItem.deleteMany).not.toHaveBeenCalled()
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
    expect(tx.catalogModelMergeAudit.create).not.toHaveBeenCalled()
  })

  it('a mix of one active + one expired row still blocks — conservative, no partial reconciliation', async () => {
    const tx = makeTx({ guestLocked: [
      { id: 'gsi1', sessionId: 'gsess1', expiresAt: PAST },
      { id: 'gsi2', sessionId: 'gsess2', expiresAt: FUTURE },
    ] })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/active guest selling batch/)
    expect(tx.guestSellerItem.deleteMany).not.toHaveBeenCalled()
  })
})

// ── expired guest row reconciliation ─────────────────────────────────────────────

describe('19B: expired GuestSellerItem rows are deleted, never retargeted', () => {
  it('all-expired rows are deleted via one set-based deleteMany scoped to the locked ids, merge proceeds', async () => {
    const tx = makeTx({ guestLocked: [
      { id: 'gsi1', sessionId: 'gsess1', expiresAt: PAST },
      { id: 'gsi2', sessionId: 'gsess2', expiresAt: PAST },
    ] })
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.guestSellerItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['gsi1', 'gsi2'] }, catalogModelId: 'dupe1' },
    })
  })

  it('never issues a guestSellerItem.updateMany — expired rows are deleted, not retargeted', async () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function reconcileGuestSellerItemMerge')
    const fnSrc = src.slice(idx, src.indexOf('\n}', idx))
    expect(fnSrc).not.toContain('guestSellerItem.updateMany')
    expect(fnSrc).toContain('guestSellerItem.deleteMany')
  })

  it('mismatch between locked count and deleted count aborts the whole merge (defensive, not expected to fire)', async () => {
    const tx = makeTx({ guestLocked: [
      { id: 'gsi1', sessionId: 'gsess1', expiresAt: PAST },
      { id: 'gsi2', sessionId: 'gsess2', expiresAt: PAST },
    ] })
    ;(tx.guestSellerItem.deleteMany as Mock).mockResolvedValue({ count: 1 }) // only 1 of 2 actually deleted
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toBe('Merge failed. Please try again.')
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })
})

// ── final integrity count ────────────────────────────────────────────────────────

describe('19B: final integrity check includes GuestSellerItem, unfiltered', () => {
  it('a lingering GuestSellerItem reference at final-check time aborts the merge — delete never called', async () => {
    const tx = makeTx({ overrides: {
      guestSellerItem: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(1) },
    } })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('the final integrity check array includes rgsi (guestSellerItem.count) unfiltered', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('const [ri, rc, rs, rsub, rp, rw, rae, raf, rfp, reo, rid, rmc, rgsi, rmv, roi, rivar, ridvar, reovar, roivar]')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, src.indexOf('])', idx))
    expect(block).toContain('tx.guestSellerItem.count({ where: { catalogModelId: dupeId } })')
    expect(src).toContain('const remaining = ri + rc + rs + rsub + rp + rw + rae + raf + rfp + reo + rid + rmc + rgsi')
  })
})

// ── no GuestSellerSession lock ────────────────────────────────────────────────────

describe('19B: merge NEVER locks GuestSellerSession (mirrors the 18D MobileCaptureSession lesson)', () => {
  it('catalog.ts never issues a bare FOR UPDATE against GuestSellerSession — only FOR UPDATE OF gsi', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).not.toMatch(/FROM\s+"GuestSellerSession"[^`]*FOR UPDATE(?! OF)/)
    expect(src).toContain('FOR UPDATE OF gsi')
  })

  it('the lock query joins GuestSellerSession only to read expiresAt, never locking it', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function lockAndClassifyGuestSellerItems')
    const fnSrc = src.slice(idx, src.indexOf('\n}', idx))
    expect(fnSrc).toContain('JOIN "GuestSellerSession" gss')
    expect(fnSrc).toContain('FOR UPDATE OF gsi')
    expect(fnSrc).not.toContain('FOR UPDATE OF gss')
  })

  it('lock query is parameterized (uses tagged-template ${dupeId}, no string concatenation)', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('async function lockAndClassifyGuestSellerItems')
    const fnSrc = src.slice(idx, src.indexOf('\n}', idx))
    expect(fnSrc).toContain('${dupeId}')
    expect(fnSrc).not.toMatch(/\+\s*dupeId|dupeId\s*\+/)
  })
})

// ── multi-duplicate atomicity ─────────────────────────────────────────────────────

describe('19B: multi-duplicate outer transaction remains atomic with guest reconciliation involved', () => {
  it('second duplicate hitting an active guest blocker rolls back work already done for the first duplicate too (single shared transaction — proven by the existing 18B/18D precedent, reconfirmed here for GuestSellerItem)', () => {
    // Structural confirmation: the per-duplicate loop and its guest-item check
    // live inside the SAME prisma.$transaction as every other reconciliation
    // step — no second/nested transaction was introduced for 19B.
    const src = readSrc('src/lib/actions/catalog.ts')
    const txIdx = src.indexOf('await prisma.$transaction(async (tx) => {')
    const guestCheckIdx = src.indexOf('const gsiClassification = await lockAndClassifyGuestSellerItems')
    const forLoopIdx = src.indexOf('for (let i = 0; i < duplicateIds.length; i++)')
    expect(txIdx).toBeGreaterThan(-1)
    expect(forLoopIdx).toBeGreaterThan(txIdx)
    expect(guestCheckIdx).toBeGreaterThan(forLoopIdx)
  })
})

// ── zero-row clean path ───────────────────────────────────────────────────────────

describe('19B: zero-row clean path stays simple', () => {
  it('no locked GuestSellerItem rows — merge proceeds normally with no extra mutation', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.guestSellerItem.deleteMany).not.toHaveBeenCalled()
  })
})

// ── CatalogModel relation matrix ──────────────────────────────────────────────────

describe('19B: CatalogModel relation matrix now includes GuestSellerItem', () => {
  it('CatalogModel.guestSellerItems back-relation exists in schema', () => {
    const schema = readSrc('prisma/schema.prisma')
    const idx = schema.indexOf('model CatalogModel {')
    const block = schema.slice(idx, schema.indexOf('\n}', idx))
    expect(block).toContain('guestSellerItems     GuestSellerItem[]')
  })

  it('no accidental Cascade/SetNull on GuestSellerItem.catalogModelId — required FK, no onDelete (the sibling sessionId relation legitimately cascades, checked separately)', () => {
    const schema = readSrc('prisma/schema.prisma')
    const idx = schema.indexOf('model GuestSellerItem {')
    const block = schema.slice(idx, schema.indexOf('\n}', idx))
    expect(block).toMatch(/catalogModelId\s+String\s*$/m)
    const catalogRelationLine = block.split('\n').find((l) => l.includes('CatalogModel') && l.includes('@relation'))
    expect(catalogRelationLine).toBeDefined()
    expect(catalogRelationLine).not.toMatch(/onDelete:\s*(Cascade|SetNull)/)
    // The sibling session relation SHOULD cascade — that's the correct, intended behavior.
    expect(block).toContain('onDelete: Cascade')
  })
})

// ── schema/migration confirmation ─────────────────────────────────────────────────

describe('19B: zero schema/migration changes made by THIS reconciliation work (schema/migration were already committed in earlier 19B steps)', () => {
  it('GuestSellerSession/GuestSellerItem models exist exactly as designed', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toContain('model GuestSellerSession {')
    expect(schema).toContain('model GuestSellerItem {')
    expect(schema).toContain('@@unique([sessionId, catalogModelId])')
  })
})
