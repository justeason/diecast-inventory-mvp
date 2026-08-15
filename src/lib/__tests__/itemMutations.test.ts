// 15I (focused-review pass): behavioral coverage for the ONE authoritative
// ItemInstance mutation helpers — storage-move rules (IMMOVABLE_STATUSES /
// RETURN_PENDING_CASE_TYPES now live here, not in an action module), condition
// enum, and catalog-reassignment risk-gate integration. Every real runtime caller
// (updateItemInstance, moveInventoryItem, the bulk item-action engine) delegates
// to this module — see itemsActions.test.ts / intakeOperations.test.ts /
// itemBulkActions.test.ts for the caller-side proof that they actually do.
// Follows the same mockTransaction convention established in
// listingsActionsRisk.test.ts — the risk gate's own internal correctness is covered
// by riskPolicy.test.ts / riskApprovalsActions.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { findUnique: vi.fn(), update: vi.fn() },
    storageLocation: { findUnique: vi.fn() },
    catalogModel: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({ getPricingIntelligence: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/actions/riskApprovals', () => ({
  checkRiskGate: vi.fn(),
  consumeApprovedRiskGate: vi.fn(),
  markApprovalConsumed: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'
import { setItemStorage, setItemCondition, setItemCatalog, validateItemStorageMove } from '@/lib/itemMutations'

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    itemInstance: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    storageLocation: { findUnique: vi.fn() },
    sellerLifecycleCase: { findFirst: vi.fn().mockResolvedValue(null) },
    riskApprovalRequest: { findUnique: vi.fn() },
    ...overrides,
  }
}

function mockTx(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

beforeEach(() => vi.resetAllMocks())

describe('setItemStorage', () => {
  it('not_found when the item does not exist', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue({ id: 'loc1' })
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue(null)
    mockTx(tx)
    expect(await setItemStorage('item1', 'loc1')).toEqual({ outcome: 'not_found' })
  })

  it('validation_failed before even opening a transaction when the target location does not exist', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue(null)
    const result = await setItemStorage('item1', 'bad-loc')
    expect(result).toEqual({ outcome: 'validation_failed', reason: 'Storage location not found.' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('blocks sold/reserved/not_for_sale items — reuses IMMOVABLE_STATUSES, no new rule invented', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue({ id: 'loc1' })
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'sold', locationId: 'loc0' })
    mockTx(tx)
    const result = await setItemStorage('item1', 'loc1')
    expect(result.outcome).toBe('validation_failed')
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('blocks items with an open return-pending lifecycle case', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue({ id: 'loc1' })
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc0' })
    tx.sellerLifecycleCase.findFirst = vi.fn().mockResolvedValue({ caseType: 'return_to_seller' })
    mockTx(tx)
    const result = await setItemStorage('item1', 'loc1')
    expect(result.outcome).toBe('validation_failed')
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('unchanged (idempotent) when the item is already at the target location — no update call', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue({ id: 'loc1' })
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc1' })
    mockTx(tx)
    const result = await setItemStorage('item1', 'loc1')
    expect(result).toEqual({ outcome: 'unchanged' })
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('updated when eligible and location differs', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue({ id: 'loc1' })
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc0' })
    tx.storageLocation.findUnique = vi.fn().mockResolvedValue({ id: 'loc1' })
    mockTx(tx)
    const result = await setItemStorage('item1', 'loc1')
    expect(result).toEqual({ outcome: 'updated' })
    expect(tx.itemInstance.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: { locationId: 'loc1' } })
  })
})

// 15I (focused-review pass, Part 1/3): validateItemStorageMove is the VALIDATION-
// ONLY half of the same rule — it never writes. This is what lets a multi-field
// single-item edit (updateItemInstance) fold the storage write into its own single
// combined update instead of a second, separately-atomic write. setItemStorageInTx
// (tested via setItemStorage above) is just this plus one write when eligible —
// same rule, same order, same messages.
describe('validateItemStorageMove — validation-only half of the shared primitive', () => {
  it('never calls itemInstance.update — it only validates', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc0' })
    tx.storageLocation.findUnique = vi.fn().mockResolvedValue({ id: 'loc1' })
    const result = await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })
    expect(result).toEqual({ ok: true, unchanged: false })
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('not_found', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue(null)
    expect(await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })).toEqual({ ok: false, outcome: 'not_found' })
  })

  it('rejects sold/reserved/not_for_sale (IMMOVABLE_STATUSES)', async () => {
    for (const status of ['sold', 'reserved', 'not_for_sale']) {
      const tx = makeTx()
      tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status, locationId: 'loc0' })
      const result = await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })
      expect(result).toEqual({ ok: false, outcome: 'validation_failed', reason: `Cannot move item with status '${status}'.` })
    }
  })

  it('allows draft/available/not_for_sale-excluded statuses through to the return-case check', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc0' })
    tx.storageLocation.findUnique = vi.fn().mockResolvedValue({ id: 'loc1' })
    const result = await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
  })

  it('rejects an open return-pending lifecycle case, with the exact case type in the message', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc0' })
    tx.sellerLifecycleCase.findFirst = vi.fn().mockResolvedValue({ caseType: 'consignment_expiration' })
    const result = await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })
    expect(result).toEqual({ ok: false, outcome: 'validation_failed', reason: 'Cannot move item: it has an open consignment_expiration case.' })
  })

  it('unchanged when the item is already at the target location', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc1' })
    const result = await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })
    expect(result).toEqual({ ok: true, unchanged: true })
    // Idempotent short-circuit — never even asks whether the location still exists.
    expect(tx.storageLocation.findUnique).not.toHaveBeenCalled()
  })

  it('rejects when the target location no longer exists (checked inside the transaction, after the row lock)', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc0' })
    tx.storageLocation.findUnique = vi.fn().mockResolvedValue(null)
    const result = await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })
    expect(result).toEqual({ ok: false, outcome: 'validation_failed', reason: 'Storage location was deleted.' })
  })

  it('checks the return-case rule only after the row lock (correct ordering)', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc0' })
    await validateItemStorageMove(tx as unknown as Parameters<typeof validateItemStorageMove>[0],{ itemId: 'item1', locationId: 'loc1' })
    const lockCallOrder = (tx.$queryRaw as Mock).mock.invocationCallOrder[0]
    const returnCheckOrder = (tx.sellerLifecycleCase.findFirst as Mock).mock.invocationCallOrder[0]
    expect(returnCheckOrder).toBeGreaterThan(lockCallOrder)
  })
})

describe('setItemCondition', () => {
  it('rejects an invalid condition value before touching the DB', async () => {
    const result = await setItemCondition('item1', 'mint-plus')
    expect(result).toEqual({ outcome: 'validation_failed', reason: 'Invalid condition.' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('not_found when the item does not exist', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue(null)
    mockTx(tx)
    expect(await setItemCondition('item1', 'mint')).toEqual({ outcome: 'not_found' })
  })

  it('unchanged (idempotent) when condition already matches', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', condition: 'mint' })
    mockTx(tx)
    const result = await setItemCondition('item1', 'mint')
    expect(result).toEqual({ outcome: 'unchanged' })
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('updated when condition differs', async () => {
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', condition: 'good' })
    mockTx(tx)
    const result = await setItemCondition('item1', 'mint')
    expect(result).toEqual({ outcome: 'updated' })
    expect(tx.itemInstance.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: { condition: 'mint' } })
  })
})

describe('setItemCatalog — item_catalog_reassignment gate (15F integrity)', () => {
  function existingItem(overrides: Record<string, unknown> = {}) {
    return {
      catalogId: 'cat-old', status: 'available', listing: null, orderItems: [], sellerAgreement: null,
      ...overrides,
    }
  }

  it('not_found when the item does not exist', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(null)
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    expect(await setItemCatalog('item1', 'cat-new', 'admin')).toEqual({ outcome: 'not_found' })
  })

  it('unchanged (idempotent) — reassigning to the item current model never calls checkRiskGate', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ catalogId: 'cat-same' }))
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    const result = await setItemCatalog('item1', 'cat-same', 'admin')
    expect(result).toEqual({ outcome: 'unchanged' })
    expect(checkRiskGate).not.toHaveBeenCalled()
  })

  it('denied — item stays unchanged', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'deny', reasons: ['too risky'] })
    const result = await setItemCatalog('item1', 'cat-new', 'admin')
    expect(result).toEqual({ outcome: 'denied', reason: 'too risky' })
    expect(prisma.itemInstance.update).not.toHaveBeenCalled()
  })

  it('approval_required — item stays unchanged, carries its own approvalRequestId', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'pending', approvalRequestId: 'req-1', riskLevel: 'high', reasons: [] })
    const result = await setItemCatalog('item1', 'cat-new', 'admin')
    expect(result).toEqual({ outcome: 'approval_required', approvalRequestId: 'req-1' })
    expect(prisma.itemInstance.update).not.toHaveBeenCalled()
  })

  it('allow — updates catalogId directly, never a raw updateMany', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'allow' })
    const result = await setItemCatalog('item1', 'cat-new', 'admin')
    expect(result).toEqual({ outcome: 'updated' })
    expect(prisma.itemInstance.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: { catalogId: 'cat-new' } })
  })

  it('consume_approved — consumes inside a transaction, then updates, then marks consumed', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'consume_approved', approvalRequestId: 'req-1' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValue({ ok: true })
    const tx = makeTx()
    mockTx(tx)
    const result = await setItemCatalog('item1', 'cat-new', 'admin')
    expect(result).toEqual({ outcome: 'updated' })
    expect(consumeApprovedRiskGate).toHaveBeenCalledWith(tx, expect.objectContaining({ approvalRequestId: 'req-1', action: 'item_catalog_reassignment', targetId: 'item1' }))
    expect(tx.itemInstance.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: { catalogId: 'cat-new' } })
    expect(markApprovalConsumed).toHaveBeenCalledWith(tx, 'req-1')
  })

  it('a stale/invalidated approval never applies the mutation — one approval cannot authorize a different/changed request', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'consume_approved', approvalRequestId: 'req-1' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValue({ ok: false, error: 'context changed' })
    const tx = makeTx()
    mockTx(tx)
    const result = await setItemCatalog('item1', 'cat-new', 'admin')
    expect(result).toEqual({ outcome: 'validation_failed', reason: 'context changed' })
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('a completed sale is still reflected in the risk context (hasCompletedSale true)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ status: 'sold', orderItems: [{ price: 42 }] }))
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'allow' })
    await setItemCatalog('item1', 'cat-new', 'admin')
    const call = (checkRiskGate as Mock).mock.calls[0][0]
    expect(call.context.hasCompletedSale).toBe(true)
    expect(call.context.completedSaleAmountCents).toBe(4200)
  })
})
