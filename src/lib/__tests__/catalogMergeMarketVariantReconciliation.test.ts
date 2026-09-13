// 21B §25-29: MarketVariant merge reconciliation. Because uniqueness is only
// [catalogModelId, packagingType], the duplicate's own Carded/Loose rows can never
// be re-pointed to the canonical CatalogModel directly (collision with canonical's
// own pre-existing rows) — instead every child FK (ItemInstance/IntakeDraft/
// ExternalMarketObservation/OrderItem) is re-pointed from the duplicate's variant
// id to canonical's (matched by packagingType), then the duplicate's now-orphaned
// MarketVariant rows are explicitly deleted. OrderItem also gets a direct
// catalogModelId repoint (§26) — its snapshot fields must never be touched.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

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

const DUPE_CARDED = 'dupe-carded-1'
const DUPE_LOOSE = 'dupe-loose-1'
const CANON_CARDED = 'canon-carded-1'
const CANON_LOOSE = 'canon-loose-1'

function queryRawMock() {
  return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings)
    if (text.includes('CollectionItem')) return Promise.resolve([{ count: 0 }])
    // CatalogModel FOR UPDATE, MarketVariant FOR UPDATE, MobileCaptureItem,
    // GuestSellerItem — return value unused/defaults to none locked.
    return Promise.resolve([])
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
    externalMarketObservation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    externalMarketObservationAudit: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    intakeDraft: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    mobileCaptureItem: {
      findMany:   vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count:      vi.fn().mockResolvedValue(0),
    },
    guestSellerItem: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    // Each CatalogModel has exactly Carded + Loose by default.
    marketVariant: {
      findMany: vi.fn().mockImplementation((args: { where: { catalogModelId: string } }) => {
        if (args.where.catalogModelId === 'dupe1') {
          return Promise.resolve([
            { id: DUPE_CARDED, packagingType: 'carded' },
            { id: DUPE_LOOSE, packagingType: 'loose' },
          ])
        }
        if (args.where.catalogModelId === 'canon1') {
          return Promise.resolve([
            { id: CANON_CARDED, packagingType: 'carded' },
            { id: CANON_LOOSE, packagingType: 'loose' },
          ])
        }
        return Promise.resolve([])
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      count: vi.fn().mockResolvedValue(0),
    },
    orderItem: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
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

describe('mergeCatalogModels — MarketVariant reconciliation (21B)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(2)
    ;(computeImpactCounts as Mock).mockResolvedValue(ZERO_IMPACT)
  })

  it('repoints ItemInstance/IntakeDraft/ExternalMarketObservation/OrderItem.marketVariantId from each duplicate variant to the matching canonical variant (by packagingType)', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.itemInstance.updateMany).toHaveBeenCalledWith({ where: { marketVariantId: DUPE_CARDED }, data: { marketVariantId: CANON_CARDED } })
    expect(tx.itemInstance.updateMany).toHaveBeenCalledWith({ where: { marketVariantId: DUPE_LOOSE }, data: { marketVariantId: CANON_LOOSE } })
    expect(tx.intakeDraft.updateMany).toHaveBeenCalledWith({ where: { marketVariantId: DUPE_CARDED }, data: { marketVariantId: CANON_CARDED } })
    expect(tx.externalMarketObservation.updateMany).toHaveBeenCalledWith({ where: { marketVariantId: DUPE_LOOSE }, data: { marketVariantId: CANON_LOOSE } })
    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({ where: { marketVariantId: DUPE_CARDED }, data: { marketVariantId: CANON_CARDED } })
  })

  it('never re-points a duplicate MarketVariant row\'s own catalogModelId directly — always deletes it after children are repointed', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.marketVariant.deleteMany).toHaveBeenCalledWith({ where: { catalogModelId: 'dupe1' } })
    // No update/upsert ever targets MarketVariant.catalogModelId itself.
    expect((tx.marketVariant as { update?: unknown }).update).toBeUndefined()
  })

  it('also repoints OrderItem.catalogModelId (the direct identity pointer) dupe -> canonical', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({ where: { catalogModelId: 'dupe1' }, data: { catalogModelId: 'canon1' } })
  })

  it('never writes OrderItem.snapshotPackagingType or snapshotCondition during merge — immutable sale facts', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    for (const call of (tx.orderItem.updateMany as Mock).mock.calls) {
      const data = call[0].data
      expect(data).not.toHaveProperty('snapshotPackagingType')
      expect(data).not.toHaveProperty('snapshotCondition')
      expect(data).not.toHaveProperty('snapshotProvenance') // 21C
    }
  })

  it('deterministically locks MarketVariant rows only AFTER every CatalogModel row is already locked', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')

    const calls = (tx.$queryRaw as Mock).mock.calls
    const textOf = (c: unknown[]) => (Array.isArray(c[0]) ? (c[0] as unknown as string[]).join('') : String(c[0]))
    const catalogModelLockIdxs = calls.map((c, i) => (textOf(c).includes('CatalogModel') && textOf(c).includes('FOR UPDATE') ? i : -1)).filter((i) => i >= 0)
    const marketVariantLockIdxs = calls.map((c, i) => (textOf(c).includes('MarketVariant') ? i : -1)).filter((i) => i >= 0)
    expect(catalogModelLockIdxs.length).toBeGreaterThan(0)
    expect(marketVariantLockIdxs.length).toBeGreaterThan(0)
    expect(Math.min(...marketVariantLockIdxs)).toBeGreaterThan(Math.max(...catalogModelLockIdxs))
  })

  it('a leftover reference to a duplicate variant id at final-check time aborts the whole merge', async () => {
    const tx = makeTx({
      itemInstance: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        // First count() call is the plain catalogId-based check (ri); simulate the
        // SECOND itemInstance.count() call (rivar, the marketVariantId leftover
        // check) returning 1 — a leftover reference.
        count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
      },
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('final integrity check counts marketVariant rows still pointing at the duplicate CatalogModel — nonzero aborts', async () => {
    const tx = makeTx({
      marketVariant: {
        findMany: vi.fn().mockImplementation((args: { where: { catalogModelId: string } }) => {
          if (args.where.catalogModelId === 'dupe1') return Promise.resolve([{ id: DUPE_CARDED, packagingType: 'carded' }, { id: DUPE_LOOSE, packagingType: 'loose' }])
          if (args.where.catalogModelId === 'canon1') return Promise.resolve([{ id: CANON_CARDED, packagingType: 'carded' }, { id: CANON_LOOSE, packagingType: 'loose' }])
          return Promise.resolve([])
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        count: vi.fn().mockResolvedValue(1), // simulate a row somehow surviving deletion
      },
    })
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/reference\(s\) still point to the duplicate/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('when the duplicate has no MarketVariant rows at all (defensive edge case), no children are touched and no deleteMany is a no-op count of zero', async () => {
    const tx = makeTx({
      marketVariant: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(0),
      },
    })
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.itemInstance.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ marketVariantId: expect.anything() }) }))
  })

  it('multi-duplicate merge repoints each duplicate\'s own variant pair independently', async () => {
    const tx = makeTx({
      marketVariant: {
        findMany: vi.fn().mockImplementation((args: { where: { catalogModelId: string } }) => {
          const map: Record<string, Array<{ id: string; packagingType: string }>> = {
            canon1: [{ id: CANON_CARDED, packagingType: 'carded' }, { id: CANON_LOOSE, packagingType: 'loose' }],
            dupeA: [{ id: 'dupeA-carded', packagingType: 'carded' }, { id: 'dupeA-loose', packagingType: 'loose' }],
            dupeB: [{ id: 'dupeB-carded', packagingType: 'carded' }, { id: 'dupeB-loose', packagingType: 'loose' }],
          }
          return Promise.resolve(map[args.where.catalogModelId] ?? [])
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        count: vi.fn().mockResolvedValue(0),
      },
    })
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(3)
    mockTransaction(tx)
    const fd = new FormData()
    fd.set('canonicalId', 'canon1')
    fd.append('duplicateId', 'dupeA')
    fd.append('duplicateId', 'dupeB')
    await expect(mergeCatalogModels(null, fd)).rejects.toThrow('REDIRECT')

    expect(tx.itemInstance.updateMany).toHaveBeenCalledWith({ where: { marketVariantId: 'dupeA-carded' }, data: { marketVariantId: CANON_CARDED } })
    expect(tx.itemInstance.updateMany).toHaveBeenCalledWith({ where: { marketVariantId: 'dupeB-carded' }, data: { marketVariantId: CANON_CARDED } })
    expect(tx.marketVariant.deleteMany).toHaveBeenCalledWith({ where: { catalogModelId: 'dupeA' } })
    expect(tx.marketVariant.deleteMany).toHaveBeenCalledWith({ where: { catalogModelId: 'dupeB' } })
  })
})
