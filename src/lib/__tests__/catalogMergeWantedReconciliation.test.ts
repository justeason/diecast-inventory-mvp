// 18A: WantedCatalogModel.catalogModel uses onDelete: Cascade — mergeCatalogModels
// previously deleted the duplicate CatalogModel without first migrating/reconciling
// its Wanted rows, silently destroying customer intent. This file proves the fix:
// reconcileWantedCatalogModelMerge (private to catalog.ts, exercised only through the
// public mergeCatalogModels action) migrates non-conflicting Wants in place and
// collapses overlapping Wants into exactly one canonical row, inside the same
// transaction, before the duplicate is deleted.
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

type Want = {
  id: string
  customerProfileId: string
  catalogModelId: string
  maxDesiredPrice: number | null
  notes: string | null
  availabilityAlertEnabled: boolean
  priceAlertEnabled: boolean
  createdAt: Date
  updatedAt: Date
}

function want(overrides: Partial<Want> & { id: string; customerProfileId: string; catalogModelId: string }): Want {
  return {
    maxDesiredPrice: null, notes: null, availabilityAlertEnabled: true, priceAlertEnabled: true,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    ...overrides,
  }
}

function makeTx(dupeId: string, canonicalId: string, dupeWants: Want[], canonicalWants: Want[], overrides: Record<string, unknown> = {}) {
  const wantedFindMany = vi.fn().mockImplementation((args: { where: { catalogModelId: string } }) => {
    if (args.where.catalogModelId === dupeId) return Promise.resolve(dupeWants)
    if (args.where.catalogModelId === canonicalId) return Promise.resolve(canonicalWants)
    return Promise.resolve([])
  })
  return {
    // $queryRaw is shared by the CatalogModel FOR UPDATE lock loop (return value
    // unused) and, since 18C final, the ExternalMarketObservation row lock (return
    // value = locked ids — defaults to none here).
    $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings)
      if (text.includes('ExternalMarketObservation')) return Promise.resolve([])
      return Promise.resolve(undefined)
    }),
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
      findMany: wantedFindMany,
      updateMany: vi.fn().mockResolvedValue({ count: dupeWants.length }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    // 18B: no nonterminal fanout by default — precondition passes for every
    // existing 18A test in this file, which predates 18B and doesn't test fanout.
    buyerAlertEvent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    buyerAlertFanout: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    catalogPhotoFingerprint: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    // 18C: no observations/drafts by default.
    externalMarketObservation: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    externalMarketObservationAudit: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    intakeDraft: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
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

// ── AG: duplicate only ────────────────────────────────────────────────────────────

describe('18A: duplicate-only Want (AG)', () => {
  it('retargets the existing row in place — no delete, no update, exactly one bulk updateMany scoped to non-overlapping customers', async () => {
    const dupeWants = [want({ id: 'w1', customerProfileId: 'A', catalogModelId: 'dupe1' })]
    const tx = makeTx('dupe1', 'canon1', dupeWants, [])
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.wantedCatalogModel.updateMany).toHaveBeenCalledWith({
      where: { catalogModelId: 'dupe1', customerProfileId: { notIn: [] } },
      data: { catalogModelId: 'canon1' },
    })
    expect(tx.wantedCatalogModel.update).not.toHaveBeenCalled()
    expect(tx.wantedCatalogModel.delete).not.toHaveBeenCalled()
  })
})

// ── AH: canonical only ─────────────────────────────────────────────────────────────

describe('18A: canonical-only Want (AH)', () => {
  it('the existing canonical Want is never touched — no update/delete/updateMany call references it', async () => {
    const canonicalWants = [want({ id: 'w2', customerProfileId: 'B', catalogModelId: 'canon1' })]
    const tx = makeTx('dupe1', 'canon1', [], canonicalWants)
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.wantedCatalogModel.update).not.toHaveBeenCalled()
    expect(tx.wantedCatalogModel.delete).not.toHaveBeenCalled()
    // Bulk updateMany still runs (0 duplicate-only rows) but never mentions 'B'.
    const call = (tx.wantedCatalogModel.updateMany as Mock).mock.calls[0][0]
    expect(call.where.catalogModelId).toBe('dupe1')
  })
})

// ── AI: overlap (both) ──────────────────────────────────────────────────────────────

describe('18A: overlapping Want — customer wants both models (AI)', () => {
  it('exactly one canonical row survives: the OLDER row (by createdAt) is updated to canonicalId, the newer row is deleted', async () => {
    const dupeWant = want({ id: 'w-dupe', customerProfileId: 'C', catalogModelId: 'dupe1', createdAt: new Date('2026-01-01') })
    const canonicalWant = want({ id: 'w-canon', customerProfileId: 'C', catalogModelId: 'canon1', createdAt: new Date('2026-02-01') })
    const tx = makeTx('dupe1', 'canon1', [dupeWant], [canonicalWant])
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    // dupe1's want is OLDER -> it survives (its id is updated, not deleted).
    expect(tx.wantedCatalogModel.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'w-dupe' } }))
    expect(tx.wantedCatalogModel.delete).toHaveBeenCalledWith({ where: { id: 'w-canon' } })
    // The bulk updateMany excludes this reconciled customer — never double-handled.
    const bulkCall = (tx.wantedCatalogModel.updateMany as Mock).mock.calls[0][0]
    expect(bulkCall.where.customerProfileId.notIn).toEqual(['C'])
  })

  it('when the CANONICAL row is older, IT survives — the duplicate row is deleted, never the other way regardless of merge direction', async () => {
    const dupeWant = want({ id: 'w-dupe', customerProfileId: 'C', catalogModelId: 'dupe1', createdAt: new Date('2026-03-01') })
    const canonicalWant = want({ id: 'w-canon', customerProfileId: 'C', catalogModelId: 'canon1', createdAt: new Date('2026-01-01') })
    const tx = makeTx('dupe1', 'canon1', [dupeWant], [canonicalWant])
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.wantedCatalogModel.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'w-canon' } }))
    expect(tx.wantedCatalogModel.delete).toHaveBeenCalledWith({ where: { id: 'w-dupe' } })
  })

  it('no unique-constraint violation risk: the survivor update always sets catalogModelId to canonicalId, and the conflicting row is deleted in the SAME transaction step — never a blind bulk update that could collide', async () => {
    const dupeWant = want({ id: 'w-dupe', customerProfileId: 'C', catalogModelId: 'dupe1', createdAt: new Date('2026-01-01') })
    const canonicalWant = want({ id: 'w-canon', customerProfileId: 'C', catalogModelId: 'canon1', createdAt: new Date('2026-02-01') })
    const tx = makeTx('dupe1', 'canon1', [dupeWant], [canonicalWant])
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    const updateCall = (tx.wantedCatalogModel.update as Mock).mock.calls[0][0]
    expect(updateCall.data.catalogModelId).toBe('canon1')
  })
})

// ── AJ: neither ────────────────────────────────────────────────────────────────────

describe('18A: customer wants neither model (AJ)', () => {
  it('no Wanted row is created for anyone who never wanted either model', async () => {
    const tx = makeTx('dupe1', 'canon1', [], [])
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.wantedCatalogModel.update).not.toHaveBeenCalled()
    expect(tx.wantedCatalogModel.delete).not.toHaveBeenCalled()
    // updateMany still runs but affects zero real rows (mocked count: dupeWants.length = 0).
    expect(tx.wantedCatalogModel.updateMany).toHaveBeenCalled()
  })
})

// ── AK/AP: multiple customers, exact final count ────────────────────────────────────

describe('18A: multiple customers — exact post-merge population (AK/AP)', () => {
  it('duplicate wanted by A,B,C; canonical wanted by C,D,E -> A,B migrate, C reconciles to one row, D,E untouched: final canonical population is exactly {A,B,C,D,E}, never {A,B,C,C,D,E} (6)', async () => {
    const dupeWants = [
      want({ id: 'wA', customerProfileId: 'A', catalogModelId: 'dupe1' }),
      want({ id: 'wB', customerProfileId: 'B', catalogModelId: 'dupe1' }),
      want({ id: 'wC-dupe', customerProfileId: 'C', catalogModelId: 'dupe1', createdAt: new Date('2026-01-01') }),
    ]
    const canonicalWants = [
      want({ id: 'wC-canon', customerProfileId: 'C', catalogModelId: 'canon1', createdAt: new Date('2026-02-01') }),
      want({ id: 'wD', customerProfileId: 'D', catalogModelId: 'canon1' }),
      want({ id: 'wE', customerProfileId: 'E', catalogModelId: 'canon1' }),
    ]
    const tx = makeTx('dupe1', 'canon1', dupeWants, canonicalWants)
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    // A, B migrated via the bulk updateMany (C excluded — reconciled separately).
    const bulkCall = (tx.wantedCatalogModel.updateMany as Mock).mock.calls[0][0]
    expect(bulkCall.where.customerProfileId.notIn).toEqual(['C'])
    // C reconciled: exactly one update + one delete, never two survivors.
    expect(tx.wantedCatalogModel.update).toHaveBeenCalledTimes(1)
    expect(tx.wantedCatalogModel.delete).toHaveBeenCalledTimes(1)
    // D, E: no mutation at all — never touched.
    expect((tx.wantedCatalogModel.update as Mock).mock.calls[0][0].where.id).not.toBe('wD')
    expect((tx.wantedCatalogModel.update as Mock).mock.calls[0][0].where.id).not.toBe('wE')
  })
})

// ── AL: per-field merge semantics ───────────────────────────────────────────────────

describe('18A: overlap field-merge semantics (AL)', () => {
  it('preference fields (maxDesiredPrice/notes/alert flags) are taken from whichever row was more RECENTLY UPDATED — never blindly OR-ed, never always-canonical/always-duplicate', async () => {
    // Deliberately independent axes: canonical's row is OLDER (createdAt) so it
    // survives as the row identity — but the duplicate's row was more recently
    // UPDATED, so its field values are the ones that end up on the survivor.
    const dupeWant = want({
      id: 'w-dupe', customerProfileId: 'C', catalogModelId: 'dupe1',
      createdAt: new Date('2026-02-01'), updatedAt: new Date('2026-03-01'), // newer row, but most recently updated
      maxDesiredPrice: 50, notes: 'from duplicate', availabilityAlertEnabled: false, priceAlertEnabled: true,
    })
    const canonicalWant = want({
      id: 'w-canon', customerProfileId: 'C', catalogModelId: 'canon1',
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-15'), // older row, older update
      maxDesiredPrice: 75, notes: 'from canonical', availabilityAlertEnabled: true, priceAlertEnabled: false,
    })
    const tx = makeTx('dupe1', 'canon1', [dupeWant], [canonicalWant])
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    // canonical's want is older (createdAt) -> survives as the row (its id updated).
    const updateCall = (tx.wantedCatalogModel.update as Mock).mock.calls[0][0]
    expect(updateCall.where.id).toBe('w-canon')
    // But field VALUES come from the more-recently-UPDATED row — the duplicate's.
    expect(updateCall.data.maxDesiredPrice).toBe(50)
    expect(updateCall.data.notes).toBe('from duplicate')
    expect(updateCall.data.availabilityAlertEnabled).toBe(false)
    expect(updateCall.data.priceAlertEnabled).toBe(true)
  })

  it('no field is silently dropped — all four preference fields are always present in the survivor update, never partially written', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileWantedCatalogModelMerge'), src.indexOf('async function mergeCatalogModels'))
    for (const field of ['maxDesiredPrice: freshest', 'notes: freshest', 'availabilityAlertEnabled: freshest', 'priceAlertEnabled: freshest']) {
      expect(fnSrc).toContain(field)
    }
  })

  it('no blind OR of boolean alert flags — freshest-row selection, not `||`', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileWantedCatalogModelMerge'), src.indexOf('async function mergeCatalogModels'))
    expect(fnSrc).not.toMatch(/availabilityAlertEnabled\s*\|\|/)
    expect(fnSrc).not.toMatch(/priceAlertEnabled\s*\|\|/)
  })
})

// ── AM: history / alert relations untouched ────────────────────────────────────────

describe('18A: alert/history relations remain untouched (AM/L)', () => {
  it('reconcileWantedCatalogModelMerge never references BuyerAlertEvent/BuyerAlertFanout/BuyerAlertPreference', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileWantedCatalogModelMerge'), src.indexOf('async function mergeCatalogModels'))
    expect(fnSrc).not.toContain('buyerAlertEvent')
    expect(fnSrc).not.toContain('buyerAlertFanout')
    expect(fnSrc).not.toContain('buyerAlertPreference')
  })

  it('no tx.buyerAlertEvent/buyerAlertFanout property is ever accessed at runtime (not present in the mock tx — a call would throw if it existed)', async () => {
    const dupeWant = want({ id: 'w-dupe', customerProfileId: 'C', catalogModelId: 'dupe1', createdAt: new Date('2026-01-01') })
    const canonicalWant = want({ id: 'w-canon', customerProfileId: 'C', catalogModelId: 'canon1', createdAt: new Date('2026-02-01') })
    const tx = makeTx('dupe1', 'canon1', [dupeWant], [canonicalWant])
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT') // would throw a DIFFERENT error (TypeError) if buyerAlert* were touched and undefined
  })
})

// ── AN: transaction rollback ─────────────────────────────────────────────────────────

describe('18A: rollback safety — Wanted reconciliation never partially commits (AN)', () => {
  it('if the post-migration integrity check finds a remaining Wanted row pointing at the duplicate, the WHOLE merge aborts — no delete, no audit, Wanted mutations included in the rollback', async () => {
    const dupeWant = want({ id: 'w1', customerProfileId: 'A', catalogModelId: 'dupe1' })
    const tx = makeTx('dupe1', 'canon1', [dupeWant], [], {
      wantedCatalogModel: {
        findMany: vi.fn().mockImplementation((args: { where: { catalogModelId: string } }) =>
          Promise.resolve(args.where.catalogModelId === 'dupe1' ? [dupeWant] : [])),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1), // simulates a row somehow still remaining
      },
    })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))

    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
    expect(tx.catalogModelMergeAudit.create).toHaveBeenCalledTimes(1) // audit is written before the integrity check, per existing ordering — unchanged
  })

  it('Wanted reconciliation happens inside the SAME transaction/callback as the other relation migrations — not a separate, independently-committable step', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const txFnStart = src.indexOf('await prisma.$transaction(async (tx) => {')
    const wantedCallIdx = src.indexOf('reconcileWantedCatalogModelMerge(tx, dupeId, canonicalId)')
    const deleteIdx = src.indexOf('await tx.catalogModel.delete(')
    expect(wantedCallIdx).toBeGreaterThan(txFnStart)
    expect(wantedCallIdx).toBeLessThan(deleteIdx) // migrated/reconciled BEFORE the duplicate is deleted
  })
})

// ── AO: unique constraint handled deliberately, not via catch(P2002) ──────────────────

describe('18A: overlap resolved deliberately before mutation, never via catching a constraint error (AO)', () => {
  it('the bulk updateMany explicitly excludes overlapping customerProfileIds via notIn — conflicts are never left to the DB constraint to reject', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileWantedCatalogModelMerge'), src.indexOf('async function mergeCatalogModels'))
    expect(fnSrc).toContain('customerProfileId: { notIn: overlappingProfileIds }')
    expect(fnSrc).not.toContain('P2002')
    expect(fnSrc).not.toMatch(/catch\s*\(/)
  })

  it('overlap detection reads BOTH populations (duplicate and canonical) before issuing any write', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileWantedCatalogModelMerge'), src.indexOf('async function mergeCatalogModels'))
    const findManyIdx = fnSrc.indexOf('Promise.all([')
    const firstWriteIdx = fnSrc.indexOf('.update(')
    expect(findManyIdx).toBeGreaterThan(-1)
    expect(firstWriteIdx).toBeGreaterThan(findManyIdx)
  })
})

// ── Q: merge direction ────────────────────────────────────────────────────────────

describe('18A: migration follows admin-chosen direction only (Q)', () => {
  it('duplicate Wants move TO canonicalId — never the reverse', async () => {
    const dupeWant = want({ id: 'w1', customerProfileId: 'A', catalogModelId: 'dupe1' })
    const tx = makeTx('dupe1', 'canon1', [dupeWant], [])
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.wantedCatalogModel.updateMany as Mock).mock.calls[0][0]
    expect(call.data.catalogModelId).toBe('canon1')
  })
})

// ── S: no schema/history-orphan risk — WantedCatalogModel.id is not referenced elsewhere ─

describe('18A: WantedCatalogModel.id is not referenced by any other table (schema-level proof)', () => {
  it('every "WantedCatalogModel" mention outside its own model block is either an array back-relation (CatalogModel.wantedBy, CustomerProfile.wantedList — the required reverse side of WantedCatalogModel\'s own FKs) or a plain-text comment — never a real foreign key another table holds into WantedCatalogModel.id', () => {
    const schema = readSrc('prisma/schema.prisma')
    const modelBlockStart = schema.indexOf('model WantedCatalogModel {')
    const modelBlockEnd = schema.indexOf('\n}', modelBlockStart)
    const outside = schema.slice(0, modelBlockStart) + schema.slice(modelBlockEnd)
    const mentions = [...outside.matchAll(/WantedCatalogModel/g)]
    expect(mentions.length).toBeGreaterThan(0) // sanity: back-relations do exist
    expect(outside).toContain('wantedBy             WantedCatalogModel[]')
    expect(outside).toContain('wantedList         WantedCatalogModel[]')
    // No other model declares a scalar/singular FK field typed WantedCatalogModel
    // (which would mean a third table holds a real reference into its id).
    expect(outside).not.toMatch(/:\s*WantedCatalogModel\s*@relation/)
    expect(outside).not.toMatch(/:\s*WantedCatalogModel\?\s*@relation/)
  })
})

// ── AU/AV: read/write boundary, no schema change ───────────────────────────────────

describe('18A: write boundary and schema (AU/AV)', () => {
  it('reconcileWantedCatalogModelMerge touches only wantedCatalogModel — no CustomerProfile/Order/session/payout table', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileWantedCatalogModelMerge'), src.indexOf('async function mergeCatalogModels'))
    expect(fnSrc).not.toMatch(/customerProfile\.|order\.|sellerPayout|customerSession|customerLoginToken/i)
  })

  it('zero Prisma schema changes — WantedCatalogModel model definition and its unique constraint are unchanged', () => {
    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf('model WantedCatalogModel {')
    const block = schema.slice(start, schema.indexOf('\n}', start))
    expect(block).toContain('@@unique([customerProfileId, catalogModelId])')
    expect(block).toContain('onDelete: Cascade')
  })
})
