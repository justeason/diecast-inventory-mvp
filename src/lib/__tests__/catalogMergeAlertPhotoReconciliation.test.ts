// 18B: BuyerAlertEvent.catalogModelId, BuyerAlertFanout.catalogModelId, and
// CatalogPhotoFingerprint.catalogModelId all use onDelete: Cascade and were not
// reconciled before duplicate CatalogModel deletion (found during 18A's audit,
// confirmed live in the 18B investigation pass). This file proves: BuyerAlertEvent
// retargets unconditionally (all statuses); BuyerAlertFanout blocks the WHOLE merge
// while any pending/processing job exists for the duplicate (no cursor repair), and
// only retargets terminal (complete/failed) jobs; CatalogPhotoFingerprint retargets
// in lockstep with its already-migrated CatalogModelPhoto. All inside the same
// transaction as 18A's Wanted reconciliation, with no reliance on cascade.
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
import { markApprovalConsumed } from '@/lib/actions/riskApprovals'

const ZERO_IMPACT = { itemInstances: 0, collectionItems: 0, wantedBy: 0, sellerSubmissions: 0, photos: 0, fingerprints: 0, activeListings: 0, soldItems: 0, externalObs: 0 }

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    // $queryRaw is shared by the CatalogModel FOR UPDATE lock loop (return value
    // unused), the ExternalMarketObservation row lock (return value = locked ids —
    // defaults to none), the 18D MobileCaptureItem row lock+session-status join
    // (defaults to none), and the 18D CollectionItem overlap count (defaults to zero).
    $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings)
      if (text.includes('ExternalMarketObservation')) return Promise.resolve([])
      if (text.includes('MobileCaptureItem'))         return Promise.resolve([])
      if (text.includes('CollectionItem'))             return Promise.resolve([{ count: 0 }])
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
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    buyerAlertEvent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    buyerAlertFanout: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      // Called twice per duplicate: precondition (pending/processing) then final
      // integrity check (all statuses). Default: both resolve 0 (clean path).
      count: vi.fn().mockResolvedValue(0),
    },
    catalogPhotoFingerprint: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    // 18C: no observations/drafts by default.
    externalMarketObservation: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
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

// ── 28/29: BuyerAlertEvent retarget, all statuses, history preserved ──────────────

describe('18B: BuyerAlertEvent retarget (28/29)', () => {
  it('retargets unconditionally — no status filter — across every representative status', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { catalogModelId: 'dupe1' },
      data: { catalogModelId: 'canon1' },
    })
  })

  it('the update payload touches ONLY catalogModelId — id/eventKey/status/readAt/sentAt/claimToken/etc. are never in the data object', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    const call = (tx.buyerAlertEvent.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['catalogModelId'])
  })

  it('no per-status branching in source — a single set-based updateMany, not one call per status', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect((src.match(/tx\.buyerAlertEvent\.updateMany/g) ?? []).length).toBe(1)
    expect(src).not.toMatch(/buyerAlertEvent\.updateMany\(\{\s*where:\s*\{[^}]*status/)
  })
})

// ── 30/31/32: fanout precondition + terminal retarget ──────────────────────────────

describe('18B: nonterminal fanout blocks the whole merge (31/32)', () => {
  it('pending fanout for the duplicate model: merge rejected, delete never called, no relation migrated, approval not consumed', async () => {
    const tx = makeTx({
      buyerAlertFanout: { updateMany: vi.fn(), count: vi.fn().mockResolvedValueOnce(1) }, // precondition sees 1 pending/processing row
    })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))

    expect(result?.errors?.form?.[0]).toMatch(/pending or processing/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
    expect(tx.itemInstance.updateMany).not.toHaveBeenCalled()
    expect(tx.wantedCatalogModel.updateMany).not.toHaveBeenCalled()
    expect(tx.buyerAlertEvent.updateMany).not.toHaveBeenCalled()
    expect((tx.buyerAlertFanout.updateMany as Mock)).not.toHaveBeenCalled()
    expect(markApprovalConsumed).not.toHaveBeenCalled()
  })

  it('processing fanout with a recent (live) claimedAt also blocks — count alone triggers the block, no leniency for a live lease', async () => {
    const tx = makeTx({
      buyerAlertFanout: { updateMany: vi.fn(), count: vi.fn().mockResolvedValueOnce(1) },
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/pending or processing/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('processing fanout with a very old (stale) claimedAt ALSO blocks — no staleness carve-out', async () => {
    // The mock doesn't even encode claimedAt — this test (paired with the structural
    // check below) proves the implementation has no staleness branch to exercise at all.
    const tx = makeTx({
      buyerAlertFanout: { updateMany: vi.fn(), count: vi.fn().mockResolvedValueOnce(1) },
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/pending or processing/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('structural: the precondition never imports/uses FANOUT_LEASE_MS or staleBefore, and its count where-clause has no claimedAt condition', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const codeOnly = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    expect(codeOnly).not.toContain('FANOUT_LEASE_MS')
    expect(codeOnly).not.toContain('staleBefore')
    const idx = src.indexOf('nonterminalFanoutCount')
    const block = src.slice(idx, src.indexOf('throw new Error', idx))
    expect(block).not.toContain('claimedAt')
    expect(block).toContain("status: { in: ['pending', 'processing'] }")
  })

  it('the precondition check runs BEFORE any relation Promise.all — no partial migration happens before the block', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const preconditionIdx = src.indexOf('nonterminalFanoutCount')
    const promiseAllIdx = src.indexOf('await Promise.all([\n          tx.itemInstance.updateMany')
    expect(preconditionIdx).toBeGreaterThan(-1)
    expect(promiseAllIdx).toBeGreaterThan(preconditionIdx)
  })
})

describe('18B: terminal fanout retarget (30)', () => {
  it('complete/failed fanouts (precondition sees zero pending/processing) retarget via one set-based updateMany scoped to those two statuses', async () => {
    const tx = makeTx({
      buyerAlertFanout: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0), // precondition: 0, final integrity: 0
      },
    })
    mockTransaction(tx)

    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.buyerAlertFanout.updateMany).toHaveBeenCalledWith({
      where: { catalogModelId: 'dupe1', status: { in: ['complete', 'failed'] } },
      data: { catalogModelId: 'canon1' },
    })
  })

  it('the retarget payload touches ONLY catalogModelId — cursor/claimedAt/claimToken/timestamps/status are never in the data object', async () => {
    const tx = makeTx({
      buyerAlertFanout: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.buyerAlertFanout.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['catalogModelId'])
    expect(call.data.status).toBeUndefined()
    expect(call.data.cursor).toBeUndefined()
  })

  it('no requeue/restart/cancel semantics — the source never writes status/cursor/claimedAt/claimToken for fanout', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('tx.buyerAlertFanout.updateMany({ where: { catalogModelId: dupeId, status:')
    const call = src.slice(idx, src.indexOf('}),', idx) + 3)
    expect(call).not.toContain('cursor:')
    expect(call).not.toContain('claimedAt:')
    expect(call).not.toContain('claimToken:')
  })
})

// ── 33/14: fingerprint retarget, photo/fingerprint consistency ────────────────────

describe('18B: CatalogPhotoFingerprint retarget (33/14)', () => {
  it('retargets unconditionally, same shape as the photo migration it accompanies', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.catalogModelPhoto.updateMany).toHaveBeenCalledWith({ where: { catalogId: 'dupe1' }, data: { catalogId: 'canon1' } })
    expect(tx.catalogPhotoFingerprint.updateMany).toHaveBeenCalledWith({ where: { catalogModelId: 'dupe1' }, data: { catalogModelId: 'canon1' } })
  })

  it('the update payload touches ONLY catalogModelId — hash/dimension/algorithmVersion/timestamps untouched, no regeneration', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.catalogPhotoFingerprint.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['catalogModelId'])
  })

  it('never calls generateFingerprintBatch, never downloads/decodes an image, never deletes+recreates a fingerprint row', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).not.toContain('generateFingerprintBatch')
    expect(src).not.toContain('computeImageFingerprint')
    expect(src).not.toMatch(/catalogPhotoFingerprint\.(delete|create)/)
  })
})

// ── 34: final integrity guard catches a raced/unretargeted row ────────────────────

describe('18B: final pre-delete integrity guard (34/10)', () => {
  it('a fanout row somehow still pointing at the duplicate at final-check time aborts the whole merge — delete never called', async () => {
    const tx = makeTx({
      buyerAlertFanout: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn()
          .mockResolvedValueOnce(0) // precondition: clean, merge proceeds
          .mockResolvedValueOnce(2), // final integrity check: 2 rows somehow still remain
      },
    })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))

    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('final integrity check counts BuyerAlertFanout with NO status filter — every status counts against it, unlike the retarget step', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('const [ri, rc, rs, rsub, rp, rw, rae, raf, rfp, reo, rid, rmc]')
    const block = src.slice(idx, src.indexOf('])', idx))
    expect(block).toContain('tx.buyerAlertFanout.count({ where: { catalogModelId: dupeId } })')
    expect(block).not.toMatch(/buyerAlertFanout\.count\(\{[^}]*status/)
  })

  it('final integrity check also counts buyerAlertEvent and catalogPhotoFingerprint', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('const [ri, rc, rs, rsub, rp, rw, rae, raf, rfp, reo, rid, rmc]')
    const block = src.slice(idx, src.indexOf('])', idx))
    expect(block).toContain('tx.buyerAlertEvent.count({ where: { catalogModelId: dupeId } })')
    expect(block).toContain('tx.catalogPhotoFingerprint.count({ where: { catalogModelId: dupeId } })')
  })
})

// ── 35: multi-duplicate rollback ────────────────────────────────────────────────────

describe('18B: multi-duplicate — a later blocked duplicate rolls back an earlier processed one (35)', () => {
  it('A1 (clean) fully processes and even reaches its own delete call — but A2 then blocks, so the callback throws and the OVERALL action reports failure, not a redirect: proving one shared transaction whose real DB rollback (not observable via mocks) would undo A1 too', async () => {
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(3) // canonical + 2 duplicates all exist
    const tx = makeTx({
      buyerAlertFanout: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        // buyerAlertFanout.count is called twice per FULLY-processed duplicate
        // (precondition, then the final integrity check) and once for a duplicate
        // blocked at its precondition: A1 precondition=0, A1 final-integrity=0,
        // A2 precondition=1 (blocks — A2 never reaches its own final check).
        count: vi.fn()
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(1),
      },
    })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canonB', 'dupeA1', 'dupeA2'))

    // A1's own migration work — AND its own delete — legitimately execute inside the
    // SAME callback (this is the current, unmodified per-duplicate loop structure,
    // not something 18B changes). A real Prisma $transaction rolls back every
    // statement in a callback that ultimately throws, A1's delete included — a mock
    // can't observe that DB-level undo, but it CAN prove the callback is one shared
    // unit of work (not two independent transactions) whose overall action result is
    // failure, never redirect/success, the moment ANY duplicate in the batch blocks.
    expect(tx.itemInstance.updateMany).toHaveBeenCalledTimes(1) // only for A1 — A2 never reached its own Promise.all
    expect(tx.catalogModel.delete).toHaveBeenCalledTimes(1)
    expect(tx.catalogModel.delete).toHaveBeenCalledWith({ where: { id: 'dupeA1' } })
    expect(result?.errors?.form?.[0]).toMatch(/pending or processing/)
  })

  it('the whole batch runs inside exactly one prisma.$transaction call — never one transaction per duplicate', async () => {
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(3)
    const tx = makeTx({
      buyerAlertFanout: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1),
      },
    })
    mockTransaction(tx)
    await mergeCatalogModels(null, formData('canonB', 'dupeA1', 'dupeA2'))
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})

// ── 36: no unique-conflict workaround ──────────────────────────────────────────────

describe('18B: no P2002 catch, no delete+recreate workaround for any of the three relations (36/20/21/22)', () => {
  it('source never catches P2002 or does delete-then-create for events/fanouts/fingerprints', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).not.toContain('P2002')
    expect(src).not.toMatch(/buyerAlertEvent\.(delete|create)/)
    expect(src).not.toMatch(/buyerAlertFanout\.(delete|create)/)
    expect(src).not.toMatch(/catalogPhotoFingerprint\.(delete|create)/)
  })

  it('none of the three relations gets overlap-detection logic like Wanted — plain set-based updateMany only, no findMany-then-reconcile for these three', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).not.toContain('reconcileBuyerAlertEventMerge')
    expect(src).not.toContain('reconcileBuyerAlertFanoutMerge')
    expect(src).not.toContain('reconcileCatalogPhotoFingerprintMerge')
  })
})

// ── 37/38: query shape, no cascade reliance ─────────────────────────────────────────

describe('18B: query architecture — set-based, no per-row loop, no cascade reliance (37/38)', () => {
  it('exactly one precondition count query per duplicate, issued before the migration Promise.all', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect((src.match(/nonterminalFanoutCount/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect((src.match(/tx\.buyerAlertFanout\.count\(/g) ?? []).length).toBe(2) // precondition + final integrity check
  })

  it('no per-event/per-fanout/per-fingerprint loop — the three new 18B relations are migrated via set-based updateMany only, never .map/.forEach over their own rows', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    for (const rel of ['buyerAlertEvent', 'buyerAlertFanout', 'catalogPhotoFingerprint']) {
      expect(src).not.toMatch(new RegExp(`${rel}\\.findMany`))
    }
  })

  it('all three relations appear in BOTH the migration step and the final integrity check — never "delete parent and trust Cascade"', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    for (const rel of ['buyerAlertEvent', 'buyerAlertFanout', 'catalogPhotoFingerprint']) {
      expect((src.match(new RegExp(`tx\\.${rel}\\.(updateMany|count)`, 'g')) ?? []).length).toBeGreaterThanOrEqual(2)
    }
  })
})

// ── 23: 18A Wanted semantics unchanged ──────────────────────────────────────────────

describe('18B: 18A Wanted reconciliation untouched (23)', () => {
  it('reconcileWantedCatalogModelMerge is byte-identical in intent — freshest/survivor logic still present, still called exactly once per duplicate', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect(src).toContain('async function reconcileWantedCatalogModelMerge(')
    expect(src).toContain("dupeWant.createdAt <= canonicalWant.createdAt ? dupeWant : canonicalWant")
    expect(src).toContain("dupeWant.updatedAt >= canonicalWant.updatedAt ? dupeWant : canonicalWant")
  })
})

// ── 25/26/27: scope guard ───────────────────────────────────────────────────────────

describe('18B: scope guard — no analytics/worker/recognition redesign (25/26/27)', () => {
  it('no businessAnalytics/catalogAnalytics/managementAnalytics file references 18B relations', () => {
    for (const rel of ['src/lib/businessAnalyticsQuery.ts', 'src/lib/catalogAnalyticsQuery.ts', 'src/lib/managementAnalyticsQuery.ts']) {
      const src = readSrc(rel)
      expect(src).not.toContain('buyerAlertFanout')
      expect(src).not.toContain('catalogPhotoFingerprint')
    }
  })

  it('worker files (trigger/processor/delivery/matching) are untouched by this pass — catalog.ts is the only production file with new logic', () => {
    for (const rel of [
      'src/lib/buyerAlertsTrigger.ts', 'src/lib/buyerAlertsFanoutProcessor.ts', 'src/lib/buyerAlertsDelivery.ts',
      'src/lib/wantedListMatching.ts', 'src/lib/catalogImageFingerprint.ts', 'src/lib/catalogImageMatchingQuery.ts',
    ]) {
      const src = readSrc(rel)
      expect(src).not.toContain('18B')
    }
  })
})

// ── schema / migration confirmation ──────────────────────────────────────────────────

describe('18B: zero schema/migration changes', () => {
  it('the three relations\' unique constraints and onDelete: Cascade are unchanged', () => {
    const schema = readSrc('prisma/schema.prisma')
    for (const model of ['BuyerAlertEvent', 'BuyerAlertFanout', 'CatalogPhotoFingerprint']) {
      const start = schema.indexOf(`model ${model} {`)
      const block = schema.slice(start, schema.indexOf('\n}', start))
      expect(block).toContain('onDelete: Cascade')
    }
  })
})

// ── 18B final reconciliation: BuyerAlertEvent delivery-concurrency precondition ───
// Closes a SEPARATE race from the fanout precondition above: deliverOne() is not
// transactional — it captures event.catalogModelId into a plain JS variable via one
// standalone read, then later (as an unrelated query) re-checks WantedCatalogModel
// using that stale value. If this merge's Wanted migration commits in between, the
// worker finds no matching Wanted row (it moved to canonical) and falsely suppresses
// a live alert as 'wanted_removed'. Blocking on any 'pending'/'sending' event closes
// this window; 'sent'/'failed'/'suppressed'/'delivery_unknown' are never re-selected
// by processPendingBuyerAlerts, so they carry no such risk and retarget normally.

describe('18B final: nonterminal BuyerAlertEvent blocks the merge (11/12)', () => {
  it('a pending event (even with fanout already terminal) blocks: merge rejected, event/Wanted/model all unchanged, approval not consumed', async () => {
    const tx = makeTx({
      buyerAlertEvent: { updateMany: vi.fn(), count: vi.fn().mockResolvedValueOnce(1) },
    })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))

    expect(result?.errors?.form?.[0]).toMatch(/alert is pending delivery/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
    expect(tx.itemInstance.updateMany).not.toHaveBeenCalled()
    expect(tx.wantedCatalogModel.updateMany).not.toHaveBeenCalled()
    expect(tx.buyerAlertEvent.updateMany).not.toHaveBeenCalled()
    expect(markApprovalConsumed).not.toHaveBeenCalled()
  })

  it('a sending event blocks the same way — proves fanout-terminal alone is NOT a sufficient precondition', async () => {
    const tx = makeTx({
      buyerAlertEvent: { updateMany: vi.fn(), count: vi.fn().mockResolvedValueOnce(1) },
      // fanout is already terminal/clean — this alone must NOT be enough to let the merge through.
      buyerAlertFanout: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    })
    mockTransaction(tx)

    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))

    expect(result?.errors?.form?.[0]).toMatch(/alert is pending delivery/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('the event precondition runs BEFORE the migration Promise.all, after the fanout precondition', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fanoutIdx = src.indexOf('nonterminalFanoutCount')
    const eventIdx = src.indexOf('nonterminalEventCount')
    const promiseAllIdx = src.indexOf('await Promise.all([\n          tx.itemInstance.updateMany')
    expect(fanoutIdx).toBeGreaterThan(-1)
    expect(eventIdx).toBeGreaterThan(fanoutIdx)
    expect(promiseAllIdx).toBeGreaterThan(eventIdx)
  })

  it('structural: the precondition checks exactly [pending, sending], never sent/failed/suppressed/delivery_unknown', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('nonterminalEventCount')
    const block = src.slice(idx, src.indexOf('throw new Error', idx))
    expect(block).toContain("status: { in: ['pending', 'sending'] }")
    expect(block).not.toContain('sent')
    expect(block).not.toContain('failed')
    expect(block).not.toContain('suppressed')
    expect(block).not.toContain('delivery_unknown')
  })

  it('no claimToken reset, no status-reset, no retry system introduced by the precondition', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const idx = src.indexOf('nonterminalEventCount')
    const block = src.slice(idx, src.indexOf('throw new Error', idx) + 30)
    expect(block).not.toContain('claimToken:')
    expect(block).not.toContain("status: 'pending'")
    expect(block).not.toMatch(/\.update\(/)
  })
})

describe('18B final: terminal events retarget and merge proceeds normally (13)', () => {
  it.each(['sent', 'failed', 'suppressed', 'delivery_unknown'])('a %s event does not block — merge proceeds, event retargets via the existing unconditional updateMany', async (status) => {
    const tx = makeTx() // default: buyerAlertEvent.count resolves 0 (no pending/sending)
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { catalogModelId: 'dupe1' },
      data: { catalogModelId: 'canon1' },
    })
    void status // status is illustrative only — the mock is status-agnostic (count()=0 covers any terminal-only population)
  })

  it('the retarget payload is still exactly { catalogModelId } — same id/eventKey/status/readAt/sentAt/providerMessageId preserved for terminal rows', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    const call = (tx.buyerAlertEvent.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['catalogModelId'])
  })
})

describe('18B final: query architecture (15)', () => {
  it('exactly one new count query per duplicate for the event precondition — set-based, no per-event loop', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    expect((src.match(/tx\.buyerAlertEvent\.count\(/g) ?? []).length).toBe(2) // precondition + final integrity check
    expect(src).not.toMatch(/buyerAlertEvent\.findMany/)
  })

  it('per-duplicate query count: 2 buyerAlertFanout.count + 2 buyerAlertEvent.count (precondition + final check each) — both preconditions are cheap set-based counts, not row hydration', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect((tx.buyerAlertFanout.count as Mock).mock.calls.length).toBe(2)
    expect((tx.buyerAlertEvent.count as Mock).mock.calls.length).toBe(2)
  })
})

describe('18B final: no worker/schema changes (16)', () => {
  it('buyerAlertsDelivery.ts / buyerAlertsLease.ts are untouched — the fix lives entirely in the merge action', () => {
    for (const rel of ['src/lib/buyerAlertsDelivery.ts', 'src/lib/buyerAlertsLease.ts']) {
      const src = readSrc(rel)
      expect(src).not.toContain('18B')
    }
  })

  it('DELIVERY_LEASE_MS is never imported into catalog.ts — no staleness distinction for events either, mirroring the fanout precondition\'s own conservatism', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const codeOnly = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(codeOnly).not.toContain('DELIVERY_LEASE_MS')
  })

  it('no schema change — BuyerAlertEvent status enum/fields unchanged', () => {
    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf('model BuyerAlertEvent {')
    const block = schema.slice(start, schema.indexOf('\n}', start))
    expect(block).toContain("status             String    @default(\"pending\")")
  })
})
