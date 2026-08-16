// 15H: DB-boundary tests for adminOperationsQuery.ts. Reused modules (15E exception
// summary, 15F approval summary, 14B overview metrics) are mocked here rather than
// re-verified — their own behavior is covered by intakeExceptionQueueQuery.test.ts /
// riskPolicyQuery.test.ts / businessAnalyticsQuery tests. This file checks that
// adminOperationsQuery composes them correctly AND — 15H focused-review section 1 —
// that every authoritative count/sum is a true DB-side COUNT/aggregate/raw query
// with NO row cap, verified here specifically with values far beyond any plausible
// `take` bound to prove the numbers aren't silently truncated.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    sellerInboundShipment: { count: vi.fn(), aggregate: vi.fn() },
    itemInstance: { count: vi.fn() },
    order: { count: vi.fn() },
    listing: { count: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))

vi.mock('@/lib/intakeExceptionQueueQuery', () => ({
  getExceptionQueueSummary: vi.fn(),
}))
vi.mock('@/lib/riskPolicyQuery', () => ({
  getApprovalQueueSummary: vi.fn(),
}))
vi.mock('@/lib/businessAnalyticsQuery', () => ({
  getOverviewMetrics: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { getExceptionQueueSummary } from '@/lib/intakeExceptionQueueQuery'
import { getApprovalQueueSummary } from '@/lib/riskPolicyQuery'
import { getOverviewMetrics } from '@/lib/businessAnalyticsQuery'
import { getAdminAttentionBadges, getCommandCenterData } from '@/lib/adminOperationsQuery'

function baseMocks() {
  ;(getExceptionQueueSummary as Mock).mockResolvedValue({
    open: 8, byCategory: { data_fixable: 5, retryable: 1, commercial_blocker: 2 },
    byCode: { unknown_model: 4, invalid_storage: 1, missing_condition: 0, unexpected_overage: 2, conversion_failed: 1 },
    oldestCreatedAt: null,
  })
  ;(getApprovalQueueSummary as Mock).mockResolvedValue({ pending: 3, byRiskLevel: { high: 1, medium: 2 } })
  ;(getOverviewMetrics as Mock).mockResolvedValue({
    unitsSold: 19, completedOrders: 12, gmv: { toNumber: () => 428.5 },
    grossSpreadDetermined: 0, grossSpreadUndeterminedItems: 0,
    grossMarginDetermined: 0, grossMarginUndeterminedItems: 0,
    activeInventory: 0, sellThrough: { numerator: 0, denominator: 0 }, medianDaysToSell: null,
    daysToSellInvalidCount: 0, listingToSale: { numerator: 0, denominator: 0 },
    unpaidSellerLiability: 0, sellersWithCompletedSales: 0,
  })
  ;(prisma.sellerInboundShipment.count as Mock).mockImplementation((args: { where?: { status?: string; intakeDraftLineage?: unknown } }) => {
    if (args?.where?.status === 'issue') return Promise.resolve(2)
    if (args?.where?.intakeDraftLineage) return Promise.resolve(1) // intake-in-progress branch
    return Promise.resolve(0)
  })
  ;(prisma.sellerInboundShipment.aggregate as Mock).mockResolvedValue({ _count: { _all: 2 }, _sum: { receivedQuantity: 142 } })
  ;(prisma.$queryRaw as Mock).mockResolvedValue([{ count: 4 }])
  ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
  ;(prisma.order.count as Mock).mockResolvedValue(0)
  ;(prisma.listing.count as Mock).mockResolvedValue(0)
}

describe('getAdminAttentionBadges — nav badge query', () => {
  beforeEach(() => { vi.resetAllMocks(); baseMocks() })

  it('composes exceptions/approvals/shipment-discrepancy counts from the reused authoritative summaries', async () => {
    const badges = await getAdminAttentionBadges()
    expect(badges).toEqual({ intakeExceptions: 8, pendingApprovals: 3, shipmentDiscrepancies: 2 })
  })

  it('the shipment-discrepancy count is a single indexed COUNT with no row cap', async () => {
    await getAdminAttentionBadges()
    expect(prisma.sellerInboundShipment.count).toHaveBeenCalledWith({ where: { status: 'issue' } })
  })
})

describe('getCommandCenterData — payoutReady (focused-review section 1 & 5)', () => {
  beforeEach(() => { vi.resetAllMocks(); baseMocks() })

  it('is computed via a single raw NOT EXISTS query, not a capped findMany + JS set-difference', async () => {
    await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    const [strings] = (prisma.$queryRaw as Mock).mock.calls[0]
    const sql = strings.join(' ')
    expect(sql).toMatch(/NOT EXISTS/)
    expect(sql).toMatch(/"SellerPayout"/)
    expect(sql).toMatch(/"RiskApprovalRequest"/)
    expect(sql).toMatch(/seller_payout/)
  })

  it('stays exact for a payout count far beyond any plausible row cap (e.g. 500)', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([{ count: 500 }])
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    expect(data.workQueues.payoutReady.count).toBe(500)
  })

  it('is represented once — no separate "payouts needing action" needsAttention item duplicating the Work Queue number', async () => {
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    const codes = data.needsAttention.map((i) => i.code)
    expect(codes).not.toContain('payouts_ready')
    // Pending mark-paid approvals remain visible exclusively via pending_approvals.
    expect(codes).toContain('pending_approvals')
  })
})

describe('getCommandCenterData — Ready for Intake / Intake In Progress (focused-review section 1)', () => {
  beforeEach(() => { vi.resetAllMocks(); baseMocks() })

  it('Ready for Intake uses a DB-side aggregate (count + sum) filtered by the real intakeDraftLineage relation, never a row-capped findMany', async () => {
    await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    const call = (prisma.sellerInboundShipment.aggregate as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ status: 'received', intakeDraftLineage: { none: {} } })
    expect(call._sum).toEqual({ receivedQuantity: true })
    expect(call.take).toBeUndefined()
  })

  it('Intake In Progress uses a DB-side count filtered by intakeDraftLineage: some, never a row-capped findMany', async () => {
    await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    const call = (prisma.sellerInboundShipment.count as Mock).mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c[0]?.where?.intakeDraftLineage,
    )
    expect(call![0].where).toEqual({ status: 'received', intakeDraftLineage: { some: {} } })
    expect(call![0].take).toBeUndefined()
  })

  it('stays exact for 250 ready shipments summing 9,001 recorded units — well beyond a 200-row cap', async () => {
    ;(prisma.sellerInboundShipment.aggregate as Mock).mockResolvedValue({ _count: { _all: 250 }, _sum: { receivedQuantity: 9001 } })
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    expect(data.workQueues.readyForIntake).toEqual({ shipments: 250, units: 9001, href: '/admin/intake/operations' })
  })

  it('stays exact for 301 in-progress shipments — well beyond a 200-row cap', async () => {
    ;(prisma.sellerInboundShipment.count as Mock).mockImplementation((args: { where?: { status?: string; intakeDraftLineage?: unknown } }) => {
      if (args?.where?.status === 'issue') return Promise.resolve(2)
      if (args?.where?.intakeDraftLineage) return Promise.resolve(301)
      return Promise.resolve(0)
    })
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    expect(data.workQueues.intakeInProgress).toEqual({ shipments: 301, href: '/admin/intake/operations' })
  })

  it('a zero-received sum is 0, not null — aggregate _sum.receivedQuantity defaults correctly', async () => {
    ;(prisma.sellerInboundShipment.aggregate as Mock).mockResolvedValue({ _count: { _all: 0 }, _sum: { receivedQuantity: null } })
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    expect(data.workQueues.readyForIntake.units).toBe(0)
  })
})

describe('getCommandCenterData — needsAttention link-only items (Part C section 7)', () => {
  beforeEach(() => { vi.resetAllMocks(); baseMocks() })

  it('portfolio_issues and inventory_contradictions carry count: null, never a fabricated/expensive exact number', async () => {
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    const byCode = Object.fromEntries(data.needsAttention.map((i) => [i.code, i]))
    expect(byCode.portfolio_issues.count).toBeNull()
    expect(byCode.portfolio_issues.href).toBe('/admin/seller-portfolios?filter=needs_attention')
    expect(byCode.inventory_contradictions.count).toBeNull()
  })

  it('intake_exceptions and pending_approvals carry the reused authoritative counts verbatim', async () => {
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    const byCode = Object.fromEntries(data.needsAttention.map((i) => [i.code, i]))
    expect(byCode.intake_exceptions.count).toBe(8)
    expect(byCode.pending_approvals.count).toBe(3)
    expect(byCode.pending_approvals.detail).toBe('1 high / 2 medium')
  })
})

describe('getCommandCenterData — today business pulse uses a UTC calendar day (Part L)', () => {
  beforeEach(() => { vi.resetAllMocks(); baseMocks() })

  it('items-processed/listed-today counts are filtered to createdAt >= UTC midnight of `now`', async () => {
    await getCommandCenterData(new Date('2026-08-15T23:59:00Z'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemsCall = (prisma.itemInstance.count as Mock).mock.calls.find((c: any) => c[0]?.where?.createdAt)
    const listingsCall = (prisma.listing.count as Mock).mock.calls[0][0]
    expect(itemsCall![0].where.createdAt.gte.toISOString()).toBe('2026-08-15T00:00:00.000Z')
    expect(listingsCall.where.createdAt.gte.toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })

  it('items-processed uses ItemInstance.createdAt (the one-time creation event), never updatedAt', async () => {
    await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemsCall = (prisma.itemInstance.count as Mock).mock.calls.find((c: any) => c[0]?.where?.createdAt)
    expect(itemsCall![0].where).not.toHaveProperty('updatedAt')
    expect(itemsCall![0].where).toHaveProperty('createdAt')
  })

  it('items-listed uses Listing.createdAt — every Listing row is created with status active (createListing never persists a draft row), so createdAt IS the activation moment', async () => {
    // 15K: the raw tx.listing.create call site lives in listingActivation.ts now
    // (shared boundary — see listingActivation.test.ts), not actions/listings.ts.
    const listingsSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/listingActivation.ts'), 'utf-8')
    // The only Listing.create call site in the codebase always writes status: 'active'.
    const createCallIdx = listingsSrc.indexOf('tx.listing.create(')
    expect(createCallIdx).toBeGreaterThan(-1)
    expect(listingsSrc.slice(createCallIdx, createCallIdx + 300)).toMatch(/status:\s*'active'/)
  })

  it('reuses getOverviewMetrics (14B) for units sold / completed orders / GMV today rather than re-deriving them', async () => {
    const data = await getCommandCenterData(new Date('2026-08-15T12:00:00Z'))
    expect(getOverviewMetrics).toHaveBeenCalledTimes(1)
    expect(data.businessPulse.unitsSoldToday).toBe(19)
    expect(data.businessPulse.completedOrdersToday).toBe(12)
  })
})

describe('safety (Part J section 34 / Part P section 50) — command-center reads never mutate', () => {
  it('adminOperationsQuery.ts contains no create/update/delete/upsert calls', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/adminOperationsQuery.ts'), 'utf-8')
    expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('no authoritative query in this file is row-capped (no findMany/take at all — every read is count/aggregate/groupBy/raw)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/adminOperationsQuery.ts'), 'utf-8')
    expect(src).not.toMatch(/\.findMany\(/)
    expect(src).not.toMatch(/\btake:/)
  })
})
