import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/buyerAlertsTrigger', () => ({ createAvailableFanoutJob: vi.fn() }))

import { Prisma } from '@prisma/client'
import { createAvailableFanoutJob } from '@/lib/buyerAlertsTrigger'
import { buildListingActivationContext, createListingAtomic } from '@/lib/listingActivation'

beforeEach(() => vi.resetAllMocks())

function makeTx(overrides: Record<string, unknown> = {}) {
  return { listing: { create: vi.fn().mockResolvedValue({ id: 'listing1', version: 1 }) }, ...overrides }
}

describe('createListingAtomic — the one authoritative Listing-creation boundary', () => {
  it('creates the listing and the fan-out job inside the SAME transaction, in that order', async () => {
    const tx = makeTx()
    const result = await createListingAtomic(tx as never, { itemId: 'item1', catalogId: 'cat1', title: 'T', price: 10 })
    expect(result).toEqual({ ok: true, id: 'listing1', version: 1 })
    expect(tx.listing.create).toHaveBeenCalledWith({ data: { itemId: 'item1', title: 'T', price: 10, description: undefined, status: 'active' } })
    expect(createAvailableFanoutJob).toHaveBeenCalledWith(tx, 'cat1', 'listing1', 1)
  })

  it('a P2002 (itemId unique constraint) is caught and reported as already_listed — a defensive backstop, not a crash', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' })
    const tx = makeTx({ listing: { create: vi.fn().mockRejectedValue(p2002) } })
    const result = await createListingAtomic(tx as never, { itemId: 'item1', catalogId: 'cat1', title: 'T', price: 10 })
    expect(result).toEqual({ ok: false, reason: 'already_listed' })
    expect(createAvailableFanoutJob).not.toHaveBeenCalled()
  })

  it('a non-P2002 error is rethrown, never silently swallowed', async () => {
    const tx = makeTx({ listing: { create: vi.fn().mockRejectedValue(new Error('db down')) } })
    await expect(createListingAtomic(tx as never, { itemId: 'item1', catalogId: 'cat1', title: 'T', price: 10 })).rejects.toThrow('db down')
  })
})

describe('buildListingActivationContext — pure, no DB access (15K execution-snapshot pass)', () => {
  it('resolves the buyout total only when the item is the sole unit under a buyout agreement', () => {
    const ctx = buildListingActivationContext('item1', 'cat1', 1000, 5000, { type: 'buyout', agreedBuyoutAmount: { toString: () => '75.00' }, acceptedItemCount: 1 })
    expect(ctx.agreementBuyoutTotalCents).toBe(7500)
    expect(ctx.estimatedValueCents).toBe(5000)
  })

  it('never uses the buyout total when acceptedItemCount is not exactly 1', () => {
    const ctx = buildListingActivationContext('item1', 'cat1', 1000, null, { type: 'buyout', agreedBuyoutAmount: { toString: () => '75.00' }, acceptedItemCount: 3 })
    expect(ctx.agreementBuyoutTotalCents).toBeNull()
  })

  it('null sellerAgreement -> null buyout total, no crash', () => {
    const ctx = buildListingActivationContext('item1', 'cat1', 1000, null, null)
    expect(ctx.agreementBuyoutTotalCents).toBeNull()
    expect(ctx.estimatedValueCents).toBeNull()
  })

  it('estimatedValueCents is passed through verbatim — the caller is solely responsible for sourcing it from the SAME evidence used to compute proposedPriceCents', () => {
    const ctx = buildListingActivationContext('item1', 'cat1', 1000, 9999, null)
    expect(ctx.estimatedValueCents).toBe(9999)
  })
})
