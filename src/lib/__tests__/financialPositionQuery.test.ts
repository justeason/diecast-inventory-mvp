import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { count: vi.fn(), aggregate: vi.fn() },
    sellerPayoutLine: { count: vi.fn() },
    riskApprovalRequest: { findMany: vi.fn() },
    sellerPayout: { aggregate: vi.fn() },
    order: { count: vi.fn() },
    orderItem: { aggregate: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import {
  getOwnedInventoryPosition, getOwnedInventoryAging,
  getConsignedInventoryHeld, getPayoutApprovalAttention, getBuyerPaymentsCaptured,
} from '@/lib/financialPositionQuery'
import * as financialPositionQuery from '@/lib/financialPositionQuery'

beforeEach(() => vi.resetAllMocks())

const ALL_TIME_RANGE = { preset: 'all' as const, start: null, end: new Date('2026-08-16'), label: 'All time' }

describe('getOwnedInventoryPosition (Part C/5-7, Part Z/57-58)', () => {
  it('candidate where excludes sold status and any item with completed-order evidence, scoped to buyout/company_owned', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValue({ _count: { _all: 0 }, _sum: { purchasePrice: null } })
    await getOwnedInventoryPosition()
    const call = (prisma.itemInstance.count as Mock).mock.calls[0][0]
    expect(call.where.sourceType.in.sort()).toEqual(['buyout', 'company_owned'])
    expect(call.where.status).toEqual({ not: 'sold' })
    expect(call.where.orderItems).toEqual({ none: { order: { status: 'complete' } } })
  })

  it('null purchasePrice is never counted as $0 — cost coverage reflects unitsWithCost/ownedUnits exactly', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(10) // total owned
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _count: { _all: 6 }, _sum: { purchasePrice: 1234.5 } })
    const result = await getOwnedInventoryPosition()
    expect(result.ownedUnits).toBe(10)
    expect(result.unitsWithCost).toBe(6)
    expect(result.unitsWithoutCost).toBe(4)
    expect(result.allocatedCost.toFixed(2)).toBe('1234.50')
    expect(result.costCoverage).toMatchObject({ status: 'partial', coveragePct: 60, knownUnits: 6, totalUnits: 10 })
  })

  it('full coverage (every owned unit has a cost) reports status=available', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(4)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _count: { _all: 4 }, _sum: { purchasePrice: 400 } })
    const result = await getOwnedInventoryPosition()
    expect(result.costCoverage.status).toBe('available')
  })

  it('zero owned units reports cost coverage as unavailable, not $0/0%', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(0)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { purchasePrice: null } })
    const result = await getOwnedInventoryPosition()
    expect(result.costCoverage.status).toBe('unavailable')
  })

  it('uses DB-side aggregate _sum, not a JS reduce over loaded rows — count/aggregate only, never findMany', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValue({ _count: { _all: 0 }, _sum: { purchasePrice: null } })
    await getOwnedInventoryPosition()
    expect(prisma.itemInstance.count).toHaveBeenCalledTimes(1)
    expect(prisma.itemInstance.aggregate).toHaveBeenCalledTimes(1)
  })
})

// 15N focused-review (buyout-cost-semantics pass): getUnallocatedBuyoutCost was
// removed entirely — there is no valid way to attribute any portion of a multi-item
// buyout agreement's total to specific remaining units. These tests exercise the
// milestone's own worked examples directly against getOwnedInventoryPosition to
// prove the removal is complete and the remaining metric stays truthful.
describe('getOwnedInventoryPosition — multi-item buyout worked examples (focused-review Part 1/6/9)', () => {
  it('partial batch sold (10 items / $100 total / 9 sold / 1 held, no item-level cost recorded): held=1, exact-cost=0, coverage 0%, no $100/$10 anywhere', async () => {
    // The 9 sold units are excluded entirely by OWNED_CANDIDATE_WHERE (completed-
    // order evidence) — only the 1 still-held, still-uncosted unit is queried here.
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(1)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { purchasePrice: null } })
    const result = await getOwnedInventoryPosition()
    expect(result.ownedUnits).toBe(1)
    expect(result.unitsWithCost).toBe(0)
    expect(result.allocatedCost.toFixed(2)).toBe('0.00')
    expect(result.costCoverage).toMatchObject({ status: 'partial', coveragePct: 0, knownUnits: 0, totalUnits: 1 })
  })

  it('entire multi-item batch still held (10 items / $100 agreement, no item-level cost recorded): 10 units, 0 exact-cost units, 0% coverage — agreement total never surfaces as current cost', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(10)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { purchasePrice: null } })
    const result = await getOwnedInventoryPosition()
    expect(result.ownedUnits).toBe(10)
    expect(result.unitsWithCost).toBe(0)
    expect(result.allocatedCost.toFixed(2)).toBe('0.00')
    expect(result.costCoverage).toMatchObject({ status: 'partial', coveragePct: 0 })
  })

  it('mixed population (single-item buyout $12.34 + company-owned $5.67, both exact, plus unallocated multi-item batch units): recorded cost is exactly $18.01, coverage counts only the 2 exact-cost units', async () => {
    // 2 exact-cost units + 8 unallocated multi-item-batch units = 10 owned units total.
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(10)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { purchasePrice: 18.01 } })
    const result = await getOwnedInventoryPosition()
    expect(result.allocatedCost.toFixed(2)).toBe('18.01')
    expect(result.costCoverage).toMatchObject({ status: 'partial', coveragePct: 20, knownUnits: 2, totalUnits: 10 })
  })

  it('getUnallocatedBuyoutCost no longer exists as an export', () => {
    expect((financialPositionQuery as Record<string, unknown>).getUnallocatedBuyoutCost).toBeUndefined()
  })
})

describe('getOwnedInventoryAging (Part M/36)', () => {
  it('produces exactly 4 buckets (0-30/31-60/61-90/90+), each with a bounded count+aggregate pair', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValue({ _count: { _all: 0 }, _sum: { purchasePrice: null } })
    const result = await getOwnedInventoryAging(new Date('2026-08-16'))
    expect(result.map((b) => b.key)).toEqual(['0-30', '31-60', '61-90', '90+'])
    expect(prisma.itemInstance.count).toHaveBeenCalledTimes(4)
  })

  it('a bucket with units but no known cost reports knownCost as zero-with-zero-units, not a fabricated figure', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(5).mockResolvedValue(0)
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { purchasePrice: null } }).mockResolvedValue({ _count: { _all: 0 }, _sum: { purchasePrice: null } })
    const result = await getOwnedInventoryAging(new Date('2026-08-16'))
    expect(result[0].units).toBe(5)
    expect(result[0].unitsWithCost).toBe(0)
  })
})

describe('getConsignedInventoryHeld (Part E/12, Part Z/60)', () => {
  it('never queries by buyout/company_owned — consignment only', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.sellerPayoutLine.count as Mock).mockResolvedValue(0)
    await getConsignedInventoryHeld()
    for (const [args] of (prisma.itemInstance.count as Mock).mock.calls) {
      expect(args.where.sourceType).toBe('consignment')
    }
  })

  it('sold-awaiting-payout reuses the exact outstanding-liability predicate shape, scoped to consignment lines', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.sellerPayoutLine.count as Mock).mockResolvedValue(3)
    const result = await getConsignedInventoryHeld()
    const call = (prisma.sellerPayoutLine.count as Mock).mock.calls[0][0]
    expect(call.where.lineType).toBe('consignment')
    expect(call.where.status).toEqual({ in: ['eligible', 'held'] })
    expect(result.soldAwaitingPayout).toBe(3)
  })
})

describe('getPayoutApprovalAttention (Part F/17, Part P/41)', () => {
  it('reads persisted RiskApprovalRequest state only — never re-evaluates risk', async () => {
    ;(prisma.riskApprovalRequest.findMany as Mock).mockResolvedValue([])
    ;(prisma.sellerPayout.aggregate as Mock).mockResolvedValue({ _sum: { totalAmount: new Prisma.Decimal(0) }, _count: { _all: 0 } })
    await getPayoutApprovalAttention()
    expect(prisma.riskApprovalRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { action: 'seller_payout_mark_paid', status: 'pending' } }))
  })

  it('splits approved payouts into ready-to-pay vs pending-approval without double counting the total', async () => {
    ;(prisma.riskApprovalRequest.findMany as Mock).mockResolvedValue([{ targetId: 'payout1' }])
    ;(prisma.sellerPayout.aggregate as Mock)
      .mockResolvedValueOnce({ _sum: { totalAmount: new Prisma.Decimal('500.00') }, _count: { _all: 5 } }) // all approved
      .mockResolvedValueOnce({ _sum: { totalAmount: new Prisma.Decimal('100.00') }, _count: { _all: 1 } }) // pending-approval subset
    const result = await getPayoutApprovalAttention()
    expect(result.readyToPay.toFixed(2)).toBe('400.00')
    expect(result.readyToPayCount).toBe(4)
    expect(result.pendingApproval.toFixed(2)).toBe('100.00')
    expect(result.pendingApprovalCount).toBe(1)
  })

  it('no pending approvals -> readyToPay equals the full approved total, no second query needed', async () => {
    ;(prisma.riskApprovalRequest.findMany as Mock).mockResolvedValue([])
    ;(prisma.sellerPayout.aggregate as Mock).mockResolvedValueOnce({ _sum: { totalAmount: new Prisma.Decimal('200.00') }, _count: { _all: 2 } })
    const result = await getPayoutApprovalAttention()
    expect(result.readyToPay.toFixed(2)).toBe('200.00')
    expect(result.pendingApproval.toFixed(2)).toBe('0.00')
    expect(prisma.sellerPayout.aggregate).toHaveBeenCalledTimes(1)
  })
})

describe('getBuyerPaymentsCaptured (Part I/24, Part Z/61)', () => {
  it('filters strictly to paymentStatus=paid — never order.status=complete alone', async () => {
    ;(prisma.order.count as Mock).mockResolvedValue(0)
    ;(prisma.orderItem.aggregate as Mock).mockResolvedValue({ _sum: { price: null } })
    await getBuyerPaymentsCaptured(ALL_TIME_RANGE)
    const orderCall = (prisma.order.count as Mock).mock.calls[0][0]
    expect(orderCall.where.paymentStatus).toBe('paid')
    const oiCall = (prisma.orderItem.aggregate as Mock).mock.calls[0][0]
    expect(oiCall.where.order.paymentStatus).toBe('paid')
  })

  it('uses paidAt (not completedAt/createdAt) as the range timestamp', async () => {
    ;(prisma.order.count as Mock).mockResolvedValue(0)
    ;(prisma.orderItem.aggregate as Mock).mockResolvedValue({ _sum: { price: null } })
    const range = { preset: '30d' as const, start: new Date('2026-07-01'), end: new Date('2026-08-01'), label: '30 days' }
    await getBuyerPaymentsCaptured(range)
    const orderCall = (prisma.order.count as Mock).mock.calls[0][0]
    expect(orderCall.where.paidAt).toEqual({ gte: range.start, lt: range.end })
  })

  it('DB-side aggregate sum, exact for awkward cents', async () => {
    ;(prisma.order.count as Mock).mockResolvedValue(3)
    ;(prisma.orderItem.aggregate as Mock).mockResolvedValue({ _sum: { price: 30.03 } })
    const result = await getBuyerPaymentsCaptured(ALL_TIME_RANGE)
    expect(result.count).toBe(3)
    expect(result.amount.toFixed(2)).toBe('30.03')
  })
})
