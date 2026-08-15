// 15F-review: behavioral coverage for the risk gate wired into listings.ts —
// createListing (listing_activation), updateListing (listing_price_change AND, for
// reactivation, listing_activation too). The gate's own internal correctness
// (allow/deny/require_approval, consumption atomicity, dedup) is already covered in
// riskApprovalsActions.test.ts / riskPolicy.test.ts — this file only proves listings.ts
// calls it correctly and never mutates when it shouldn't.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { findUnique: vi.fn() },
    listing: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({ getPricingIntelligence: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/buyerAlertsTrigger', () => ({ createAvailableFanoutJob: vi.fn(), createPriceChangeFanoutJob: vi.fn() }))
vi.mock('@/lib/buyerAlertsFanoutProcessor', () => ({ processFanoutJobs: vi.fn().mockResolvedValue(undefined) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))
vi.mock('@/lib/actions/riskApprovals', () => ({
  checkRiskGate: vi.fn(),
  consumeApprovedRiskGate: vi.fn(),
  markApprovalConsumed: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { createListing, updateListing } from '@/lib/actions/listings'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    listing: { create: vi.fn().mockResolvedValue({ id: 'listing1', version: 1 }), update: vi.fn().mockResolvedValue({ id: 'listing1', version: 2, status: 'active', price: 15 }) },
    itemInstance: { update: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function createFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

describe('createListing — listing_activation gate integration (section 9)', () => {
  beforeEach(() => vi.resetAllMocks())

  function mockItem(overrides: Record<string, unknown> = {}) {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce({
      id: 'item1', status: 'available', catalogId: 'cat1', listing: null, sellerAgreement: null, ...overrides,
    })
  }

  it('allow: creates the listing directly, never touches approval machinery', async () => {
    mockItem()
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'allow' })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '10' }))).rejects.toThrow('REDIRECT')
    expect(tx.listing.create).toHaveBeenCalledTimes(1)
    expect(consumeApprovedRiskGate).not.toHaveBeenCalled()
  })

  it('pending: does NOT create a listing — approval itself never performs the action (section 4/9)', async () => {
    mockItem()
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'pending', approvalRequestId: 'appr-1', riskLevel: 'high', reasons: ['too pricey'] })
    const result = await createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '9999' }))
    expect(result?.approvalRequestId).toBe('appr-1')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('deny: never creates a listing', async () => {
    mockItem()
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'deny', reasons: ['nope'] })
    const result = await createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '10' }))
    expect(result?.errors?._form).toBeTruthy()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('consume_approved: creates the listing AND consumes the approval atomically, exactly once', async () => {
    mockItem()
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'consume_approved', approvalRequestId: 'appr-2' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValueOnce({ ok: true })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '9999' }))).rejects.toThrow('REDIRECT')
    expect(consumeApprovedRiskGate).toHaveBeenCalledWith(tx, expect.objectContaining({ approvalRequestId: 'appr-2', action: 'listing_activation', targetId: 'item1' }))
    expect(markApprovalConsumed).toHaveBeenCalledWith(tx, 'appr-2')
    expect(tx.listing.create).toHaveBeenCalledTimes(1)
  })

  it('stale consumption (context no longer matches) aborts the whole mutation — no listing created', async () => {
    mockItem()
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'consume_approved', approvalRequestId: 'appr-3' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValueOnce({ ok: false, error: 'stale' })
    const tx = makeTx()
    mockTransaction(tx)
    const result = await createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '9999' }))
    expect(result?.errors?._form?.[0]).toBe('stale')
    expect(tx.listing.create).not.toHaveBeenCalled()
    expect(markApprovalConsumed).not.toHaveBeenCalled()
  })
})

describe('updateListing — reactivation triggers listing_activation, price change triggers listing_price_change, independently (section 1/2/9)', () => {
  beforeEach(() => vi.resetAllMocks())

  function mockBefore(overrides: Record<string, unknown> = {}) {
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({
      itemId: 'item1', price: 10, status: 'archived',
      item: { catalogId: 'cat1', status: 'available', sellerAgreement: null },
      ...overrides,
    })
  }

  it('reactivating an archived listing (same price) evaluates listing_activation, not listing_price_change', async () => {
    mockBefore()
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'allow' })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(updateListing('l1', null, createFormData({ title: 'x', price: '10', status: 'active' }))).rejects.toThrow('REDIRECT')
    expect(checkRiskGate).toHaveBeenCalledTimes(1)
    expect((checkRiskGate as Mock).mock.calls[0][0].action).toBe('listing_activation')
  })

  it('reactivation requiring approval blocks the mutation — the archived listing stays archived, never silently activated', async () => {
    mockBefore()
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'pending', approvalRequestId: 'appr-4', riskLevel: 'medium', reasons: [] })
    const result = await updateListing('l1', null, createFormData({ title: 'x', price: '10', status: 'active' }))
    expect(result?.approvalRequestId).toBe('appr-4')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('a plain price edit on an already-active listing evaluates listing_price_change only, never listing_activation', async () => {
    mockBefore({ status: 'active' })
    ;(checkRiskGate as Mock).mockResolvedValueOnce({ decision: 'allow' })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(updateListing('l1', null, createFormData({ title: 'x', price: '999999', status: 'active' }))).rejects.toThrow('REDIRECT')
    expect(checkRiskGate).toHaveBeenCalledTimes(1)
    expect((checkRiskGate as Mock).mock.calls[0][0].action).toBe('listing_price_change')
  })

  it('reactivating WITH a simultaneous price change evaluates and can consume BOTH gates in the same transaction', async () => {
    mockBefore()
    ;(checkRiskGate as Mock)
      .mockResolvedValueOnce({ decision: 'consume_approved', approvalRequestId: 'appr-activation' })
      .mockResolvedValueOnce({ decision: 'consume_approved', approvalRequestId: 'appr-price' })
    ;(consumeApprovedRiskGate as Mock).mockResolvedValue({ ok: true })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(updateListing('l1', null, createFormData({ title: 'x', price: '999999', status: 'active' }))).rejects.toThrow('REDIRECT')
    expect(consumeApprovedRiskGate).toHaveBeenCalledTimes(2)
    expect(markApprovalConsumed).toHaveBeenCalledWith(tx, 'appr-activation')
    expect(markApprovalConsumed).toHaveBeenCalledWith(tx, 'appr-price')
    expect(tx.listing.update).toHaveBeenCalledTimes(1)
  })

  it('title/description-only edits on an already-active listing (no price or status change) never call the gate at all', async () => {
    mockBefore({ status: 'active' })
    const tx = makeTx()
    mockTransaction(tx)
    await expect(updateListing('l1', null, createFormData({ title: 'new title', price: '10', status: 'active' }))).rejects.toThrow('REDIRECT')
    expect(checkRiskGate).not.toHaveBeenCalled()
  })
})
