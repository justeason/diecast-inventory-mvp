import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { findUnique: vi.fn(), findMany: vi.fn() },
    orderItem: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    sellerAgreement: { findUnique: vi.fn() },
    sellerPayoutLine: { findMany: vi.fn(), findFirst: vi.fn() },
    sellerSubmission: { findUnique: vi.fn() },
    sellerPortfolio: { findUnique: vi.fn() },
    sellerInboundShipment: { findMany: vi.fn() },
    sellerProfile: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/pricingIntelligenceQuery', () => ({
  getPricingIntelligence: vi.fn().mockResolvedValue(null),
  getListingPriceComparison: vi.fn().mockResolvedValue(null),
}))

import { prisma } from '@/lib/prisma'
import { getPricingIntelligence, getListingPriceComparison } from '@/lib/pricingIntelligenceQuery'
import { getItemLifecycleRecord, searchItemsPage } from '@/lib/itemLifecycleQuery'

const D = (s: string) => new Prisma.Decimal(s)

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item1', sku: 'CT-0001', catalogId: 'cat1', locationId: 'loc1',
    cardedOrLoose: 'carded', condition: 'mint', conditionNotes: null,
    purchasePrice: null, listPrice: 20, status: 'available', notes: null,
    sourceType: null, sellerAgreementId: null, sellerPortfolioId: null,
    sellerInboundShipmentId: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    catalog: { brand: 'Hot Wheels', name: 'Porsche 911', series: null, year: 2024, color: null, scale: null },
    location: { id: 'loc1', label: 'B-14-03' },
    listing: null,
    intakeDraft: null,
    ...overrides,
  }
}

type OrderFixture = {
  id: string
  price: number
  createdAt: Date
  order: { id: string; status: string; paymentStatus: string; completedAt: Date | null; paidAt: Date | null; createdAt: Date }
}

// 15C-review section 1: getItemLifecycleRecord now issues THREE independent, bounded
// queries for order state — a `complete`-status findFirst, a non-complete/non-cancelled
// findFirst, and a bounded recent-history findMany (+ two counts) — instead of loading
// one capped list and filtering in memory. This helper drives all of them from a single
// declarative fixture list, mirroring what the real DB would return for each query.
function mockOrders(orders: OrderFixture[], opts: { timelineLimit?: number } = {}) {
  const byCreatedAsc = [...orders].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  const byCreatedDesc = [...orders].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
  const completed = byCreatedAsc.filter(o => o.order.status === 'complete')
  const active = byCreatedDesc.filter(o => o.order.status !== 'complete' && o.order.status !== 'cancelled')
  const timelineLimit = opts.timelineLimit ?? 20

  ;(prisma.orderItem.findFirst as Mock).mockImplementation((args: { where: { order?: { status?: unknown } } }) => {
    const statusFilter = args.where.order?.status
    if (statusFilter === 'complete') return Promise.resolve(completed[0] ?? null)
    return Promise.resolve(active[0] ?? null) // the {notIn: [...]} active-order query
  })
  ;(prisma.orderItem.findMany as Mock).mockResolvedValue(byCreatedDesc.slice(0, timelineLimit))
  ;(prisma.orderItem.count as Mock).mockImplementation((args: { where: { order?: { status?: unknown } } }) => {
    if (args.where.order?.status === 'complete') return Promise.resolve(completed.length)
    return Promise.resolve(orders.length) // total (no status filter) query
  })
}

function mockNoOrders() {
  mockOrders([])
}

describe('getItemLifecycleRecord — lineage (section 4/5)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns null for a missing item rather than throwing', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(null)
    const record = await getItemLifecycleRecord('missing')
    expect(record).toBeNull()
  })

  it('consignment item resolves full lineage: seller, portfolio, submission, agreement', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      sourceType: 'consignment', sellerAgreementId: 'agr1', sellerPortfolioId: 'port1',
      intakeDraft: { id: 'draft1', sellerSubmissionId: 'sub1', createdAt: new Date('2026-01-01') },
    }))
    ;(prisma.sellerAgreement.findUnique as Mock).mockResolvedValueOnce({
      id: 'agr1', status: 'accepted', submissionId: 'sub1', sellerProfileId: 'sp1', sellerPortfolioId: 'port1',
      proposedAt: new Date('2025-12-20'), acceptedAt: new Date('2025-12-21'),
    })
    mockNoOrders()
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ id: 'sub1', createdAt: new Date('2025-12-01'), profileId: 'prof1', sellerPortfolioId: 'port1' })
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({ id: 'port1', name: 'Summer 2026' })
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([{ id: 'ship1', createdAt: new Date('2025-12-05'), receivedAt: new Date('2025-12-10') }])
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ id: 'sp1', profile: { name: 'Alice', email: 'a@x.com' } })

    const record = await getItemLifecycleRecord('item1')
    expect(record!.source).toMatchObject({
      type: 'consignment', sellerProfileId: 'sp1', sellerLabel: 'Alice',
      sellerPortfolioId: 'port1', portfolioName: 'Summer 2026',
      submissionId: 'sub1', agreementId: 'agr1', agreementStatus: 'accepted',
      inboundShipmentId: 'ship1', intakeDraftId: 'draft1',
    })
  })

  it('buyout item never fabricates portfolio/submission lineage it does not have', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: 'buyout', sellerAgreementId: 'agr2' }))
    ;(prisma.sellerAgreement.findUnique as Mock).mockResolvedValueOnce({
      id: 'agr2', status: 'accepted', submissionId: 'sub2', sellerProfileId: 'sp2', sellerPortfolioId: null,
      proposedAt: null, acceptedAt: new Date('2025-11-01'),
    })
    mockNoOrders()
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ id: 'sub2', createdAt: new Date('2025-10-01'), profileId: 'prof2', sellerPortfolioId: null })
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ id: 'sp2', profile: { name: null, email: 'b@x.com' } })

    const record = await getItemLifecycleRecord('item1')
    expect(record!.source.type).toBe('buyout')
    expect(record!.source.sellerPortfolioId).toBeNull()
    expect(record!.source.portfolioName).toBeNull()
  })

  it('legacy item with no sourceType reports "unknown", never guessed as consignment/buyout', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: null }))
    mockNoOrders()
    const record = await getItemLifecycleRecord('item1')
    expect(record!.source.type).toBe('unknown')
    expect(record!.source.sellerProfileId).toBeNull()
  })

  it('a portfolio with multiple shipments for the submission leaves inboundShipmentId null rather than guessing which one', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      sourceType: 'consignment', sellerAgreementId: 'agr1', sellerPortfolioId: 'port1',
      intakeDraft: { id: 'draft1', sellerSubmissionId: 'sub1', createdAt: new Date() },
    }))
    ;(prisma.sellerAgreement.findUnique as Mock).mockResolvedValueOnce({
      id: 'agr1', status: 'accepted', submissionId: 'sub1', sellerProfileId: 'sp1', sellerPortfolioId: 'port1', proposedAt: null, acceptedAt: null,
    })
    mockNoOrders()
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ id: 'sub1', createdAt: new Date(), profileId: 'prof1', sellerPortfolioId: 'port1' })
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({ id: 'port1', name: 'P' })
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([
      { id: 'ship1', createdAt: new Date(), receivedAt: null },
      { id: 'ship2', createdAt: new Date(), receivedAt: null },
    ])
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ id: 'sp1', profile: { name: 'A', email: 'a@x.com' } })

    const record = await getItemLifecycleRecord('item1')
    expect(record!.source.inboundShipmentId).toBeNull()
    expect(record!.source.shipmentLineageAmbiguous).toBe(true)
    expect(record!.source.shipmentLineageExplicit).toBe(false)
  })

  it('15D: an item with an explicit sellerInboundShipmentId reports authoritative lineage even when the submission has multiple shipments', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      sourceType: 'consignment', sellerAgreementId: 'agr1', sellerPortfolioId: 'port1',
      sellerInboundShipmentId: 'shipExplicit',
      intakeDraft: { id: 'draft1', sellerSubmissionId: 'sub1', createdAt: new Date() },
    }))
    ;(prisma.sellerAgreement.findUnique as Mock).mockResolvedValueOnce({
      id: 'agr1', status: 'accepted', submissionId: 'sub1', sellerProfileId: 'sp1', sellerPortfolioId: 'port1', proposedAt: null, acceptedAt: null,
    })
    mockNoOrders()
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ id: 'sub1', createdAt: new Date(), profileId: 'prof1', sellerPortfolioId: 'port1' })
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({ id: 'port1', name: 'P' })
    // Multiple shipments exist for the submission — the old (pre-15D) heuristic would
    // have reported this as ambiguous, but the explicit FK now wins outright.
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([
      { id: 'ship1', createdAt: new Date(), receivedAt: null },
      { id: 'shipExplicit', createdAt: new Date(), receivedAt: null },
    ])
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ id: 'sp1', profile: { name: 'A', email: 'a@x.com' } })

    const record = await getItemLifecycleRecord('item1')
    expect(record!.source.inboundShipmentId).toBe('shipExplicit')
    expect(record!.source.shipmentLineageExplicit).toBe(true)
    expect(record!.source.shipmentLineageAmbiguous).toBe(false)
  })

  it('legacy item (no explicit shipment, exactly one non-cancelled shipment) still infers lineage but marks it non-authoritative', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      sourceType: 'consignment', sellerAgreementId: 'agr1', sellerPortfolioId: 'port1',
      intakeDraft: { id: 'draft1', sellerSubmissionId: 'sub1', createdAt: new Date() },
    }))
    ;(prisma.sellerAgreement.findUnique as Mock).mockResolvedValueOnce({
      id: 'agr1', status: 'accepted', submissionId: 'sub1', sellerProfileId: 'sp1', sellerPortfolioId: 'port1', proposedAt: null, acceptedAt: null,
    })
    mockNoOrders()
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ id: 'sub1', createdAt: new Date(), profileId: 'prof1', sellerPortfolioId: 'port1' })
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({ id: 'port1', name: 'P' })
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([{ id: 'ship1', createdAt: new Date(), receivedAt: null }])
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ id: 'sp1', profile: { name: 'A', email: 'a@x.com' } })

    const record = await getItemLifecycleRecord('item1')
    expect(record!.source.inboundShipmentId).toBe('ship1')
    expect(record!.source.shipmentLineageExplicit).toBe(false)
    expect(record!.source.shipmentLineageAmbiguous).toBe(false)
  })
})

describe('getItemLifecycleRecord — listing / order / finance (sections 10/11/12)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('current active listing is selected deterministically (the single Listing row — schema allows at most one)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      listing: { id: 'list1', status: 'active', price: 25, version: 2, createdAt: new Date('2026-01-05'), updatedAt: new Date('2026-01-06') },
    }))
    mockNoOrders()
    const record = await getItemLifecycleRecord('item1')
    expect(record!.listing).toMatchObject({ id: 'list1', status: 'active', price: 25 })
  })

  it('a completed order is shown with sale price and completion date', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date('2026-02-01'),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-02-02'), paidAt: new Date('2026-02-01'), createdAt: new Date('2026-02-01') },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order).toMatchObject({ orderId: 'order1', status: 'complete', price: 25 })
    expect(record!.order!.completedAt).toEqual(new Date('2026-02-02'))
  })

  it('a cancelled order is not interpreted as a sale (hasCompletedOrder stays false -> not "completed" stage)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'available' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date('2026-02-01'),
      order: { id: 'order1', status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-02-01') },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.lifecycleStage).not.toBe('completed')
    expect(record!.lifecycleStage).not.toBe('sold')
  })

  it('the item read model never includes buyer PII fields', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    const record = await getItemLifecycleRecord('item1')
    const serialized = JSON.stringify(record)
    expect(serialized).not.toMatch(/buyerName|buyerEmail|buyerPhone/i)
  })

  it('payout line values (commission/proceeds) are authoritative snapshot values, never recomputed', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: 'consignment', status: 'sold' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    ;(prisma.sellerPayoutLine.findFirst as Mock).mockResolvedValueOnce({
      id: 'line1', orderItemId: 'oi1', status: 'eligible', grossSalePrice: D('25.00'), commissionAmount: D('5.00'), netAmount: D('20.00'),
      payoutId: null, createdAt: new Date('2026-02-02'), payout: null,
    })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.financial.grossSalePrice!.toFixed(2)).toBe('25.00')
    expect(record!.financial.commissionAmount!.toFixed(2)).toBe('5.00')
    expect(record!.financial.sellerProceeds!.toFixed(2)).toBe('20.00')
  })

  it('company-owned gross margin is computed from purchase cost, admin-only field, never labeled profit in the data model', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: 'company_owned', status: 'sold', purchasePrice: 10 }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.financial.grossMargin!.toFixed(2)).toBe('15.00')
    expect(record!.financial.purchasePrice).toBe(10)
  })

  it('no fabricated revenue: without an order, grossSalePrice/grossMargin are null, never zero-filled or guessed', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: 'company_owned', purchasePrice: 10 }))
    mockNoOrders()
    const record = await getItemLifecycleRecord('item1')
    expect(record!.financial.grossSalePrice).toBeNull()
    expect(record!.financial.grossMargin).toBeNull()
  })

  it('15D-review (financial pass) section 1: a buyout item with unallocated item-level cost (purchasePrice null, sold via a multi-unit workbench batch) reports grossMargin as null — never a fabricated figure derived from the agreement total', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: 'buyout', status: 'sold', purchasePrice: null }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.financial.purchasePrice).toBeNull()
    expect(record!.financial.grossMargin).toBeNull()
    expect(record!.financial.grossSalePrice).not.toBeNull() // sale price itself is still known — only cost basis is unallocated
  })

  it('15C-review section 8: awkward-cents buyout margin stays exact through Decimal arithmetic (no JS Float accumulation)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: 'buyout', status: 'sold', purchasePrice: 9.97 }))
    mockOrders([{
      id: 'oi1', price: 19.99, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.financial.grossMargin!.toFixed(2)).toBe('10.02')
  })
})

describe('getItemLifecycleRecord — current-order selection stays correct beyond any history cap (15C-review section 1/2)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('cancelled order + active listing -> "order" is null and stage is "listed" (item.status/listing drive it, not the stale order)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      status: 'available',
      listing: { id: 'list1', status: 'active', price: 25, version: 2, createdAt: new Date(), updatedAt: new Date() },
    }))
    mockOrders([{
      id: 'oiCancelled', price: 25, createdAt: new Date('2026-01-01'),
      order: { id: 'orderCancelled', status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-01-01') },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order).toBeNull()
    expect(record!.lifecycleStage).toBe('listed')
  })

  it('cancelled order + available item + no listing -> "order" is null and stage is "available"', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'available', listing: null }))
    mockOrders([{
      id: 'oiCancelled', price: 25, createdAt: new Date('2026-01-01'),
      order: { id: 'orderCancelled', status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-01-01') },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order).toBeNull()
    expect(record!.lifecycleStage).toBe('available')
  })

  it('no relevant order at all (no orders ever placed) -> Available/List state derives purely from inventory/listing', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'available', listing: null }))
    mockNoOrders()
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order).toBeNull()
    expect(record!.lifecycleStage).toBe('available')
  })

  it('cancelled old order + current pending order -> current order is the pending one', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'reserved' }))
    mockOrders([
      {
        id: 'oiOld', price: 25, createdAt: new Date('2026-01-01'),
        order: { id: 'orderOld', status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-01-01') },
      },
      {
        id: 'oiNew', price: 25, createdAt: new Date('2026-02-01'),
        order: { id: 'orderNew', status: 'pending', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-02-01') },
      },
    ])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order?.orderId).toBe('orderNew')
    expect(record!.lifecycleStage).toBe('reserved')
  })

  it('cancelled old order + later completed order -> current order is the completed one, stage reflects the sale', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold', sourceType: 'company_owned' }))
    mockOrders([
      {
        id: 'oiOld', price: 25, createdAt: new Date('2026-01-01'),
        order: { id: 'orderOld', status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-01-01') },
      },
      {
        id: 'oiNew', price: 25, createdAt: new Date('2026-02-01'),
        order: { id: 'orderNew', status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-02-02'), paidAt: new Date('2026-02-01'), createdAt: new Date('2026-02-01') },
      },
    ])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order?.orderId).toBe('orderNew')
    expect(record!.lifecycleStage).toBe('completed')
  })

  it('a historical cancelled order still appears in the timeline even though it is not "current"', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'available' }))
    mockOrders([{
      id: 'oiCancelled', price: 25, createdAt: new Date('2026-01-05'),
      order: { id: 'orderCancelled', status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-01-05') },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.timeline.some(t => t.title.includes('cancelled'))).toBe(true)
  })

  it('the completed sale remains authoritative even with 25 cancelled historical attempts (beyond the 20-item timeline presentation bound)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold', sourceType: 'company_owned' }))
    const cancelledHistory: OrderFixture[] = Array.from({ length: 25 }, (_, i) => ({
      id: `oiCancelled${i}`, price: 25, createdAt: new Date(2026, 0, i + 1),
      order: { id: `orderCancelled${i}`, status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date(2026, 0, i + 1) },
    }))
    const completedOrder: OrderFixture = {
      id: 'oiCompleted', price: 30, createdAt: new Date('2026-03-01'),
      order: { id: 'orderCompleted', status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-03-02'), paidAt: new Date('2026-03-01'), createdAt: new Date('2026-03-01') },
    }
    mockOrders([...cancelledHistory, completedOrder])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order?.orderId).toBe('orderCompleted')
    expect(record!.lifecycleStage).toBe('completed')
  })

  it('an active order remains discoverable beyond the arbitrary presentation-history limit (older than the most recent 20 attempts)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'reserved' }))
    // 25 cancelled attempts newer than the one active order — a naive "take 20 most
    // recent, then filter" approach would never see the active order at all.
    const cancelledHistory: OrderFixture[] = Array.from({ length: 25 }, (_, i) => ({
      id: `oiCancelled${i}`, price: 25, createdAt: new Date(2026, 2, i + 1),
      order: { id: `orderCancelled${i}`, status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date(2026, 2, i + 1) },
    }))
    const activeOrder: OrderFixture = {
      id: 'oiActive', price: 25, createdAt: new Date('2026-01-01'),
      order: { id: 'orderActive', status: 'pending', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-01-01') },
    }
    mockOrders([activeOrder, ...cancelledHistory])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.order?.orderId).toBe('orderActive')
    expect(record!.lifecycleStage).toBe('reserved')
  })

  it('a timeline presentation limit (fewer history rows fetched) does not affect the determined lifecycle state', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold', sourceType: 'company_owned' }))
    // The completed order is OLDER than a later cancelled attempt, so a timeline capped
    // to 1 row (most-recent-first) shows only the cancelled attempt — yet lifecycle
    // determination must still find and honor the completed sale.
    const completedOrder: OrderFixture = {
      id: 'oiCompleted', price: 30, createdAt: new Date('2026-01-01'),
      order: { id: 'orderCompleted', status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-01-02'), paidAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
    }
    const laterCancelled: OrderFixture = {
      id: 'oiCancelledLater', price: 30, createdAt: new Date('2026-03-01'),
      order: { id: 'orderCancelledLater', status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date('2026-03-01') },
    }
    mockOrders([completedOrder, laterCancelled], { timelineLimit: 1 })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.lifecycleStage).toBe('completed')
    expect(record!.order?.orderId).toBe('orderCompleted')
    expect(record!.timeline.some(t => t.title.includes('cancelled'))).toBe(true)
    expect(record!.timeline.some(t => t.title === 'Sale completed')).toBe(false)
  })

  it('reports additionalOrderHistoryCount when the total exceeds the bounded timeline slice, without affecting lifecycle state', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'available' }))
    const history: OrderFixture[] = Array.from({ length: 3 }, (_, i) => ({
      id: `oi${i}`, price: 25, createdAt: new Date(2026, 0, i + 1),
      order: { id: `order${i}`, status: 'cancelled', paymentStatus: 'unpaid', completedAt: null, paidAt: null, createdAt: new Date(2026, 0, i + 1) },
    }))
    mockOrders(history, { timelineLimit: 2 })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.additionalOrderHistoryCount).toBe(1)
    expect(record!.lifecycleStage).toBe('available')
  })
})

describe('getItemLifecycleRecord — multiple completed sales (15C-review section 3)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('flags "Needs attention" when more than one completed OrderItem exists for the same item, and does not hide it by silently picking one', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold', sourceType: 'company_owned' }))
    mockOrders([
      {
        id: 'oiFirst', price: 25, createdAt: new Date('2026-01-01'),
        order: { id: 'orderFirst', status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-01-02'), paidAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
      },
      {
        id: 'oiSecond', price: 30, createdAt: new Date('2026-02-01'),
        order: { id: 'orderSecond', status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-02-02'), paidAt: new Date('2026-02-01'), createdAt: new Date('2026-02-01') },
      },
    ])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.lifecycleStage).toBe('exception')
    expect(record!.contradictions.some(c => c.code === 'multiple_completed_sales')).toBe(true)
    // Still deterministically picks one (the earliest) for display rather than null/undefined.
    expect(record!.order?.orderId).toBe('orderFirst')
  })

  it('a single completed sale never triggers the multiple-sales contradiction', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold', sourceType: 'company_owned' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.contradictions.some(c => c.code === 'multiple_completed_sales')).toBe(false)
  })
})

describe('getItemLifecycleRecord — payment vs fulfillment semantics (section 3/4)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('a paid-but-not-yet-completed order yields stage "paid", never "fulfillment" or "completed"', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'reserved' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'pending', paymentStatus: 'paid', completedAt: null, paidAt: new Date(), createdAt: new Date() },
    }])
    const record = await getItemLifecycleRecord('item1')
    expect(record!.lifecycleStage).toBe('paid')
  })

  it('not_for_sale with no contradiction yields "inactive", never "completed"', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'not_for_sale', listing: null }))
    mockNoOrders()
    const record = await getItemLifecycleRecord('item1')
    expect(record!.lifecycleStage).toBe('inactive')
  })

  it('"completed" requires order complete AND (non-consignment OR settled consignment payout) — explicit end-to-end check', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold', sourceType: 'consignment' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    ;(prisma.sellerPayoutLine.findFirst as Mock).mockResolvedValueOnce({
      id: 'line1', orderItemId: 'oi1', status: 'eligible', grossSalePrice: D('25.00'), commissionAmount: D('5.00'), netAmount: D('20.00'),
      payoutId: 'payout1', createdAt: new Date(), payout: { id: 'payout1', status: 'paid', paidAt: new Date() },
    })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.lifecycleStage).toBe('completed')
  })

  it('"completed" does NOT fire while consignment payout is outstanding (spec worked example)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'sold', sourceType: 'consignment' }))
    mockOrders([{
      id: 'oi1', price: 25, createdAt: new Date(),
      order: { id: 'order1', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    ;(prisma.sellerPayoutLine.findFirst as Mock).mockResolvedValueOnce({
      id: 'line1', orderItemId: 'oi1', status: 'eligible', grossSalePrice: D('25.00'), commissionAmount: D('5.00'), netAmount: D('20.00'),
      payoutId: null, createdAt: new Date(), payout: null,
    })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.lifecycleStage).toBe('sold')
  })
})

describe('getItemLifecycleRecord — payout matching (15C-review section 4)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('matches SellerPayoutLine to the authoritative current OrderItem by orderItemId, not merely by item/seller', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ sourceType: 'consignment', status: 'sold' }))
    mockOrders([{
      id: 'oiCurrent', price: 25, createdAt: new Date(),
      order: { id: 'orderCurrent', status: 'complete', paymentStatus: 'paid', completedAt: new Date(), paidAt: new Date(), createdAt: new Date() },
    }])
    ;(prisma.sellerPayoutLine.findFirst as Mock).mockImplementationOnce((args: { where: { orderItemId: string } }) => {
      expect(args.where.orderItemId).toBe('oiCurrent')
      return Promise.resolve({
        id: 'line1', orderItemId: 'oiCurrent', status: 'eligible', grossSalePrice: D('25.00'), commissionAmount: D('5.00'), netAmount: D('20.00'),
        payoutId: null, createdAt: new Date(), payout: null,
      })
    })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.financial.sellerProceeds!.toFixed(2)).toBe('20.00')
  })

  it('no current order -> no payout lookup is even issued', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ status: 'available' }))
    mockNoOrders()
    await getItemLifecycleRecord('item1')
    expect(prisma.sellerPayoutLine.findFirst).not.toHaveBeenCalled()
  })
})

describe('getItemLifecycleRecord — pricing (14C, section 13)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('surfaces the 14C pricing intelligence result for the item\'s catalog model', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem())
    mockNoOrders()
    ;(getPricingIntelligence as Mock).mockResolvedValueOnce({ catalogModelId: 'cat1', isAskOnly: false, estimatedValueCents: 2000 })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.pricing.intelligence).toMatchObject({ isAskOnly: false, estimatedValueCents: 2000 })
    expect(getPricingIntelligence).toHaveBeenCalledWith('cat1')
  })

  it('ask-only semantics are preserved verbatim from the 14C engine, not overridden here', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem())
    mockNoOrders()
    ;(getPricingIntelligence as Mock).mockResolvedValueOnce({ catalogModelId: 'cat1', isAskOnly: true, estimatedValueCents: null })
    const record = await getItemLifecycleRecord('item1')
    expect(record!.pricing.intelligence!.isAskOnly).toBe(true)
  })

  it('calls getListingPriceComparison only when an active listing exists', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem())
    mockNoOrders()
    await getItemLifecycleRecord('item1')
    expect(getListingPriceComparison).not.toHaveBeenCalled()
  })

  it('this module never writes Listing.price or any pricing field (read-only, section 23)', () => {
    const src = readSrc('src/lib/itemLifecycleQuery.ts')
    expect(src).not.toMatch(/listing\.(update|create)\(/)
    expect(src).not.toMatch(/\.price\s*=/)
  })
})

describe('getItemLifecycleRecord — timeline (section 9)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('events are returned in deterministic chronological order', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      createdAt: new Date('2026-01-10'),
      listing: { id: 'list1', status: 'active', price: 25, version: 1, createdAt: new Date('2026-01-15'), updatedAt: new Date('2026-01-15') },
      intakeDraft: { id: 'draft1', sellerSubmissionId: 'sub1', createdAt: new Date('2026-01-05') },
      sellerAgreementId: 'agr1', sourceType: 'consignment', sellerPortfolioId: 'port1',
    }))
    ;(prisma.sellerAgreement.findUnique as Mock).mockResolvedValueOnce({
      id: 'agr1', status: 'accepted', submissionId: 'sub1', sellerProfileId: 'sp1', sellerPortfolioId: 'port1',
      proposedAt: new Date('2026-01-02'), acceptedAt: new Date('2026-01-03'),
    })
    mockNoOrders()
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ id: 'sub1', createdAt: new Date('2026-01-01'), profileId: 'prof1', sellerPortfolioId: 'port1' })
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({ id: 'port1', name: 'P' })
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ id: 'sp1', profile: { name: 'A', email: 'a@x.com' } })

    const record = await getItemLifecycleRecord('item1')
    const titles = record!.timeline.map(t => t.title)
    expect(titles).toEqual([
      'Seller submission created', 'Agreement proposed', 'Agreement accepted',
      'Intake started', 'Item created', 'Listing created',
    ])
    const times = record!.timeline.map(t => t.occurredAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('equal timestamps use a stable, deterministic tie-breaker (fixed type priority), not insertion order', async () => {
    const sameTime = new Date('2026-01-01T00:00:00Z')
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({
      createdAt: sameTime,
      intakeDraft: { id: 'draft1', sellerSubmissionId: 'sub1', createdAt: sameTime },
    }))
    mockNoOrders()
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ id: 'sub1', createdAt: sameTime, profileId: 'prof1', sellerPortfolioId: null })
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([])

    const record = await getItemLifecycleRecord('item1')
    // submission_created(0) < intake_started(5) < item_created(6) — fixed priority order despite identical timestamps
    expect(record!.timeline.map(t => t.title)).toEqual(['Seller submission created', 'Intake started', 'Item created'])
  })

  it('never fabricates a missing history event (no listing -> no "Listing created" entry)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce(baseItem({ listing: null }))
    mockNoOrders()
    const record = await getItemLifecycleRecord('item1')
    expect(record!.timeline.some(t => t.title === 'Listing created')).toBe(false)
  })

  it('does not duplicate equivalent events — this module never reads SellerLifecycleEvent for the item timeline', () => {
    const src = readSrc('src/lib/itemLifecycleQuery.ts')
    expect(src).not.toMatch(/sellerLifecycleEvent/)
  })
})

describe('searchItemsPage — search & performance (section 14/24)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('searches by item identifier, catalog model, portfolio, and storage — all pushed into the DB-side where clause', async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    await searchItemsPage({ q: 'B-14', status: '', condition: '', cardedOrLoose: '', sort: 'sku' }, null)
    const call = (prisma.itemInstance.findMany as Mock).mock.calls[0][0]
    expect(call.where.OR).toEqual(expect.arrayContaining([
      { location: { label: { contains: 'B-14', mode: 'insensitive' } } },
    ]))
  })

  it('keyset pagination: fetches pageSize+1 with a cursor, never OFFSET/skip-N pagination', async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    await searchItemsPage({ q: '', status: '', condition: '', cardedOrLoose: '', sort: 'newest' }, 'cursor1', 25)
    const call = (prisma.itemInstance.findMany as Mock).mock.calls[0][0]
    expect(call.take).toBe(26)
    expect(call.cursor).toEqual({ id: 'cursor1' })
    expect(call.skip).toBe(1)
  })

  it('no N+1: exactly one findMany call per page regardless of result count', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `i${i}`, sku: `CT-${i}`, status: 'available', condition: 'mint', listPrice: 10,
      catalog: { brand: 'A', name: 'B' }, location: null, listing: null, photos: [],
    }))
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce(rows)
    await searchItemsPage({ q: '', status: '', condition: '', cardedOrLoose: '', sort: 'sku' }, null)
    expect((prisma.itemInstance.findMany as Mock).mock.calls.length).toBe(1)
  })

  it('bounded: the select never loads the full ItemInstance row (e.g. no notes/purchasePrice in the list projection)', () => {
    const src = readSrc('src/lib/itemLifecycleQuery.ts')
    const fnStart = src.indexOf('export async function searchItemsPage')
    const fnSrc = src.slice(fnStart)
    expect(fnSrc).not.toMatch(/purchasePrice: true/)
    expect(fnSrc).not.toMatch(/notes: true/)
  })
})
