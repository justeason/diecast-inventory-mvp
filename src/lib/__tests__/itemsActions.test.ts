// 15I (focused-review pass): behavioral coverage for updateItemInstance — the
// single-item full-form edit. This is the one caller of the shared storage
// primitive that does NOT use setItemStorageInTx directly (it calls
// validateItemStorageMove and folds the write into its own single combined
// itemInstance.update, so a storage rule failure rolls back condition/price/status
// changes too — see Part 4 of the focused review). validateItemStorageMove itself
// is NOT mocked here — it runs for real against the mocked `tx`, so these tests
// prove updateItemInstance is genuinely subject to the same rules as
// moveInventoryItem / bulk set_storage, not just assumed to be.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findUnique: vi.fn() },
    itemInstance: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({ getPricingIntelligence: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/actions/riskApprovals', () => ({
  checkRiskGate: vi.fn(),
  consumeApprovedRiskGate: vi.fn(),
  markApprovalConsumed: vi.fn(),
}))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))

import { prisma } from '@/lib/prisma'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'
import { updateItemInstance } from '@/lib/actions/items'

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

function existingItem(overrides: Record<string, unknown> = {}) {
  return {
    catalogId: 'cat-same', status: 'available', locationId: 'loc-old',
    listing: null, orderItems: [], sellerAgreement: null,
    ...overrides,
  }
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData()
  const base = { catalogId: 'cat-same', locationId: 'loc-old', cardedOrLoose: 'carded', condition: 'mint', status: 'available' }
  for (const [k, v] of Object.entries({ ...base, ...fields })) f.set(k, v)
  return f
}

beforeEach(() => vi.resetAllMocks())

describe('updateItemInstance — storage bypass regression (Part 9)', () => {
  it('sold item cannot move storage through updateItemInstance', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ status: 'sold' }))
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'sold', locationId: 'loc-old' })
    mockTx(tx)

    const result = await updateItemInstance('item1', null, fd({ locationId: 'loc-new' }))
    expect(result?.errors.locationId?.[0]).toBe("Cannot move item with status 'sold'.")
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('reserved item cannot move storage through updateItemInstance', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ status: 'reserved' }))
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'reserved', locationId: 'loc-old' })
    mockTx(tx)

    const result = await updateItemInstance('item1', null, fd({ locationId: 'loc-new' }))
    expect(result?.errors.locationId?.[0]).toBe("Cannot move item with status 'reserved'.")
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('not_for_sale item cannot move storage through updateItemInstance', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ status: 'not_for_sale' }))
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'not_for_sale', locationId: 'loc-old' })
    mockTx(tx)

    const result = await updateItemInstance('item1', null, fd({ locationId: 'loc-new' }))
    expect(result?.errors.locationId?.[0]).toBe("Cannot move item with status 'not_for_sale'.")
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('an open return-pending case blocks storage move through updateItemInstance', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc-old' })
    tx.sellerLifecycleCase.findFirst = vi.fn().mockResolvedValue({ caseType: 'seller_withdrawal' })
    mockTx(tx)

    const result = await updateItemInstance('item1', null, fd({ locationId: 'loc-new' }))
    expect(result?.errors.locationId?.[0]).toBe('Cannot move item: it has an open seller_withdrawal case.')
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('a deleted target location blocks the move (re-checked inside the transaction)', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc-old' })
    tx.storageLocation.findUnique = vi.fn().mockResolvedValue(null)
    mockTx(tx)

    const result = await updateItemInstance('item1', null, fd({ locationId: 'loc-new' }))
    expect(result?.errors.locationId?.[0]).toBe('Storage location was deleted.')
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })
})

describe('updateItemInstance — full-form atomicity (Part 4/9)', () => {
  it('storage validation failing rolls back the WHOLE submission — condition never partially applies', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ status: 'sold' }))
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'sold', locationId: 'loc-old' })
    mockTx(tx)

    // Proposes BOTH a (blocked) storage move AND a condition change in one submit.
    const result = await updateItemInstance('item1', null, fd({ locationId: 'loc-new', condition: 'good' }))
    expect(result?.errors.locationId).toBeDefined()
    // Nothing committed — not even the otherwise-harmless condition change.
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('an eligible storage+condition change commits together in exactly one combined update call', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    const tx = makeTx()
    tx.itemInstance.findUnique = vi.fn().mockResolvedValue({ id: 'item1', status: 'available', locationId: 'loc-old' })
    tx.storageLocation.findUnique = vi.fn().mockResolvedValue({ id: 'loc-new' })
    mockTx(tx)

    await expect(updateItemInstance('item1', null, fd({ locationId: 'loc-new', condition: 'good' }))).rejects.toThrow('REDIRECT')
    expect(tx.itemInstance.update).toHaveBeenCalledTimes(1)
    expect(tx.itemInstance.update).toHaveBeenCalledWith({
      where: { id: 'item1' },
      data: expect.objectContaining({ locationId: 'loc-new', condition: 'good' }),
    })
  })

  it('leaving locationId unchanged never invokes storage validation at all', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ status: 'sold', locationId: 'loc-old' }))
    const tx = makeTx()
    mockTx(tx)

    // Same locationId as current — a condition-only edit on a sold item (storage
    // untouched) must NOT be blocked by the immovable-status rule.
    await expect(updateItemInstance('item1', null, fd({ locationId: 'loc-old', condition: 'good' }))).rejects.toThrow('REDIRECT')
    expect(tx.itemInstance.findUnique).not.toHaveBeenCalled()
    expect(tx.itemInstance.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: expect.objectContaining({ condition: 'good' }) })
  })
})

describe('updateItemInstance — catalog reassignment still 15F-controlled (Part 6)', () => {
  it('deny/pending never open the mutation transaction — a true no-op, nothing else in the form commits either', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'pending', approvalRequestId: 'req-1', riskLevel: 'high', reasons: [] })

    const result = await updateItemInstance('item1', null, fd({ catalogId: 'cat-new', condition: 'good' }))
    expect(result?.approvalRequestId).toBe('req-1')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('builds the risk context from the freshly-fetched item (hasCompletedSale, completedSaleAmountCents)', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ status: 'sold', orderItems: [{ price: 42 }] }))
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'deny', reasons: ['blocked'] })

    await updateItemInstance('item1', null, fd({ catalogId: 'cat-new' }))
    const call = (checkRiskGate as Mock).mock.calls[0][0]
    expect(call.action).toBe('item_catalog_reassignment')
    expect(call.context.hasCompletedSale).toBe(true)
    expect(call.context.completedSaleAmountCents).toBe(4200)
    expect(call.context.oldCatalogModelId).toBe('cat-same')
    expect(call.context.newCatalogModelId).toBe('cat-new')
  })

  it('consume_approved consumes inside the SAME transaction as the combined update, then marks it consumed', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'consume_approved', approvalRequestId: 'req-1' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValue({ ok: true })
    const tx = makeTx()
    mockTx(tx)

    await expect(updateItemInstance('item1', null, fd({ catalogId: 'cat-new' }))).rejects.toThrow('REDIRECT')
    expect(consumeApprovedRiskGate).toHaveBeenCalledWith(tx, expect.objectContaining({ approvalRequestId: 'req-1', action: 'item_catalog_reassignment', targetId: 'item1' }))
    expect(tx.itemInstance.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: expect.objectContaining({ catalogId: 'cat-new' }) })
    expect(markApprovalConsumed).toHaveBeenCalledWith(tx, 'req-1')
  })

  it('a stale/invalidated approval blocks the whole submission — nothing commits', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-new' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'consume_approved', approvalRequestId: 'req-1' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValue({ ok: false, error: 'context changed' })
    const tx = makeTx()
    mockTx(tx)

    const result = await updateItemInstance('item1', null, fd({ catalogId: 'cat-new' }))
    expect(result?.errors._form?.[0]).toBe('context changed')
    expect(tx.itemInstance.update).not.toHaveBeenCalled()
  })

  it('reassigning to the item current catalog never calls checkRiskGate (idempotent, matches bulk)', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem({ catalogId: 'cat-same' }))
    const tx = makeTx()
    mockTx(tx)

    await expect(updateItemInstance('item1', null, fd({ catalogId: 'cat-same' }))).rejects.toThrow('REDIRECT')
    expect(checkRiskGate).not.toHaveBeenCalled()
  })
})

describe('updateItemInstance — SKU immutability', () => {
  it('the update payload never includes sku, regardless of what the form submits', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat-same' })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(existingItem())
    const tx = makeTx()
    mockTx(tx)

    const form = fd({})
    form.set('sku', 'CT-HACKED')
    await expect(updateItemInstance('item1', null, form)).rejects.toThrow('REDIRECT')
    const call = (tx.itemInstance.update as Mock).mock.calls[0][0]
    expect(call.data).not.toHaveProperty('sku')
  })
})
