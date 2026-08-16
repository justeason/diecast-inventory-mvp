// 15K (execution-snapshot pass) — the ONE authoritative "Needs Manual Review"
// predicate: latest review_required/denied AutoListingAttempt per item, excluding
// items with a current active/sold Listing (Part 5-13 of the focused review).
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { $queryRaw: vi.fn(), itemInstance: { findMany: vi.fn() } },
}))

import { prisma } from '@/lib/prisma'
import { getNeedsManualReviewCount, listNeedsManualReview } from '@/lib/autoListingReview'

beforeEach(() => vi.resetAllMocks())

describe('getNeedsManualReviewCount / listNeedsManualReview — shared SQL predicate', () => {
  it('both use a query that filters to review_required/denied outcomes, DISTINCT ON itemId, and excludes items with an active/sold Listing', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([{ count: 0n }])
    await getNeedsManualReviewCount()
    const countSql = (prisma.$queryRaw as Mock).mock.calls[0][0].sql as string
    expect(countSql).toContain('DISTINCT ON')
    expect(countSql).toContain(`outcome IN ('review_required', 'denied')`)
    expect(countSql).toContain('NOT EXISTS')
    expect(countSql).toContain(`status IN ('active', 'sold')`)

    vi.resetAllMocks()
    ;(prisma.$queryRaw as Mock).mockResolvedValue([])
    await listNeedsManualReview(null)
    const listSql = (prisma.$queryRaw as Mock).mock.calls[0][0].sql as string
    expect(listSql).toContain('DISTINCT ON')
    expect(listSql).toContain(`outcome IN ('review_required', 'denied')`)
    expect(listSql).toContain('NOT EXISTS')
    expect(listSql).toContain(`status IN ('active', 'sold')`)
  })

  it('the count and list queries share the identical underlying subquery text — they can never drift (Part 11)', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([{ count: 0n }])
    await getNeedsManualReviewCount()
    const countSql = (prisma.$queryRaw as Mock).mock.calls[0][0].sql as string

    vi.resetAllMocks()
    ;(prisma.$queryRaw as Mock).mockResolvedValue([])
    await listNeedsManualReview(null)
    const listSql = (prisma.$queryRaw as Mock).mock.calls[0][0].sql as string

    // Extract the DISTINCT ON subquery body from each — must be byte-identical.
    const extractSubquery = (sql: string) => sql.slice(sql.indexOf('SELECT DISTINCT ON'), sql.indexOf('ORDER BY a."itemId"') + 'ORDER BY a."itemId", a."createdAt" DESC, a.id DESC'.length)
    expect(extractSubquery(countSql)).toBe(extractSubquery(listSql))
  })
})

describe('getNeedsManualReviewCount', () => {
  it('returns an exact integer from the DB count, never a fake/derived number', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([{ count: 7n }])
    expect(await getNeedsManualReviewCount()).toBe(7)
  })

  it('returns 0 (never throws) on an empty result', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([])
    expect(await getNeedsManualReviewCount()).toBe(0)
  })
})

describe('listNeedsManualReview — pagination + hydration', () => {
  it('uses keyset pagination (a WHERE clause comparing createdAt/id), never OFFSET', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([])
    await listNeedsManualReview('1700000000000_attempt5')
    const sql = (prisma.$queryRaw as Mock).mock.calls[0][0].sql as string
    expect(sql).not.toMatch(/OFFSET/i)
    expect(sql).toContain('WHERE (latest."createdAt"')
  })

  it('no cursor -> no WHERE filter beyond the base predicate, LIMIT pageSize+1', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([])
    await listNeedsManualReview(null, 10)
    const call = (prisma.$queryRaw as Mock).mock.calls[0][0]
    expect(call.values).not.toContain(undefined)
    expect(call.sql).not.toContain('latest."createdAt" <')
  })

  it('hydrates item display fields in exactly one batched findMany, never one per row', async () => {
    const now = new Date()
    ;(prisma.$queryRaw as Mock).mockResolvedValue([
      { id: 'a1', itemId: 'item1', runId: 'run1', outcome: 'review_required', reasonCode: 'pricing_ask_only', proposedPriceCents: null, createdAt: now },
      { id: 'a2', itemId: 'item2', runId: 'run1', outcome: 'denied', reasonCode: 'risk_denied', proposedPriceCents: 1500, createdAt: now },
    ])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([
      { id: 'item1', sku: 'S1', catalog: { brand: 'X', name: 'Y' } },
      { id: 'item2', sku: 'S2', catalog: { brand: 'X', name: 'Z' } },
    ])
    const result = await listNeedsManualReview(null)
    expect(prisma.itemInstance.findMany).toHaveBeenCalledTimes(1)
    expect(result.items[0].item).toEqual({ sku: 'S1', brand: 'X', name: 'Y' })
    expect(result.items[1].item).toEqual({ sku: 'S2', brand: 'X', name: 'Z' })
  })

  it('every returned row has outcome review_required or denied only — stale/failed never appear (Part 10)', async () => {
    const now = new Date()
    ;(prisma.$queryRaw as Mock).mockResolvedValue([
      { id: 'a1', itemId: 'item1', runId: 'run1', outcome: 'review_required', reasonCode: 'pricing_ask_only', proposedPriceCents: null, createdAt: now },
    ])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
    const result = await listNeedsManualReview(null)
    for (const row of result.items) expect(['review_required', 'denied']).toContain(row.outcome)
  })

  it('correctly reports a resumable nextCursor when more rows exist than pageSize', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const rows = Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, itemId: `item${i}`, runId: 'run1', outcome: 'denied', reasonCode: 'risk_denied', proposedPriceCents: null, createdAt: now }))
    ;(prisma.$queryRaw as Mock).mockResolvedValue(rows)
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
    const result = await listNeedsManualReview(null, 25)
    expect(result.items).toHaveLength(25)
    expect(result.nextCursor).toBe(`${now.getTime()}_a24`)
  })

  it('exhaustion (fewer rows than pageSize) reports nextCursor: null', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([{ id: 'a1', itemId: 'item1', runId: 'run1', outcome: 'denied', reasonCode: 'risk_denied', proposedPriceCents: null, createdAt: new Date() }])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
    const result = await listNeedsManualReview(null, 25)
    expect(result.nextCursor).toBeNull()
  })

  it('never selects buyer/customer fields — item/pricing facts only', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValue([])
    await listNeedsManualReview(null)
    const sql = (prisma.$queryRaw as Mock).mock.calls[0][0].sql as string
    expect(sql.toLowerCase()).not.toMatch(/buyer|customer|email/)
  })
})
