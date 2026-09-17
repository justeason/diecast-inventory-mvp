// 26B Final Patch: end-to-end regression for the async-payout-then-disposal
// race and its repair. Exercises the REAL production entry points — the
// order-completion-time reconciliation trigger (reconcileCollectionDisposalsForCompletedOrder)
// and the REAL admin repair action (generateMissingPayoutLines) — never
// calling createDisposal or the enrichment logic directly. Only prisma is
// mocked, as a small stateful in-memory store so each call reflects what the
// previous call actually wrote (mirrors this repo's other stateful-mock
// pattern, see collectionItemConcurrency.test.ts's self-referencing $transaction).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }))

vi.mock('@/lib/prisma', () => {
  // ── In-memory state ─────────────────────────────────────────────────────
  const payoutLinesBySourceKey = new Map<string, Record<string, unknown>>()
  let disposal: Record<string, unknown> | null = null
  const lot = { id: 'lot1', collectionItemId: 'ci1', remainingQuantity: 1, unitRecordedCostCents: 1000, acquiredAt: null, ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') }

  const ORDER_ITEM_ID = 'oi1'
  const ORDER_ID = 'order1'

  function orderSnapshot() {
    const payoutLine = payoutLinesBySourceKey.get(`consignment:${ORDER_ITEM_ID}`) ?? null
    return {
      id: ORDER_ID,
      status: 'complete',
      paymentStatus: 'paid',
      completedAt: new Date('2026-06-01'),
      orderItems: [
        {
          id: ORDER_ITEM_ID,
          orderId: ORDER_ID,
          price: 25,
          sellerPayoutLine: payoutLine ? { netAmount: payoutLine.netAmount } : null,
          item: {
            sourceType: 'consignment',
            sellerAgreementId: 'agr1',
            sellerAgreement: {
              id: 'agr1',
              type: 'consignment',
              status: 'accepted',
              commissionPercent: new Prisma.Decimal('0.20'),
              fixedFee: new Prisma.Decimal('0'),
              minimumSellerPayout: new Prisma.Decimal('0'),
              commissionMinimumFee: new Prisma.Decimal('0'),
              submission: { profileId: 'seller1' },
            },
            // 26B Pre-Commit Invariant Check: item-specific lineage, not the
            // agreement's own (possibly portfolio-shared) anchor submission.
            intakeDraft: { sellerSubmission: { collectionItemId: 'ci1' } },
          },
        },
      ],
    }
  }

  const client: Record<string, unknown> = {
    order: { findUnique: vi.fn().mockImplementation(() => Promise.resolve(orderSnapshot())) },
    sellerPayoutLine: {
      findUnique: vi.fn().mockImplementation(({ where }: { where: { sourceKey: string } }) =>
        Promise.resolve(payoutLinesBySourceKey.get(where.sourceKey) ?? null),
      ),
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'payoutline1', ...data }
        payoutLinesBySourceKey.set(data.sourceKey as string, row)
        return Promise.resolve(row)
      }),
    },
    acquisitionLot: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(lot.remainingQuantity > 0 ? [lot] : [])),
      updateMany: vi.fn().mockImplementation(({ where, data }: { where: Record<string, unknown>; data: { remainingQuantity: { decrement: number } } }) => {
        if (where.id !== lot.id || lot.remainingQuantity < (where.remainingQuantity as { gte: number }).gte) {
          return Promise.resolve({ count: 0 })
        }
        lot.remainingQuantity -= data.remainingQuantity.decrement
        return Promise.resolve({ count: 1 })
      }),
    },
    collectionDisposal: {
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(disposal)),
      findUniqueOrThrow: vi.fn().mockImplementation(() => Promise.resolve(disposal)),
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        disposal = { id: 'disposal1', ...data }
        return Promise.resolve(disposal)
      }),
      updateMany: vi.fn().mockImplementation(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!disposal) return Promise.resolve({ count: 0 })
        for (const [key, val] of Object.entries(where)) {
          if (key !== 'id' && (disposal as Record<string, unknown>)[key] !== val) return Promise.resolve({ count: 0 })
        }
        Object.assign(disposal, data)
        return Promise.resolve({ count: 1 })
      }),
    },
    collectionDisposalAllocation: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    collectionItem: { update: vi.fn().mockResolvedValue({}) },
  }
  client.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(client))

  return {
    prisma: client,
    __testState: { payoutLinesBySourceKey, getDisposal: () => disposal, lot },
  }
})

import { prisma } from '@/lib/prisma'
import { generateMissingPayoutLines } from '@/lib/actions/sellerPayouts'
import { reconcileCollectionDisposalsForCompletedOrder } from '@/lib/collectionDisposalReconciliation'
import { computeRealizedGain } from '@/lib/ownershipLedger'

// The mock module augments its export with __testState for inspection —
// pull it back out via the same import path.
import * as prismaModule from '@/lib/prisma'
const testState = (prismaModule as unknown as { __testState: { getDisposal: () => Record<string, unknown> | null; lot: { remainingQuantity: number } } }).__testState

beforeEach(() => {
  // Fresh Map/disposal per test would require re-mocking; instead each test
  // in this file builds on a shared fixture but we only need ONE end-to-end
  // narrative (A -> B -> C), so no reset between the individual `it`s below —
  // they intentionally run in sequence in a single test for clarity and to
  // exactly mirror the real chronological race.
})

describe('26B Final Patch: consignment async-payout race, end-to-end through the real repair entry point', () => {
  it('A: order completes and reconciles before the payout line exists -> disposal created once, quantity decremented once, proceeds unknown', async () => {
    const result = await reconcileCollectionDisposalsForCompletedOrder('order1')
    expect(result).toEqual({ created: 1, skipped: 0 })

    const disposal = testState.getDisposal()!
    expect(disposal.disposalType).toBe('platform_sale')
    expect(disposal.sourceKey).toBe('orderitem:oi1')
    expect(disposal.netProceedsCents).toBeNull()
    expect(disposal.grossProceedsCents).toBe(2500)
    expect(testState.lot.remainingQuantity).toBe(0) // decremented once (started at 1)

    expect(computeRealizedGain(disposal.netProceedsCents as number | null, [{ allocatedRecordedCostCents: 1000 }])).toEqual({ status: 'unavailable' })
  })

  it('B: the REAL generateMissingPayoutLines repair creates the missing payout line AND enriches the SAME disposal — quantity/allocations untouched, realized G/L becomes calculable', async () => {
    const disposalBefore = { ...testState.getDisposal()! }

    const result = await generateMissingPayoutLines('order1', null, new FormData())
    expect(result).toEqual({ success: true, created: 1 })

    // Payout line was actually created via the real ensureConsignmentPayoutLinesForCompletedOrder path.
    expect(prisma.sellerPayoutLine.create).toHaveBeenCalledTimes(1)

    const disposal = testState.getDisposal()!
    expect(disposal.id).toBe(disposalBefore.id) // SAME disposal row, not a new one
    expect(disposal.netProceedsCents).not.toBeNull()
    expect(disposal.grossProceedsCents).toBe(2500) // unchanged
    expect(disposal.disposedAt).toEqual(disposalBefore.disposedAt) // unchanged
    expect(disposal.quantity).toBe(disposalBefore.quantity) // unchanged

    // No re-decrement, no new allocation.
    expect(testState.lot.remainingQuantity).toBe(0) // still 0, not negative
    expect(prisma.collectionDisposalAllocation.createMany).toHaveBeenCalledTimes(1) // only from phase A

    // Realized G/L is now calculable (cost is fully covered by the one allocation).
    const realized = computeRealizedGain(disposal.netProceedsCents as number | null, [{ allocatedRecordedCostCents: 1000 }])
    expect(realized.status).toBe('calculable')
  })

  it('C: retrying generateMissingPayoutLines again is fully idempotent — no duplicate payout line, no duplicate disposal, no re-decrement, no proceeds rewrite', async () => {
    const disposalBefore = { ...testState.getDisposal()! }
    const payoutLineCreateCallsBefore = (prisma.sellerPayoutLine.create as Mock).mock.calls.length
    const disposalCreateCallsBefore = (prisma.collectionDisposal.create as Mock).mock.calls.length
    const allocationCreateCallsBefore = (prisma.collectionDisposalAllocation.createMany as Mock).mock.calls.length

    const result = await generateMissingPayoutLines('order1', null, new FormData())
    expect(result).toEqual({ success: true, created: 0 }) // payout line already exists -> 0 newly created

    expect((prisma.sellerPayoutLine.create as Mock).mock.calls.length).toBe(payoutLineCreateCallsBefore)
    expect((prisma.collectionDisposal.create as Mock).mock.calls.length).toBe(disposalCreateCallsBefore)
    expect((prisma.collectionDisposalAllocation.createMany as Mock).mock.calls.length).toBe(allocationCreateCallsBefore)
    expect(testState.lot.remainingQuantity).toBe(0)

    const disposal = testState.getDisposal()!
    expect(disposal.netProceedsCents).toBe(disposalBefore.netProceedsCents) // no rewrite
    expect(disposal.grossProceedsCents).toBe(disposalBefore.grossProceedsCents)
  })
})
