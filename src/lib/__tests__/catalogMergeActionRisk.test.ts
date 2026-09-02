// 15F-review (catalog-merge pass): behavioral coverage for the risk gate wired into
// catalog.ts::mergeCatalogModels (catalog_model_merge). The gate's own internal
// correctness is already covered in riskApprovalsActions.test.ts / riskPolicy.test.ts
// — this file proves the merge action calls it correctly, never partially merges,
// and preserves every pre-existing merge safety control (locks, staleness check,
// CatalogModelMergeAudit, integrity check).
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
  checkRiskGate: vi.fn(),
  consumeApprovedRiskGate: vi.fn(),
  markApprovalConsumed: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { computeImpactCounts } from '@/lib/catalogDataQualityQuery'
import { mergeCatalogModels } from '@/lib/actions/catalog'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'

const ZERO_IMPACT = { itemInstances: 0, collectionItems: 0, wantedBy: 0, sellerSubmissions: 0, photos: 0, fingerprints: 0, activeListings: 0, soldItems: 0, externalObs: 0 }

// $queryRaw is shared by the CatalogModel FOR UPDATE lock loop (return value
// unused) and, since 18C final, the ExternalMarketObservation row lock (return
// value = locked ids — defaults to none here).
function makeQueryRaw() {
  return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings)
    if (text.includes('ExternalMarketObservation')) return Promise.resolve([])
    return Promise.resolve(undefined)
  })
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: makeQueryRaw(),
    catalogModel: {
      findUnique: vi.fn().mockImplementation((args: { where: { id: string } }) => Promise.resolve({ id: args.where.id, brand: 'Hot Wheels', name: 'Porsche 911' })),
      delete: vi.fn().mockResolvedValue({}),
    },
    itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 43 }), count: vi.fn().mockResolvedValue(0) },
    collectionItem: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    catalogSuggestion: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    sellerSubmission: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    catalogModelPhoto: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    // 18A: no Wants by default — reconcileWantedCatalogModelMerge's findMany calls
    // both resolve empty, so its updateMany/update/delete are simply never reached.
    wantedCatalogModel: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    // 18B: no nonterminal fanout by default (precondition passes) and nothing to
    // retarget by default — every existing test in this file gets the "clean" path.
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

describe('mergeCatalogModels — catalog_model_merge gate integration (section 2/7)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ;(prisma.catalogModel.count as Mock).mockResolvedValue(2) // both canonical + duplicate exist
  })

  it('allow: merges directly, never touches approval machinery', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue(ZERO_IMPACT)
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'allow' })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(tx.catalogModel.delete).toHaveBeenCalledWith({ where: { id: 'dupe1' } })
    expect(consumeApprovedRiskGate).not.toHaveBeenCalled()
  })

  it('pending: performs ZERO CatalogModel/ItemInstance mutation — the merge never partially executes', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue({ ...ZERO_IMPACT, itemInstances: 43, soldItems: 2 })
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'pending', approvalRequestId: 'appr-1', riskLevel: 'high', reasons: ['sold history'] })
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.approvalRequestId).toBe('appr-1')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('deny: performs zero mutation', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue(ZERO_IMPACT)
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'deny', reasons: ['nope'] })
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form).toBeTruthy()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('consume_approved: merges AND consumes the approval atomically, exactly once, AND still writes CatalogModelMergeAudit', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue({ ...ZERO_IMPACT, itemInstances: 43, soldItems: 2 })
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'consume_approved', approvalRequestId: 'appr-2' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValueOnce({ ok: true })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(mergeCatalogModels(null, formData('canon1', 'dupe1'))).rejects.toThrow('REDIRECT')
    expect(consumeApprovedRiskGate).toHaveBeenCalledWith(tx, expect.objectContaining({ approvalRequestId: 'appr-2', action: 'catalog_model_merge', targetId: 'dupe1' }))
    expect(markApprovalConsumed).toHaveBeenCalledWith(tx, 'appr-2')
    expect(tx.catalogModelMergeAudit.create).toHaveBeenCalledTimes(1)
    expect(tx.catalogModel.delete).toHaveBeenCalledWith({ where: { id: 'dupe1' } })
  })

  it('stale consumption (impact changed since approval) aborts the WHOLE merge — no mutation, no delete, no audit', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue({ ...ZERO_IMPACT, itemInstances: 47, soldItems: 4 })
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'consume_approved', approvalRequestId: 'appr-3' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValueOnce({ ok: false, error: 'stale — impact changed' })
    const tx = makeTx()
    mockTransaction(tx)
    const result = await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    expect(result?.errors?.form?.[0]).toMatch(/stale/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
    expect(tx.catalogModelMergeAudit.create).not.toHaveBeenCalled()
    expect(markApprovalConsumed).not.toHaveBeenCalled()
  })

  it('approval targets the source (duplicate) model id, not the canonical', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue(ZERO_IMPACT)
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'pending', approvalRequestId: 'appr-4', riskLevel: 'medium', reasons: [] })
    await mergeCatalogModels(null, formData('canon1', 'dupe1'))
    const call = (checkRiskGate as Mock).mock.calls[0][0]
    expect(call.targetType).toBe('CatalogModelMerge')
    expect(call.targetId).toBe('dupe1')
    expect(call.context.sourceCatalogModelId).toBe('dupe1')
    expect(call.context.canonicalCatalogModelId).toBe('canon1')
  })

  it('pre-existing stale-preview validation still runs and can still fail independently of approval — approval never makes an otherwise-invalid merge valid (section 4)', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue({ ...ZERO_IMPACT, itemInstances: 99 })
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'allow' })
    const tx = makeTx()
    mockTransaction(tx)
    const fd = formData('canon1', 'dupe1')
    fd.set('expectedImpactSnapshot', JSON.stringify({
      canonicalModelId: 'canon1', sourceModelId: 'dupe1',
      sourceImpact: { ...ZERO_IMPACT, itemInstances: 5 }, // stale — server now sees 99
    }))
    const result = await mergeCatalogModels(null, fd)
    expect(result?.errors?.form?.[0]).toMatch(/Impact changed/)
    expect(tx.catalogModel.delete).not.toHaveBeenCalled()
  })

  it('competing canonical targets (A→B vs A→C) are evaluated with distinct contexts — the gate can never confuse one for the other (section 9)', async () => {
    ;(computeImpactCounts as Mock).mockResolvedValue(ZERO_IMPACT)
    ;(checkRiskGate as Mock)
      .mockResolvedValueOnce({ decision: 'pending', approvalRequestId: 'appr-B', riskLevel: 'medium', reasons: [] })
      .mockResolvedValueOnce({ decision: 'pending', approvalRequestId: 'appr-C', riskLevel: 'medium', reasons: [] })
    await mergeCatalogModels(null, formData('canonB', 'dupeA'))
    await mergeCatalogModels(null, formData('canonC', 'dupeA'))
    const [callAB, callAC] = (checkRiskGate as Mock).mock.calls
    expect(callAB[0].context.canonicalCatalogModelId).toBe('canonB')
    expect(callAC[0].context.canonicalCatalogModelId).toBe('canonC')
    expect(callAB[0].context).not.toEqual(callAC[0].context)
  })
})

describe('mergeCatalogModels — history integrity (section 5, structural)', () => {
  it('the merge mutation never touches OrderItem, SellerPayoutLine, or ItemInstance.sku — only catalogId reassignment and the duplicate CatalogModel delete', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/actions/catalog.ts'), 'utf-8')
    expect(src).not.toMatch(/orderItem\.(update|updateMany|delete)/)
    expect(src).not.toMatch(/sellerPayoutLine\./)
    expect(src).not.toMatch(/sku:/)
  })
})
