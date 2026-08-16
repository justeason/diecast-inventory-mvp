// 15K Part G section 17: manual Create/Reactivate Listing must respect 15J's hard
// blockers regardless of entry path — `blocked` rejects, `review_required` may still
// proceed manually (subject to 15F). Companion to listingsActionsRisk.test.ts, which
// covers the risk-gate integration itself (unaffected by this pass).
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
  checkRiskGate: vi.fn().mockResolvedValue({ decision: 'allow' }),
  consumeApprovedRiskGate: vi.fn(),
  markApprovalConsumed: vi.fn(),
}))
vi.mock('@/lib/readyToListQuery', () => ({ getItemReadyToListStatus: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { createListing, updateListing } from '@/lib/actions/listings'
import { getItemReadyToListStatus } from '@/lib/readyToListQuery'
import { checkRiskGate } from '@/lib/actions/riskApprovals'

function createFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}
function mockTransaction() {
  const tx = { listing: { create: vi.fn().mockResolvedValue({ id: 'l1', version: 1 }), update: vi.fn().mockResolvedValue({ id: 'l1', version: 2, status: 'active', price: 15 }) }, itemInstance: { update: vi.fn() } }
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
  return tx
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(checkRiskGate as Mock).mockResolvedValue({ decision: 'allow' })
})

describe('createListing — 15J blocked check', () => {
  function mockItem() {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce({ id: 'item1', status: 'available', catalogId: 'cat1', listing: null, sellerAgreement: null })
  }

  it('rejects with the exact 15J blocker messages when the fresh readiness result is blocked', async () => {
    mockItem()
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({
      status: 'blocked',
      blockers: [{ code: 'storage_missing', message: 'No storage location is assigned.' }],
      reviewReasons: [], listingPath: 'create', pricing: { status: 'not_evaluated', estimatedValueCents: null, confidenceLevel: null, isAskOnly: false },
    })
    const result = await createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '10' }))
    expect(result?.errors?.itemId).toEqual(['No storage location is assigned.'])
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('proceeds when the fresh readiness result is review_required — manual pricing judgment is still allowed', async () => {
    mockItem()
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({
      status: 'review_required',
      blockers: [], reviewReasons: [{ code: 'pricing_confidence_low', message: 'x' }],
      listingPath: 'create', pricing: { status: 'low_confidence', estimatedValueCents: 100, confidenceLevel: 'low', isAskOnly: false },
    })
    const tx = mockTransaction()
    await expect(createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '10' }))).rejects.toThrow('REDIRECT')
    expect(tx.listing.create).toHaveBeenCalledTimes(1)
  })

  it('proceeds when the fresh readiness result is ready', async () => {
    mockItem()
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({ status: 'ready', blockers: [], reviewReasons: [], listingPath: 'create', pricing: { status: 'supported', estimatedValueCents: 100, confidenceLevel: 'high', isAskOnly: false } })
    const tx = mockTransaction()
    await expect(createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '10' }))).rejects.toThrow('REDIRECT')
    expect(tx.listing.create).toHaveBeenCalledTimes(1)
  })

  it('a null readiness result (lookup failed) does not block — never a false positive', async () => {
    mockItem()
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(null)
    const tx = mockTransaction()
    await expect(createListing(null, createFormData({ itemId: 'item1', title: 'x', price: '10' }))).rejects.toThrow('REDIRECT')
    expect(tx.listing.create).toHaveBeenCalledTimes(1)
  })
})

describe('updateListing reactivation — 15J blocked check', () => {
  function mockBefore() {
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({
      itemId: 'item1', price: 10, status: 'archived',
      item: { catalogId: 'cat1', status: 'available', sellerAgreement: null },
    })
  }

  it('rejects reactivation when the fresh readiness result is blocked', async () => {
    mockBefore()
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({
      status: 'blocked', blockers: [{ code: 'return_case_open', message: 'This item has an open return-pending case.' }],
      reviewReasons: [], listingPath: 'reactivate', pricing: { status: 'not_evaluated', estimatedValueCents: null, confidenceLevel: null, isAskOnly: false },
    })
    const result = await updateListing('l1', null, createFormData({ title: 'x', price: '10', status: 'active' }))
    expect(result?.errors?.status).toEqual(['This item has an open return-pending case.'])
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('allows reactivation when the fresh readiness result is review_required', async () => {
    mockBefore()
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({ status: 'review_required', blockers: [], reviewReasons: [{ code: 'pricing_evidence_missing', message: 'x' }], listingPath: 'reactivate', pricing: { status: 'no_evidence', estimatedValueCents: null, confidenceLevel: 'insufficient', isAskOnly: false } })
    const tx = mockTransaction()
    await expect(updateListing('l1', null, createFormData({ title: 'x', price: '10', status: 'active' }))).rejects.toThrow('REDIRECT')
    expect(tx.listing.update).toHaveBeenCalledTimes(1)
  })

  it('a plain price/title edit that does not reactivate never calls getItemReadyToListStatus at all', async () => {
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ itemId: 'item1', price: 10, status: 'active', item: { catalogId: 'cat1', status: 'available', sellerAgreement: null } })
    const tx = mockTransaction()
    await expect(updateListing('l1', null, createFormData({ title: 'new title', price: '10', status: 'active' }))).rejects.toThrow('REDIRECT')
    expect(getItemReadyToListStatus).not.toHaveBeenCalled()
    expect(tx.listing.update).toHaveBeenCalledTimes(1)
  })
})
