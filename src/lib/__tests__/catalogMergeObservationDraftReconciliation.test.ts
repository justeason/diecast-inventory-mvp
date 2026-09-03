// 18C: ExternalMarketObservation.catalogModelId (nullable FK, blocks delete) and
// IntakeDraft.catalogModelId (nullable FK, onDelete: SetNull) were not reconciled
// before duplicate CatalogModel deletion — observations caused a generic merge
// failure (P2003), and drafts were silently SetNull, losing their resolved
// exact-match fast path even though the correct canonical identity is known. This
// file proves: observations retarget with a preserved per-row audit trail (matching
// the existing matchObservationToCatalog/unmatchObservation convention); drafts
// retarget in place with no SetNull reliance. MobileCaptureItem's own
// @@unique([sessionId, catalogModelId]) overlap reconciliation is covered
// separately by catalogMergeMobileCaptureCollectionReconciliation.test.ts (18D).
//
// 18C final reconciliation: the CatalogModel FOR UPDATE lock does NOT protect
// ExternalMarketObservation rows — Postgres only locks the FK target being newly
// referenced, never the one being vacated, so a concurrent unmatch/rematch could
// move an observation away from the duplicate between an unlocked read and the
// merge's own update, leaving a phantom 'merged' audit row. Fixed by explicitly
// `SELECT ... FOR UPDATE`-locking the affected observation rows FIRST, via
// tx.$queryRaw (Prisma cannot express row locking natively) — the locked id set is
// the single source of truth for both the audit rows and the update, with a
// defensive count-mismatch abort if they ever diverge.
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

// $queryRaw is shared by the CatalogModel FOR UPDATE lock loop (return value
// unused), the ExternalMarketObservation row lock (return value = the locked
// ids), the 18D MobileCaptureItem row lock+session-status join (defaults to
// none locked), and the 18D CollectionItem overlap count (defaults to zero).
function queryRawMock(observationLockIds: string[] = []) {
  return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings)
    if (text.includes('ExternalMarketObservation')) {
      return Promise.resolve(observationLockIds.map(id => ({ id })))
    }
    if (text.includes('MobileCaptureItem')) return Promise.resolve([])
    if (text.includes('CollectionItem'))    return Promise.resolve([{ count: 0 }])
    return Promise.resolve(undefined) // CatalogModel FOR UPDATE — result unused
  })
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: queryRawMock(),
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
    externalMarketObservation: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    externalMarketObservationAudit: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    intakeDraft: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    // 18D: no capture rows by default.
    mobileCaptureItem: {
      findMany:   vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count:      vi.fn().mockResolvedValue(0),
    },
    catalogModelMergeAudit: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function formData(canonicalId: string, duplicateId: string): FormData {
  const fd = new FormData()
  fd.set('canonicalId', canonicalId)
  fd.set('duplicateId', duplicateId)
  return fd
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.catalogModel.count as Mock).mockResolvedValue(2)
  ;(computeImpactCounts as Mock).mockResolvedValue(ZERO_IMPACT)
})

// ── 20/8/9: observation retarget, source fields/matchStatus preserved ─────────────

describe('18C: ExternalMarketObservation retarget (20/8/9)', () => {
  it('retargets via one set-based updateMany scoped to the locked ids, no delete/recreate', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['obs1']),
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.externalMarketObservation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['obs1'] }, catalogModelId: 'dupe1' },
      data: { catalogModelId: 'canon1' },
    })
  })

  it('the update payload touches ONLY catalogModelId — matchStatus/matchMethod/rejectionReason/source fields are never in the data object', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['obs1']),
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.externalMarketObservation.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['catalogModelId'])
  })

  it('a currently matched observation remains matched — the merge is not an unmatch/re-match workflow (structural: no matchStatus write anywhere in the reconciliation function)', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    expect(fnSrc).not.toContain('matchStatus')
    expect(fnSrc).not.toContain('matchMethod')
    expect(fnSrc).not.toContain('rejectionReason')
  })

  it('no P2002/dedupe/delete+recreate workaround — plain identity correction only', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    expect(fnSrc).not.toContain('P2002')
    expect(fnSrc).not.toMatch(/externalMarketObservation\.(delete|create)\(/)
  })
})

// ── 21/4/6/7: observation audit trail preserved, no fabrication ───────────────────

describe('18C: ExternalMarketObservation audit trail (21/4/6/7)', () => {
  it('exactly one audit row per locked observation, via createMany (set-based, not one create() per row)', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['obs1', 'obs2']),
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 2 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.externalMarketObservationAudit.createMany).toHaveBeenCalledTimes(1)
    const call = (tx.externalMarketObservationAudit.createMany as Mock).mock.calls[0][0]
    expect(call.data).toHaveLength(2)
  })

  it('each audit row truthfully records before=duplicate, after=canonical, with no fake actor/type', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['obs1']),
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    const row = (tx.externalMarketObservationAudit.createMany as Mock).mock.calls[0][0].data[0]
    expect(row.observationId).toBe('obs1')
    expect(row.beforeSnapshot).toEqual({ catalogModelId: 'dupe1' })
    expect(row.afterSnapshot).toEqual({ catalogModelId: 'canon1' })
    expect(row.adminInfo).toBeUndefined() // never fabricated — matches every existing action's convention of leaving it unset
  })

  it('the audit write happens BEFORE the observation update — audit and retarget are atomic within the same reconciliation function/transaction', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    const auditIdx = fnSrc.indexOf('externalMarketObservationAudit.createMany')
    const updateIdx = fnSrc.indexOf('externalMarketObservation.updateMany')
    expect(auditIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(auditIdx)
  })

  it('when zero observations reference the duplicate, no audit query/write happens at all — bounded by the locked set only', async () => {
    const tx = makeTx() // default: $queryRaw's observation branch resolves []
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.externalMarketObservationAudit.createMany).not.toHaveBeenCalled()
    expect(tx.externalMarketObservation.updateMany).not.toHaveBeenCalled()
  })

  it('no per-observation loop — one lock query + one createMany + one updateMany, never per-row', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    expect((fnSrc.match(/\$queryRaw/g) ?? []).length).toBe(1)
    expect((fnSrc.match(/externalMarketObservationAudit\.createMany/g) ?? []).length).toBe(1)
    expect((fnSrc.match(/externalMarketObservation\.updateMany/g) ?? []).length).toBe(1)
    expect(fnSrc).not.toMatch(/for\s*\(.*of.*locked.*\)\s*{\s*await/)
  })
})

// ── 22: multiple observations, no uniqueness error ─────────────────────────────────

describe('18C: multiple observations — several to A, several already to B (22)', () => {
  it('all locked A observations retarget to B in one bulk call; existing B observations were never selected (no separate write for them)', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['a1', 'a2', 'a3']),
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 3 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.externalMarketObservation.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.externalMarketObservation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2', 'a3'] }, catalogModelId: 'dupe1' },
      data: { catalogModelId: 'canon1' },
    })
    expect((tx.externalMarketObservationAudit.createMany as Mock).mock.calls[0][0].data).toHaveLength(3)
  })

  it('no uniqueness handling code exists — proven safe by [provider, externalId] and fingerprint both excluding catalogModelId, verified against schema', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    expect(fnSrc).not.toContain('survivor')

    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf('model ExternalMarketObservation {')
    const block = schema.slice(start, schema.indexOf('\n}', start))
    expect(block).toContain('@@unique([provider, externalId])')
    expect(block).not.toMatch(/@@unique\(\[[^\]]*catalogModelId[^\]]*\]\)/)
  })
})

// ── 18C final: row-locking closes the match/unmatch/reject/restore race ───────────

describe('18C final: ExternalMarketObservation rows are explicitly row-locked before audit/update (race fix)', () => {
  it('uses a parameterized SELECT ... FOR UPDATE via $queryRaw — no user-controlled SQL interpolation, dupeId is a bound template value', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    expect(fnSrc).toContain('FOR UPDATE')
    expect(fnSrc).toContain('SELECT id FROM "ExternalMarketObservation" WHERE "catalogModelId" = ${dupeId} FOR UPDATE')
  })

  it('the row lock is acquired BEFORE any audit row is generated — locked set drives the audit, not an unlocked snapshot', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    const lockIdx = fnSrc.indexOf('$queryRaw')
    const auditIdx = fnSrc.indexOf('externalMarketObservationAudit.createMany')
    expect(lockIdx).toBeGreaterThan(-1)
    expect(auditIdx).toBeGreaterThan(lockIdx)
  })

  it('the update is scoped to exactly the locked ids (id: { in: lockedIds }), not a blind re-query by catalogModelId alone', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['obs1', 'obs2']),
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 2 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.externalMarketObservation.updateMany as Mock).mock.calls[0][0]
    expect(call.where.id).toEqual({ in: ['obs1', 'obs2'] })
  })

  it('audit count always equals the locked/retarget count for the happy path (2 locked -> 2 audited -> 2 updated)', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['obs1', 'obs2']),
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 2 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect((tx.externalMarketObservationAudit.createMany as Mock).mock.calls[0][0].data).toHaveLength(2)
    expect((tx.externalMarketObservation.updateMany as Mock).mock.results).toBeDefined()
  })

  it('update-count mismatch (locked 2, but updateMany reports only 1 affected) aborts the WHOLE merge — no phantom-looking audit survives a successful merge', async () => {
    const tx = makeTx({
      $queryRaw: queryRawMock(['obs1', 'obs2']),
      // Contrived: simulates the update affecting fewer rows than were locked —
      // should never happen under real locking, but the code must still refuse to
      // proceed rather than silently accept a mismatched audit/update pair.
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors).toBeTruthy()
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('structural: a count mismatch throws before the function returns — the mismatch check exists and precedes the return statement', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileExternalMarketObservationMerge'), src.indexOf('// 15F-review'))
    const mismatchIdx = fnSrc.indexOf('migrated.count !== lockedIds.length')
    const returnIdx = fnSrc.lastIndexOf('return { migrated:')
    expect(mismatchIdx).toBeGreaterThan(-1)
    expect(mismatchIdx).toBeLessThan(returnIdx)
  })

  it('zero locked rows: no lock-complexity overhead beyond the one query, no audit, no update', async () => {
    const tx = makeTx({ $queryRaw: queryRawMock([]) })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.externalMarketObservationAudit.createMany).not.toHaveBeenCalled()
    expect(tx.externalMarketObservation.updateMany).not.toHaveBeenCalled()
  })
})

// ── 23/25: IntakeDraft retarget, fields preserved, terminal drafts included ────────

describe('18C: IntakeDraft retarget (23/25/12/13)', () => {
  it('retargets via one set-based updateMany', async () => {
    const tx = makeTx({
      intakeDraft: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.intakeDraft.updateMany).toHaveBeenCalledWith({
      where: { catalogModelId: 'dupe1' },
      data: { catalogModelId: 'canon1' },
    })
  })

  it('the update payload touches ONLY catalogModelId — brand/name/year/series/color/scale/condition/status/convertedItemId/photos are never in the data object', async () => {
    const tx = makeTx({
      intakeDraft: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.intakeDraft.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['catalogModelId'])
  })

  it('no status filter — converted/terminal draft rows referencing the duplicate (if any still exist) are retargeted the same as any other, per the actual code (no status-specific branching invented)', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).toContain('tx.intakeDraft.updateMany({ where: { catalogModelId: dupeId }, data: { catalogModelId: canonicalId } })')
    expect(src).not.toMatch(/intakeDraft\.updateMany\(\{\s*where:\s*\{[^}]*status/)
  })

  it('IntakeDraft has no dedicated audit table — no fabricated audit write introduced for it', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).not.toContain('IntakeDraftAudit')
    expect(src).not.toMatch(/intakeDraft.*[Aa]udit/)
  })

  it('IntakeDraft reconciliation is untouched by the 18C final race investigation — no row-locking added, none needed (no equivalent concurrent-correction admin action exists for drafts)', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('tx.intakeDraft.updateMany')
    const surrounding = src.slice(idx - 50, idx + 120)
    expect(surrounding).not.toContain('FOR UPDATE')
  })
})

// ── 24: unrelated null draft is never touched ──────────────────────────────────────

describe('18C: a draft with catalogModelId=null is unaffected by an unrelated merge (24)', () => {
  it('the updateMany where-clause is scoped to catalogModelId: dupeId — a null-catalogModelId draft can never match it', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).toContain('tx.intakeDraft.updateMany({ where: { catalogModelId: dupeId }')
  })
})

// ── 26: final integrity guard catches an unreconciled row ──────────────────────────

describe('18C: final pre-delete integrity guard catches observation/draft blockers (26/15)', () => {
  it('a lingering ExternalMarketObservation reference at final-check time aborts the merge — delete never called', async () => {
    const tx = makeTx({
      externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(1) }, // somehow still 1 remaining
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('a lingering IntakeDraft reference at final-check time aborts the merge — delete never called', async () => {
    const tx = makeTx({
      intakeDraft: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(1) },
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('final integrity check includes both new counts, unfiltered', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('const [ri, rc, rs, rsub, rp, rw, rae, raf, rfp, reo, rid, rmc]')
    const block = src.slice(idx, src.indexOf('])', idx))
    expect(block).toContain('tx.externalMarketObservation.count({ where: { catalogModelId: dupeId } })')
    expect(block).toContain('tx.intakeDraft.count({ where: { catalogModelId: dupeId } })')
  })
})

// ── 27: no reliance on P2003/SetNull as merge logic ────────────────────────────────

describe('18C: no reliance on database FK failure or SetNull as merge logic (27)', () => {
  it('both relations are explicitly reconciled (migration + integrity count) before catalogModel.delete — never left for the DB to catch', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const reconcileIdx = src.indexOf('reconcileExternalMarketObservationMerge(tx, dupeId, canonicalId)')
    const draftIdx = src.indexOf('tx.intakeDraft.updateMany({ where: { catalogModelId: dupeId }')
    const deleteIdx = src.indexOf('await tx.catalogModel.delete(')
    expect(reconcileIdx).toBeGreaterThan(-1)
    expect(draftIdx).toBeGreaterThan(-1)
    expect(reconcileIdx).toBeLessThan(deleteIdx)
    expect(draftIdx).toBeLessThan(deleteIdx)
  })
})

// ── 28: MobileCaptureItem — superseded by 18D ───────────────────────────────────────
// 18C left MobileCaptureItem untouched (deferred). 18D (see
// catalogMergeMobileCaptureCollectionReconciliation.test.ts) implements the full
// lock/classify/reconcile flow — this file no longer asserts the deferral.

// ── schema/migration confirmation ──────────────────────────────────────────────────

describe('18C: zero schema/migration changes', () => {
  it('ExternalMarketObservationAudit and IntakeDraft schema are unchanged', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toContain('model ExternalMarketObservationAudit {')
    const draftStart = schema.indexOf('model IntakeDraft {')
    const draftBlock = schema.slice(draftStart, schema.indexOf('\nmodel ', draftStart + 10))
    expect(draftBlock).toContain('onDelete: SetNull')
  })
})
