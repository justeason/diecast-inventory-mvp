// 26B Pre-Commit Invariant Check: end-to-end regression proving the
// consignment disposal trigger resolves collectionItemId via the item-
// specific IntakeDraft/SellerSubmission chain, NOT via the (potentially
// portfolio-shared) SellerAgreement's own anchor submission. Exercises the
// REAL reconcileCollectionDisposalsForCompletedOrder and the REAL
// createDisposal (ownershipLedger.ts is not mocked) — only prisma is mocked,
// as a small stateful store, mirroring consignmentPayoutRepairReconciliation.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'

vi.mock('@/lib/prisma', () => {
  // Two CollectionItems (A, B), each with exactly one remaining lot.
  const lots: Record<string, { id: string; collectionItemId: string; remainingQuantity: number }> = {
    lotA: { id: 'lotA', collectionItemId: 'ciA', remainingQuantity: 1 },
    lotB: { id: 'lotB', collectionItemId: 'ciB', remainingQuantity: 1 },
  }
  const disposalsBySourceKey = new Map<string, Record<string, unknown>>()

  // ONE shared portfolio-linked SellerAgreement covering BOTH submissions —
  // its own submissionId (not modeled here at all, since the fix no longer
  // reads it) would, under the old buggy code, have collapsed both items to
  // whichever submission the agreement's own submissionId pointed at.
  const orderItemB = {
    id: 'oi-B',
    price: 30,
    item: {
      sourceType: 'consignment',
      sellerAgreement: { type: 'consignment', status: 'accepted' }, // shared agreement object, no submission info used
      intakeDraft: { sellerSubmission: { collectionItemId: 'ciB' } }, // item B's OWN, item-specific submission
    },
    sellerPayoutLine: { netAmount: new Prisma.Decimal('25') },
  }

  const client: Record<string, unknown> = {
    order: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'complete',
        paymentStatus: 'paid',
        completedAt: new Date('2026-06-01'),
        orderItems: [orderItemB], // only item B was sold in this order — item A never appears
      }),
    },
    acquisitionLot: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { collectionItemId: string } }) =>
        Promise.resolve(Object.values(lots).filter((l) => l.collectionItemId === where.collectionItemId && l.remainingQuantity > 0)),
      ),
      updateMany: vi.fn().mockImplementation(({ where, data }: { where: Record<string, unknown>; data: { remainingQuantity: { decrement: number } } }) => {
        const lot = Object.values(lots).find((l) => l.id === where.id)
        if (!lot || lot.remainingQuantity < (where.remainingQuantity as { gte: number }).gte) return Promise.resolve({ count: 0 })
        lot.remainingQuantity -= data.remainingQuantity.decrement
        return Promise.resolve({ count: 1 })
      }),
    },
    collectionDisposal: {
      findUnique: vi.fn().mockImplementation(({ where }: { where: { sourceKey: string } }) => Promise.resolve(disposalsBySourceKey.get(where.sourceKey) ?? null)),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `disposal-${data.sourceKey}`, ...data }
        disposalsBySourceKey.set(data.sourceKey as string, row)
        return Promise.resolve(row)
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    collectionDisposalAllocation: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    collectionItem: { update: vi.fn().mockResolvedValue({}) },
  }
  client.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(client))

  return { prisma: client, __testState: { lots, disposalsBySourceKey } }
})

import { prisma } from '@/lib/prisma'
import { reconcileCollectionDisposalsForCompletedOrder } from '@/lib/collectionDisposalReconciliation'
import * as prismaModule from '@/lib/prisma'

const testState = (prismaModule as unknown as {
  __testState: {
    lots: Record<string, { collectionItemId: string; remainingQuantity: number }>
    disposalsBySourceKey: Map<string, Record<string, unknown>>
  }
}).__testState

describe('26B Pre-Commit Invariant Check: one portfolio agreement, two submissions/CollectionItems — sale resolves to the correct item only', () => {
  it('selling item B (real reconciliation + real createDisposal) decrements ONLY CollectionItem B\'s lot; CollectionItem A is never touched', async () => {
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')

    expect(result).toEqual({ created: 1, skipped: 0 })

    // The disposal was created against ciB, never ciA.
    const disposal = testState.disposalsBySourceKey.get('orderitem:oi-B')!
    expect(disposal.collectionItemId).toBe('ciB')

    // B's lot decremented once.
    expect(testState.lots.lotB.remainingQuantity).toBe(0)
    // A's lot completely untouched — never even queried/decremented, since
    // item A's own OrderItem never appeared in this order.
    expect(testState.lots.lotA.remainingQuantity).toBe(1)
    expect(prisma.acquisitionLot.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ collectionItemId: 'ciA' }) }),
    )
  })
})
