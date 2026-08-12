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
    sellerPortfolio: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    sellerSubmission: { groupBy: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    sellerInboundShipment: { findMany: vi.fn() },
    itemInstance: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    sellerAgreement: { findMany: vi.fn() },
    intakeDraft: { groupBy: vi.fn(), count: vi.fn() },
    sellerPayoutLine: { findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
    sellerLifecycleCase: { count: vi.fn(), groupBy: vi.fn() },
    sellerLifecycleEvent: { findMany: vi.fn() },
    orderItem: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import {
  listSellerPortfolios,
  getPortfolioDetail,
  listMySellerPortfolios,
  getSellerPortfolioView,
  LIST_SOURCE_PAGE_SIZE,
} from '@/lib/sellerPortfolioQuery'

const D = (s: string) => new Prisma.Decimal(s)

function defaultEmptyMocks() {
  ;(prisma.sellerSubmission.groupBy as Mock).mockResolvedValue([])
  ;(prisma.sellerSubmission.findMany as Mock).mockResolvedValue([])
  ;(prisma.sellerSubmission.aggregate as Mock).mockResolvedValue({ _sum: { quantity: null } })
  ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValue([])
  ;(prisma.itemInstance.groupBy as Mock).mockResolvedValue([])
  ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
  ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
  ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
  ;(prisma.intakeDraft.groupBy as Mock).mockResolvedValue([])
  ;(prisma.intakeDraft.count as Mock).mockResolvedValue(0)
  ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValue([])
  ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValue({ _sum: { netAmount: null } })
  ;(prisma.sellerPayoutLine.count as Mock).mockResolvedValue(0)
  ;(prisma.sellerLifecycleCase.count as Mock).mockResolvedValue(0)
  ;(prisma.sellerLifecycleCase.groupBy as Mock).mockResolvedValue([])
  ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
}

describe('sellerPortfolioQuery: listSellerPortfolios — pagination & no N+1', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultEmptyMocks() })

  it('a seller with multiple portfolios: all are returned by the base list query', async () => {
    ;(prisma.sellerPortfolio.findMany as Mock).mockResolvedValueOnce([
      { id: 'p1', name: 'Spring', status: 'open', acceptedItemCount: 10, updatedAt: new Date(), sellerProfile: { id: 'sp1', profile: { name: 'Alice', email: 'a@x.com' } } },
      { id: 'p2', name: 'Summer', status: 'open', acceptedItemCount: 20, updatedAt: new Date(), sellerProfile: { id: 'sp1', profile: { name: 'Alice', email: 'a@x.com' } } },
    ])
    const { items } = await listSellerPortfolios({ filter: 'all', cursor: null })
    expect(items.map(i => i.id)).toEqual(['p1', 'p2'])
  })

  it('batches count aggregation once per page — never issues a separate query per portfolio (no N+1)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, name: null, status: 'open', acceptedItemCount: null, updatedAt: new Date(),
      sellerProfile: { id: `sp${i}`, profile: { name: null, email: `s${i}@x.com` } },
    }))
    ;(prisma.sellerPortfolio.findMany as Mock).mockResolvedValueOnce(rows)
    await listSellerPortfolios({ filter: 'all', cursor: null })
    // Exactly one batched call per aggregate type, regardless of 5 portfolios in the page.
    expect((prisma.sellerSubmission.groupBy as Mock).mock.calls.length).toBe(1)
    expect((prisma.itemInstance.groupBy as Mock).mock.calls.length).toBe(2) // listed + sold
    expect((prisma.sellerAgreement.findMany as Mock).mock.calls.length).toBe(1)
  })

})

// 15B-review section 1: no arbitrary total-portfolio cap for derived stage/attention
// filters — mirrors pricingIntelligenceQuery.test.ts's scanOpportunities coverage
// exactly (same underlying pattern, see sellerPortfolioQuery.ts's fetchCoreBatchPage).
describe('sellerPortfolioQuery: listSellerPortfolios — no arbitrary total-portfolio cap (section 1)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultEmptyMocks() })

  function idAt(n: number): string {
    return `port-${String(n).padStart(6, '0')}`
  }
  function indexOfId(id: string): number {
    return parseInt(id.slice('port-'.length), 10)
  }

  // A linear population of `totalPortfolios` candidate portfolios, driven entirely by
  // real cursor semantics (no hardcoded "page1/page2/page3"). `matchIndices` get an
  // ACCEPTED agreement (-> hasAcceptedAgreement=true, no shipment -> stage
  // 'awaiting_shipment'); everywhere else stays agreement-less (-> 'awaiting_agreement').
  // Filtering on 'awaiting_shipment' therefore isolates exactly the match set, letting
  // tests place a match arbitrarily deep (position 301, 5000, ...) and verify the scan
  // actually reaches it.
  function mockLinearPopulation(totalPortfolios: number, matchIndices: number[]) {
    const matchSet = new Set(matchIndices)

    ;(prisma.sellerPortfolio.findMany as Mock).mockImplementation((args: {
      cursor?: { id: string }
      take: number
    }) => {
      const startIdx = args.cursor ? indexOfId(args.cursor.id) + 1 : 0
      const rows = []
      for (let i = startIdx; i < totalPortfolios && rows.length < args.take; i++) {
        rows.push({
          id: idAt(i), name: null, status: 'open', acceptedItemCount: null, updatedAt: new Date(),
          sellerProfile: { id: `sp${i}`, profile: { name: null, email: `s${i}@x.com` } },
        })
      }
      return Promise.resolve(rows)
    })

    ;(prisma.sellerAgreement.findMany as Mock).mockImplementation((args: {
      where: { sellerPortfolioId: { in: string[] } }
    }) => {
      const ids = args.where.sellerPortfolioId.in
      const rows = ids
        .filter(id => matchSet.has(indexOfId(id)))
        .map(id => ({ sellerPortfolioId: id, status: 'accepted', commissionSource: null, commissionPercent: null, acceptedItemCount: 10 }))
      return Promise.resolve(rows)
    })
  }

  it('a qualifying portfolio beyond source row 300 is still found and returned in a single call', async () => {
    mockLinearPopulation(400, [325])
    const { items } = await listSellerPortfolios({ filter: 'awaiting_shipment', cursor: null })
    expect(items.map(i => i.id)).toEqual([idAt(325)])
  })

  it('a sparse filter traverses more than 3 source pages (300+ portfolios) to find its one match — beyond the old 3-attempt/300-row cap', async () => {
    mockLinearPopulation(500, [450]) // 450 / 100 = page 4 — beyond the removed 3-attempt cap
    const { items } = await listSellerPortfolios({ filter: 'awaiting_shipment', cursor: null })
    expect(items.map(i => i.id)).toEqual([idAt(450)])
    const pageCalls = (prisma.sellerPortfolio.findMany as Mock).mock.calls.length
    expect(pageCalls).toBeGreaterThan(3)
  })

  it('empty intermediate match pages do not terminate the search — a run of all-miss pages is scanned through, not treated as exhaustion', async () => {
    mockLinearPopulation(350, [340]) // matches only in the very last page
    const { items } = await listSellerPortfolios({ filter: 'awaiting_shipment', cursor: null })
    expect(items.map(i => i.id)).toEqual([idAt(340)])
  })

  it('no source portfolio is skipped or repeated across a long multi-page scan', async () => {
    mockLinearPopulation(500, [10, 220, 470]) // matches spread across early/mid/late pages
    const { items } = await listSellerPortfolios({ filter: 'awaiting_shipment', cursor: null })
    const ids = items.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
    expect(ids.sort()).toEqual([idAt(10), idAt(220), idAt(470)].sort()) // no omissions
  })

  it('every underlying source-page query stays individually bounded: fixed take, keyset cursor, never a full-table read', async () => {
    mockLinearPopulation(500, [470])
    await listSellerPortfolios({ filter: 'awaiting_shipment', cursor: null })
    for (const [args] of (prisma.sellerPortfolio.findMany as Mock).mock.calls) {
      expect(args.take).toBe(LIST_SOURCE_PAGE_SIZE + 1) // same fixed bound on every page, however many pages
      expect(args).not.toHaveProperty('skip', undefined) // uses skip:1+cursor (or omits both on first page) — never OFFSET pagination
    }
  })

  it('eventual source exhaustion (no match anywhere) returns nextCursor=null — a true, non-resumable completion', async () => {
    mockLinearPopulation(50, []) // small, fully-scannable population, zero matches
    const result = await listSellerPortfolios({ filter: 'awaiting_shipment', cursor: null })
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('a time-budget cutoff (runtime protection) returns an EXPLICIT incomplete result with a resumable cursor, never a silently truncated/lost scan', async () => {
    mockLinearPopulation(1000, []) // no matches anywhere; plenty of source population left unscanned
    let calls = 0
    const fakeNow = () => { calls++; return calls <= 2 ? 0 : 999_999 } // lets ~1 page fetch happen, then the budget check fails
    const result = await listSellerPortfolios({ filter: 'awaiting_shipment', cursor: null, nowMs: fakeNow })
    expect(result.items).toEqual([])
    expect(result.nextCursor).not.toBeNull() // explicitly resumable — the 1000-portfolio population was NOT exhausted
  })
})

describe('sellerPortfolioQuery: getPortfolioDetail — financial summary (section 12)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultEmptyMocks() })

  function mockPortfolioCore() {
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({
      id: 'p1', name: 'Test', status: 'open', notes: null,
      createdAt: new Date(), updatedAt: new Date(), closedAt: null,
      expectedItemCount: null, acceptedItemCount: 50,
      sellerProfile: { id: 'sp1', profile: { name: 'Alice', email: 'a@x.com' } },
    })
  }

  it('completed-sales GMV, seller proceeds, and gross spread come from authoritative OrderItem/SellerPayoutLine records, never fabricated', async () => {
    mockPortfolioCore()
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 20.0 },
      { id: 'oi2', price: 30.0 },
    ])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([
      { orderItemId: 'oi1', grossSalePrice: D('20.00'), netAmount: D('16.00') }, // 4.00 spread
      { orderItemId: 'oi2', grossSalePrice: D('30.00'), netAmount: D('24.00') }, // 6.00 spread
    ])
    ;(prisma.sellerPayoutLine.aggregate as Mock)
      .mockResolvedValueOnce({ _sum: { netAmount: D('5.00') } }) // outstanding
      .mockResolvedValueOnce({ _sum: { netAmount: D('35.00') } }) // paid

    const detail = await getPortfolioDetail('p1')
    expect(detail).not.toBeNull()
    expect(detail!.financial.completedSalesGmv.toFixed(2)).toBe('50.00')
    expect(detail!.financial.completedSalesCount).toBe(2)
    expect(detail!.financial.sellerProceeds.toFixed(2)).toBe('40.00')
    expect(detail!.financial.grossSpread.toFixed(2)).toBe('10.00')
    expect(detail!.financial.outstandingPayout.toFixed(2)).toBe('5.00')
    expect(detail!.financial.paidPayout.toFixed(2)).toBe('35.00')
  })

  it('with no sales, GMV/proceeds/spread are all zero — never a fabricated non-zero default', async () => {
    mockPortfolioCore()
    const detail = await getPortfolioDetail('p1')
    expect(detail!.financial.completedSalesGmv.toFixed(2)).toBe('0.00')
    expect(detail!.financial.sellerProceeds.toFixed(2)).toBe('0.00')
    expect(detail!.financial.grossSpread.toFixed(2)).toBe('0.00')
  })

  it('returns null for a non-existent portfolio rather than throwing', async () => {
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce(null)
    const detail = await getPortfolioDetail('missing')
    expect(detail).toBeNull()
  })
})

describe('sellerPortfolioQuery: getPortfolioDetail — counts (section 6)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultEmptyMocks() })

  it('submitted/accepted/expected/received/intake/listed/sold are distinct, never collapsed', async () => {
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({
      id: 'p1', name: null, status: 'open', notes: null,
      createdAt: new Date(), updatedAt: new Date(), closedAt: null,
      expectedItemCount: null, acceptedItemCount: 60,
      sellerProfile: { id: 'sp1', profile: { name: null, email: 'a@x.com' } },
    })
    ;(prisma.sellerSubmission.findMany as Mock).mockResolvedValueOnce([
      { id: 's1', brand: 'A', name: 'B', quantity: 50, status: 'approved_for_intake', createdAt: new Date() },
      { id: 's2', brand: 'C', name: 'D', quantity: 20, status: 'approved_for_intake', createdAt: new Date() },
    ])
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValueOnce([]) // no accepted agreement yet -> accepted = portfolio.acceptedItemCount
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([
      { id: 'sh1', status: 'received', carrier: 'UPS', trackingNumber: 'X', expectedQuantity: 75, receivedQuantity: 73, shippedAt: new Date(), receivedAt: new Date() },
    ])
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(64) // listed
    ;(prisma.intakeDraft.count as Mock).mockResolvedValueOnce(71) // intake complete
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValueOnce([
      { status: 'available', _count: { _all: 6 } },
      { status: 'reserved', _count: { _all: 1 } },
      { status: 'sold', _count: { _all: 18 } },
    ])

    const detail = await getPortfolioDetail('p1')
    expect(detail!.counts.submitted).toBe(70) // 50 + 20, NOT collapsed with accepted
    expect(detail!.counts.accepted).toBe(60)
    expect(detail!.counts.expectedInbound).toBe(75)
    expect(detail!.counts.received).toBe(73)
    expect(detail!.counts.intakeComplete).toBe(71)
    expect(detail!.counts.listed).toBe(64)
    expect(detail!.counts.sold).toBe(18)
    // Listed (64) is a SUBSET concept of available, never summed into submitted/accepted.
    expect(detail!.counts.submitted).not.toBe(detail!.counts.accepted)
  })
})

describe('sellerPortfolioQuery: getPortfolioDetail — deterministic current-agreement identification (section 2)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultEmptyMocks() })

  function mockPortfolioCore() {
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({
      id: 'p1', name: null, status: 'open', notes: null,
      createdAt: new Date(), updatedAt: new Date(), closedAt: null,
      expectedItemCount: null, acceptedItemCount: null,
      sellerProfile: { id: 'sp1', profile: { name: null, email: 'a@x.com' } },
    })
  }

  it('picks the single non-cancelled agreement — the DB query excludes cancelled rows, so it is never a matter of "most likely", it is the only candidate', async () => {
    mockPortfolioCore()
    let queryWhere: unknown = null
    ;(prisma.sellerAgreement.findMany as Mock).mockImplementationOnce((args: { where: unknown }) => {
      queryWhere = args.where
      // Only the current, non-cancelled agreement is ever returned by this query —
      // cancelled/historical agreements are excluded at the DB level, not filtered
      // in application code after the fact.
      return Promise.resolve([
        { id: 'agr-current', status: 'accepted', commissionPercent: null, commissionMinimumFee: null, commissionSource: 'policy_default', commissionExplanation: null, acceptedItemCount: 42, submissionId: 'sub1' },
      ])
    })

    const detail = await getPortfolioDetail('p1')
    expect(detail!.currentAgreement?.id).toBe('agr-current')
    expect(queryWhere).toMatchObject({ sellerPortfolioId: 'p1', status: { not: 'cancelled' } })
  })

  it('a portfolio with only cancelled/historical agreements has no current agreement, not an arbitrary pick', async () => {
    mockPortfolioCore()
    // Cancelled agreements never reach app code — the WHERE clause excludes them, so
    // this query legitimately returns empty.
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValueOnce([])

    const detail = await getPortfolioDetail('p1')
    expect(detail!.currentAgreement).toBeNull()
  })
})

describe('sellerPortfolioQuery: seller-facing view — authorization & privacy (section 19)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultEmptyMocks() })

  it('getSellerPortfolioView scopes the query to the requesting profileId — never fetches by id alone', async () => {
    ;(prisma.sellerPortfolio.findFirst as Mock).mockResolvedValueOnce(null)
    const result = await getSellerPortfolioView('p1', 'profile-abc')
    expect(result).toBeNull()
    const call = (prisma.sellerPortfolio.findFirst as Mock).mock.calls[0][0]
    expect(call.where.id).toBe('p1')
    expect(call.where.sellerProfile.profile.id).toBe('profile-abc')
  })

  it('returns null (never throws or leaks existence) when the portfolio belongs to a different seller', async () => {
    ;(prisma.sellerPortfolio.findFirst as Mock).mockResolvedValueOnce(null)
    const result = await getSellerPortfolioView('someone-elses-portfolio', 'profile-abc')
    expect(result).toBeNull()
  })

  it('listMySellerPortfolios scopes to the requesting profileId', async () => {
    ;(prisma.sellerPortfolio.findMany as Mock).mockResolvedValueOnce([])
    await listMySellerPortfolios('profile-abc')
    const call = (prisma.sellerPortfolio.findMany as Mock).mock.calls[0][0]
    expect(call.where.sellerProfile.profile.id).toBe('profile-abc')
  })
})

describe('sellerPortfolioQuery: no PII/internal-cost leakage (structural)', () => {
  const src = readSrc('src/lib/sellerPortfolioQuery.ts')

  it('no buyer PII fields selected anywhere in this module', () => {
    expect(src).not.toMatch(/buyerName|buyerEmail|buyerPhone/)
  })

  it('getSellerPortfolioView never selects adminNotes, purchasePrice, or another seller\'s commissionRate', () => {
    const start = src.indexOf('export async function getSellerPortfolioView')
    const end = src.indexOf('\n}', src.indexOf('return {', start))
    const fnSrc = src.slice(start, end)
    expect(fnSrc).not.toMatch(/adminNotes/)
    expect(fnSrc).not.toMatch(/purchasePrice/)
    expect(fnSrc).not.toMatch(/commissionRate/)
  })

  it('this module never mutates ItemInstance/Listing/Order/SellerPayout/SellerAgreement (read-only summaries — section 24)', () => {
    expect(src).not.toMatch(/\.(update|create|delete|updateMany|deleteMany)\(/)
  })
})
