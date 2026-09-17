// 26B: consignment on-platform-sale ownership-ledger trigger. Fires exactly
// one platform_sale CollectionDisposal per eligible consignment OrderItem when
// the order is complete+paid, keyed 'orderitem:<orderItemId>' for retry
// idempotency. Ineligible items (non-consignment sourceType, no resolvable
// CollectionItem lineage) are a legitimate no-op — never guessed/mutated.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({
      acquisitionLot: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      collectionDisposal: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'disposal1' }) },
      collectionDisposalAllocation: { createMany: vi.fn() },
      collectionItem: { update: vi.fn() },
    })),
  },
}))

import { prisma } from '@/lib/prisma'
import { reconcileCollectionDisposalsForCompletedOrder } from '@/lib/collectionDisposalReconciliation'
import { createDisposal } from '@/lib/ownershipLedger'

vi.mock('@/lib/ownershipLedger', async () => {
  const actual = await vi.importActual('@/lib/ownershipLedger')
  return { ...actual, createDisposal: vi.fn() }
})

function baseOrderItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'oi1',
    price: 25,
    item: {
      sourceType: 'consignment',
      sellerAgreement: { type: 'consignment', status: 'accepted' },
      intakeDraft: { sellerSubmission: { collectionItemId: 'ci1' } },
    },
    sellerPayoutLine: { netAmount: new Prisma.Decimal('20') },
    ...overrides,
  }
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    status: 'complete',
    paymentStatus: 'paid',
    completedAt: new Date('2026-06-01'),
    orderItems: [baseOrderItem()],
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.$transaction as Mock).mockImplementation((cb: (tx: unknown) => unknown) => cb({}))
  ;(createDisposal as Mock).mockResolvedValue({ status: 'created', disposal: { id: 'disposal1' } })
})

describe('reconcileCollectionDisposalsForCompletedOrder — order-level gating', () => {
  it('a non-complete order is a no-op — never creates a disposal', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({ status: 'pending' }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 0, skipped: 0 })
    expect(createDisposal).not.toHaveBeenCalled()
  })

  it('a complete-but-unpaid order is a no-op', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({ paymentStatus: 'pending' }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 0, skipped: 0 })
  })

  it('a missing order is a no-op, never throws', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(null)
    const result = await reconcileCollectionDisposalsForCompletedOrder('nope')
    expect(result).toEqual({ created: 0, skipped: 0 })
  })

  it('a complete AND paid order proceeds to per-item reconciliation', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order())
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result.created).toBe(1)
    expect(createDisposal).toHaveBeenCalledTimes(1)
  })
})

describe('reconcileCollectionDisposalsForCompletedOrder — per-item eligibility', () => {
  it('an eligible consignment item with resolvable collectionItemId creates a platform_sale disposal, sourceKey orderitem:<id>', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order())
    await reconcileCollectionDisposalsForCompletedOrder('order1')
    const call = (createDisposal as Mock).mock.calls[0][1]
    expect(call.disposalType).toBe('platform_sale')
    expect(call.collectionItemId).toBe('ci1')
    expect(call.quantity).toBe(1)
    expect(call.sourceKey).toBe('orderitem:oi1')
  })

  it('gross proceeds are sourced from OrderItem.price; net proceeds from SellerPayoutLine.netAmount when that line exists', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({ orderItems: [baseOrderItem({ price: 25, sellerPayoutLine: { netAmount: new Prisma.Decimal('20') } })] }))
    await reconcileCollectionDisposalsForCompletedOrder('order1')
    const call = (createDisposal as Mock).mock.calls[0][1]
    expect(call.grossProceedsCents).toBe(2500)
    expect(call.netProceedsCents).toBe(2000)
  })

  it('no SellerPayoutLine yet -> netProceedsCents is null, never a seller-pricing estimate substituted', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({ orderItems: [baseOrderItem({ sellerPayoutLine: null })] }))
    await reconcileCollectionDisposalsForCompletedOrder('order1')
    const call = (createDisposal as Mock).mock.calls[0][1]
    expect(call.netProceedsCents).toBeNull()
  })

  it('a non-consignment sourceType (buyout/company_owned item mixed into the same order) is skipped, never fed to createDisposal', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [baseOrderItem({ item: { sourceType: 'buyout', sellerAgreement: null, intakeDraft: null } })],
    }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 0, skipped: 1 })
    expect(createDisposal).not.toHaveBeenCalled()
  })

  it('a consignment agreement that is not yet accepted is skipped', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [baseOrderItem({ item: { sourceType: 'consignment', sellerAgreement: { type: 'consignment', status: 'pending' }, intakeDraft: { sellerSubmission: { collectionItemId: 'ci1' } } } })],
    }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 0, skipped: 1 })
    expect(createDisposal).not.toHaveBeenCalled()
  })

  it('an eligible item whose lineage resolves to no collectionItemId (non-customer inventory) is a legitimate no-op, never guesses a similarly-named holding', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [baseOrderItem({ item: { sourceType: 'consignment', sellerAgreement: { type: 'consignment', status: 'accepted' }, intakeDraft: { sellerSubmission: { collectionItemId: null } } } })],
    }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 0, skipped: 1 })
    expect(createDisposal).not.toHaveBeenCalled()
  })

  it('no IntakeDraft at all (legacy item, never went through intake conversion) is a legitimate no-op, never falls back to the agreement\'s anchor submission', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [baseOrderItem({ item: { sourceType: 'consignment', sellerAgreement: { type: 'consignment', status: 'accepted' }, intakeDraft: null } })],
    }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 0, skipped: 1 })
    expect(createDisposal).not.toHaveBeenCalled()
  })

  it('multiple eligible items in the same order each get their own disposal call', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [baseOrderItem({ id: 'oi1' }), baseOrderItem({ id: 'oi2', item: { sourceType: 'consignment', sellerAgreement: { type: 'consignment', status: 'accepted' }, intakeDraft: { sellerSubmission: { collectionItemId: 'ci2' } } } })],
    }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result.created).toBe(2)
    expect(createDisposal).toHaveBeenCalledTimes(2)
  })

  it('mixed eligible + ineligible items in one order: created/skipped counts reflect each independently', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [
        baseOrderItem({ id: 'oi1' }),
        baseOrderItem({ id: 'oi2', item: { sourceType: 'buyout', sellerAgreement: null, intakeDraft: null } }),
      ],
    }))
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 1, skipped: 1 })
  })
})

describe('reconcileCollectionDisposalsForCompletedOrder — item-specific lineage (26B Pre-Commit Invariant Check)', () => {
  it('resolves collectionItemId via ItemInstance.intakeDraft.sellerSubmission — never via sellerAgreement.submission (a portfolio agreement\'s anchor submission is not necessarily this item\'s own submission)', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [baseOrderItem({
        item: {
          sourceType: 'consignment',
          sellerAgreement: { type: 'consignment', status: 'accepted' },
          intakeDraft: { sellerSubmission: { collectionItemId: 'ci-item-specific' } },
        },
      })],
    }))
    await reconcileCollectionDisposalsForCompletedOrder('order1')
    const call = (createDisposal as Mock).mock.calls[0][1]
    expect(call.collectionItemId).toBe('ci-item-specific')
  })

  it('one portfolio agreement covering two submissions/models: item A resolves to CollectionItem A via its own draft/submission, item B resolves independently to CollectionItem B — never both collapsing to one anchor submission', async () => {
    const sharedAgreement = { type: 'consignment', status: 'accepted' } // same agreement object for both items
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({
      orderItems: [
        baseOrderItem({
          id: 'oi-a',
          item: { sourceType: 'consignment', sellerAgreement: sharedAgreement, intakeDraft: { sellerSubmission: { collectionItemId: 'ci-A' } } },
        }),
        baseOrderItem({
          id: 'oi-b',
          item: { sourceType: 'consignment', sellerAgreement: sharedAgreement, intakeDraft: { sellerSubmission: { collectionItemId: 'ci-B' } } },
        }),
      ],
    }))
    await reconcileCollectionDisposalsForCompletedOrder('order1')
    const calls = (createDisposal as Mock).mock.calls.map((c) => c[1])
    expect(calls.find((c) => c.sourceKey === 'orderitem:oi-a').collectionItemId).toBe('ci-A')
    expect(calls.find((c) => c.sourceKey === 'orderitem:oi-b').collectionItemId).toBe('ci-B')
  })

  it('the query selects intakeDraft.sellerSubmission.collectionItemId, not sellerAgreement.submission — structural proof the source no longer reads the agreement-anchored path', () => {
    const src: string = fs.readFileSync(path.join(process.cwd(), 'src/lib/collectionDisposalReconciliation.ts'), 'utf-8')
    expect(src).toContain('intakeDraft: { select: { sellerSubmission: { select: { collectionItemId: true } } } }')
    expect(src).not.toMatch(/sellerAgreement:\s*\{\s*select:\s*\{[^}]*submission:\s*\{\s*select:\s*\{\s*collectionItemId/)
    expect(src).toContain('orderItem.item.intakeDraft?.sellerSubmission?.collectionItemId')
  })
})

describe('reconcileCollectionDisposalsForCompletedOrder — retry idempotency', () => {
  it('when createDisposal reports already_exists (retried reconciliation), it counts as skipped, not created — never double-decrements', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order())
    ;(createDisposal as Mock).mockResolvedValue({ status: 'already_exists', disposal: { id: 'disposal1' } })
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 0, skipped: 1 })
  })

  it('disposedAt uses Order.completedAt, falling back to now only when completedAt is null', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(order({ completedAt: null }))
    await reconcileCollectionDisposalsForCompletedOrder('order1')
    const call = (createDisposal as Mock).mock.calls[0][1]
    expect(call.disposedAt).toBeInstanceOf(Date)
  })
})
