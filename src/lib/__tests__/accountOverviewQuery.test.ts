import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order: { count: vi.fn(), findMany: vi.fn() },
    collectionItem: { count: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
    wantedCatalogModel: { count: vi.fn() },
    sellerPayoutLine: { aggregate: vi.fn() },
  },
}))
vi.mock('@/lib/buyerAlertsQuery', () => ({ getUnreadAlertCount: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getUnreadAlertCount } from '@/lib/buyerAlertsQuery'
import { outstandingPayoutLineWhere } from '@/lib/businessAnalyticsQuery'
import { getAccountOverview } from '@/lib/accountOverviewQuery'

beforeEach(() => vi.resetAllMocks())

function baseMocks() {
  ;(prisma.order.count as Mock).mockResolvedValue(0)
  ;(prisma.order.findMany as Mock).mockResolvedValue([])
  ;(prisma.collectionItem.count as Mock).mockResolvedValue(0)
  ;(prisma.collectionItem.groupBy as Mock).mockResolvedValue([])
  ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: null } })
  ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(0)
  ;(getUnreadAlertCount as Mock).mockResolvedValue(0)
  ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValue({ _sum: { netAmount: null } })
}

const querySrc = fs.readFileSync(path.join(__dirname, '../accountOverviewQuery.ts'), 'utf-8')
const queryCode = querySrc.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')

describe('getAccountOverview — orders summary (Part E/10-11)', () => {
  it('active count excludes complete/cancelled — reuses the same terminal-status semantics as account/orders/page.tsx', async () => {
    baseMocks()
    await getAccountOverview('profile1')
    const call = (prisma.order.count as Mock).mock.calls[0][0]
    expect(call.where.customerProfileId).toBe('profile1')
    expect(call.where.status.notIn).toEqual(['complete', 'cancelled'])
  })

  it('recent preview is bounded to 3, ordered newest first', async () => {
    baseMocks()
    await getAccountOverview('profile1')
    const call = (prisma.order.findMany as Mock).mock.calls[0][0]
    expect(call.take).toBe(3)
    expect(call.orderBy).toEqual({ createdAt: 'desc' })
    expect(call.where.customerProfileId).toBe('profile1')
  })

  it('recent orders carry no buyer PII field in their select', async () => {
    baseMocks()
    await getAccountOverview('profile1')
    const call = (prisma.order.findMany as Mock).mock.calls[0][0]
    const selectKeys = Object.keys(call.select)
    for (const k of selectKeys) expect(k.toLowerCase()).not.toMatch(/email|phone|address|payment/)
  })

  it('identity is scoped exclusively by the profileId parameter passed in (server session), never derived elsewhere', async () => {
    baseMocks()
    await getAccountOverview('the-session-profile-id')
    expect((prisma.order.count as Mock).mock.calls[0][0].where.customerProfileId).toBe('the-session-profile-id')
  })

  it('recent-order preview stays bounded (take: 3) while the active-order total remains an exact, independent count query', async () => {
    baseMocks()
    ;(prisma.order.count as Mock).mockResolvedValue(57)
    ;(prisma.order.findMany as Mock).mockResolvedValue([
      { id: 'o1', createdAt: new Date(), status: 'processing', orderItems: [{ price: 10 }] },
    ])
    const result = await getAccountOverview('profile1')
    const findManyCall = (prisma.order.findMany as Mock).mock.calls[0][0]
    expect(findManyCall.take).toBe(3)
    expect(result.orders.activeCount).toBe(57)
    expect(result.orders.recent.length).toBe(1)
  })
})

describe('getAccountOverview — collection summary (16E Final Quantity Semantics Pass)', () => {
  it('itemCount is SUM(quantity) via a DB-side aggregate, scoped to the profile — never collectionItem.count() (row count)', async () => {
    baseMocks()
    ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: 47 } })
    const result = await getAccountOverview('profile1')
    expect(result.collection.itemCount).toBe(47)
    const call = (prisma.collectionItem.aggregate as Mock).mock.calls[0][0]
    expect(call.where.profileId).toBe('profile1')
    expect(call._sum).toEqual({ quantity: true })
  })

  it('a single row with quantity=5 contributes 5 to itemCount, not 1 — proves row count is never substituted for the physical total', async () => {
    baseMocks()
    ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: 5 } })
    ;(prisma.collectionItem.count as Mock).mockResolvedValue(0) // freeformCount — 1 catalog-linked row, 0 freeform
    ;(prisma.collectionItem.groupBy as Mock).mockResolvedValue([{ catalogId: 'cat1' }])
    const result = await getAccountOverview('profile1')
    expect(result.collection.itemCount).toBe(5)
    expect(result.collection.entryCount).toBe(1)
  })

  it('a null aggregate sum (empty collection) becomes exactly zero, not a crash', async () => {
    baseMocks()
    const result = await getAccountOverview('profile1')
    expect(result.collection.itemCount).toBe(0)
  })

  it('entryCount = distinct non-null catalogIds + freeform (catalogId=null) row count — freeform rows are never collapsed into one group', async () => {
    baseMocks()
    ;(prisma.collectionItem.groupBy as Mock).mockResolvedValue([{ catalogId: 'cat1' }, { catalogId: 'cat2' }])
    ;(prisma.collectionItem.count as Mock).mockResolvedValue(3) // 3 distinct freeform rows
    const result = await getAccountOverview('profile1')
    expect(result.collection.entryCount).toBe(5) // 2 catalog models + 3 freeform entries
    const groupByCall = (prisma.collectionItem.groupBy as Mock).mock.calls[0][0]
    expect(groupByCall.by).toEqual(['catalogId'])
    expect(groupByCall.where.catalogId).toEqual({ not: null })
    const countCall = (prisma.collectionItem.count as Mock).mock.calls[0][0]
    expect(countCall.where.catalogId).toBeNull()
    expect(countCall.where.profileId).toBe('profile1')
  })

  it('collection summary never issues a findMany (no full CollectionItem row hydration)', async () => {
    baseMocks()
    await getAccountOverview('profile1')
    expect(querySrc).not.toMatch(/collectionItem\.findMany/)
  })

  it('two rows (qty=3 Porsche, qty=2 Ferrari) yield 5 items · 2 entries — matches the milestone worked example exactly', async () => {
    baseMocks()
    ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: 5 } })
    ;(prisma.collectionItem.groupBy as Mock).mockResolvedValue([{ catalogId: 'porsche' }, { catalogId: 'ferrari' }])
    ;(prisma.collectionItem.count as Mock).mockResolvedValue(0)
    const result = await getAccountOverview('profile1')
    expect(result.collection.itemCount).toBe(5)
    expect(result.collection.entryCount).toBe(2)
  })

  it('the SUM(quantity) aggregate is scoped by profileId only — cannot be inflated by another customer\'s rows', async () => {
    baseMocks()
    ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: 5 } })
    await getAccountOverview('profile-a')
    const callA = (prisma.collectionItem.aggregate as Mock).mock.calls[0][0]
    vi.resetAllMocks()
    baseMocks()
    ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: 9 } })
    await getAccountOverview('profile-b')
    const callB = (prisma.collectionItem.aggregate as Mock).mock.calls[0][0]
    expect(callA.where.profileId).toBe('profile-a')
    expect(callB.where.profileId).toBe('profile-b')
  })
})

describe('getAccountOverview — wanted & alerts summary (16B Final Lightweight-Overview Pass)', () => {
  it('wantedCount is an exact DB-side count, scoped to the profile — no findMany row load, no matching scan', async () => {
    baseMocks()
    ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(8)
    const result = await getAccountOverview('profile1')
    expect(result.wanted.wantedCount).toBe(8)
    expect((prisma.wantedCatalogModel.count as Mock).mock.calls[0][0].where.customerProfileId).toBe('profile1')
  })

  it('the result has no availableMatchCount field — the metric is omitted, not computed as zero', async () => {
    baseMocks()
    const result = await getAccountOverview('profile1')
    expect(result.wanted).not.toHaveProperty('availableMatchCount')
  })

  it('unreadAlertCount reuses the exact existing getUnreadAlertCount helper', async () => {
    baseMocks()
    ;(getUnreadAlertCount as Mock).mockResolvedValue(5)
    const result = await getAccountOverview('profile1')
    expect(getUnreadAlertCount).toHaveBeenCalledWith('profile1')
    expect(result.wanted.unreadAlertCount).toBe(5)
  })
})

describe('getAccountOverview — no full Wanted candidate matching scan (16B Final Lightweight-Overview Pass)', () => {
  it('getAccountOverview never imports or calls matchWantedList', () => {
    expect(queryCode).not.toMatch(/matchWantedList/)
  })

  it('a large wanted list does not trigger any extra query beyond the single count — no per-candidate work', async () => {
    baseMocks()
    ;(prisma.wantedCatalogModel.count as Mock).mockResolvedValue(250)
    await getAccountOverview('profile1')
    expect(prisma.wantedCatalogModel.count).toHaveBeenCalledTimes(1)
  })
})

describe('getAccountOverview — selling summary (16B Final Lightweight-Overview Pass)', () => {
  it('the result has no activePortfolioCount field — the metric is omitted, not computed as zero', async () => {
    baseMocks()
    const result = await getAccountOverview('profile1')
    expect(result.selling).not.toHaveProperty('activePortfolioCount')
  })

  it('getAccountOverview never imports or calls listMySellerPortfolios/countActiveSellerPortfolios (no SellerPortfolio hydration)', () => {
    expect(queryCode).not.toMatch(/listMySellerPortfolios|countActiveSellerPortfolios|derivePortfolioStage/)
  })

  it('outstanding payout uses outstandingPayoutLineWhere — the ONE shared authoritative predicate also used by the admin outstanding-liability definition, scoped to this one customer', async () => {
    baseMocks()
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValue({ _sum: { netAmount: new Prisma.Decimal('123.45') } })
    const result = await getAccountOverview('profile1')
    const call = (prisma.sellerPayoutLine.aggregate as Mock).mock.calls[0][0]
    expect(call.where).toEqual(outstandingPayoutLineWhere('profile1'))
    expect(result.selling.outstandingPayoutCents).toBe(12345)
  })

  it('customer liability is scoped to the authenticated profile only — customerProfileId is present and matches the caller', async () => {
    baseMocks()
    await getAccountOverview('profile1')
    const call = (prisma.sellerPayoutLine.aggregate as Mock).mock.calls[0][0]
    expect(call.where.customerProfileId).toBe('profile1')
  })

  it('another profile cannot leak into this profile\'s liability — different profileIds produce non-overlapping where-shapes', async () => {
    baseMocks()
    await getAccountOverview('profile1')
    const callA = (prisma.sellerPayoutLine.aggregate as Mock).mock.calls[0][0]
    vi.resetAllMocks()
    baseMocks()
    await getAccountOverview('profile2')
    const callB = (prisma.sellerPayoutLine.aggregate as Mock).mock.calls[0][0]
    expect(callA.where.customerProfileId).toBe('profile1')
    expect(callB.where.customerProfileId).toBe('profile2')
    expect(callA.where).not.toEqual(callB.where)
  })

  it('the admin-global predicate (no customerProfileId) and the customer-scoped predicate share every other field verbatim', () => {
    const admin = outstandingPayoutLineWhere()
    const customer = outstandingPayoutLineWhere('profile1')
    expect(admin.customerProfileId).toBeUndefined()
    expect(customer.customerProfileId).toBe('profile1')
    expect(customer.status).toEqual(admin.status)
    expect(customer.OR).toEqual(admin.OR)
  })

  it('a null aggregate sum (no outstanding lines) becomes exactly zero, not a crash', async () => {
    baseMocks()
    const result = await getAccountOverview('profile1')
    expect(result.selling.outstandingPayoutCents).toBe(0)
  })
})

describe('getAccountOverview — performance (Part M/26, Part Z/45)', () => {
  it('issues exactly one call to each independent summary source — no repeated/duplicate reads', async () => {
    baseMocks()
    await getAccountOverview('profile1')
    expect(prisma.order.count).toHaveBeenCalledTimes(1)
    expect(prisma.order.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.collectionItem.aggregate).toHaveBeenCalledTimes(1)
    expect(prisma.collectionItem.groupBy).toHaveBeenCalledTimes(1)
    expect(prisma.collectionItem.count).toHaveBeenCalledTimes(1)
    expect(prisma.wantedCatalogModel.count).toHaveBeenCalledTimes(1)
    expect(prisma.sellerPayoutLine.aggregate).toHaveBeenCalledTimes(1)
  })

  it('the whole overview issues no query beyond count/groupBy/aggregate/bounded-findMany — no unbounded findMany anywhere', () => {
    const findManyMatches = [...querySrc.matchAll(/\.findMany\(/g)]
    expect(findManyMatches.length).toBe(1) // order.findMany, the take:3 preview only
  })
})
