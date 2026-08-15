// 15J: DB-boundary tests for readyToListQuery.ts. Reuses detectItemContradictions
// (15C) and getPricingIntelligenceBatch (14C) directly rather than re-deriving their
// logic — mocked here at the function boundary; their own correctness is covered by
// itemLifecycle.test.ts / pricingIntelligence tests. This file checks composition,
// batching (no N+1), legacy-null handling, and — the focused-review section 5-10
// fix — derived-filter pagination correctness across many source chunks with a
// realistic in-memory keyset-cursor mock (not just a single mocked chunk).
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { findUnique: vi.fn(), findMany: vi.fn() },
    sellerAgreement: { findUnique: vi.fn(), findMany: vi.fn() },
    orderItem: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    sellerLifecycleCase: { findFirst: vi.fn(), findMany: vi.fn() },
    sellerPayoutLine: { count: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({
  getPricingIntelligence: vi.fn(),
  getPricingIntelligenceBatch: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { getPricingIntelligence, getPricingIntelligenceBatch } from '@/lib/pricingIntelligenceQuery'
import { buildSearchWhere, type ItemSearchFilter } from '@/lib/itemLifecycleQuery'
import {
  getReadyToListContext, getItemReadyToListStatus, searchReadyToListPage,
} from '@/lib/readyToListQuery'

function baseItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item1', status: 'available', locationId: 'loc1', sourceType: 'buyout',
    sellerAgreementId: null, sellerPortfolioId: null, catalogId: 'cat1',
    listing: null,
    ...overrides,
  }
}

// 15J (composable-filters pass): the "no ordinary filter selected" case — used for
// every call site that only cares about readiness mechanics, not filter composition.
const EMPTY_FILTER: ItemSearchFilter = { q: '', status: '', condition: '', cardedOrLoose: '', sort: 'sku' }

beforeEach(() => vi.resetAllMocks())

describe('getReadyToListContext — single item', () => {
  it('returns null for a missing item', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(null)
    expect(await getReadyToListContext('missing')).toBeNull()
  })

  it('a legacy item with no agreement, no listing, no return case builds a clean context', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(baseItemRow())
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.orderItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.sellerLifecycleCase.findFirst as Mock).mockResolvedValue(null)
    ;(getPricingIntelligence as Mock).mockResolvedValue(null)

    const ctx = await getReadyToListContext('item1')
    expect(ctx).toMatchObject({
      itemStatus: 'available', locationId: 'loc1', sourceType: 'buyout',
      sellerAgreementId: null, agreementStatus: null, listingStatus: null,
      completedOrderCount: 0, hasOpenReturnCase: false,
    })
    expect(ctx!.contradictions).toEqual([])
    // getPricingIntelligence returning null (no evidence at all) is reported
    // honestly as insufficient/no-evidence, never fabricated.
    expect(ctx!.pricing).toEqual({ estimatedValueCents: null, confidenceLevel: 'insufficient', isAskOnly: false })
  })

  it('a completed sale overrides a stale "available" status via the reused contradiction detector', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(baseItemRow({ status: 'available' }))
    ;(prisma.orderItem.count as Mock).mockResolvedValue(1)
    ;(prisma.orderItem.findFirst as Mock).mockResolvedValue({ id: 'oi1' })
    ;(prisma.sellerPayoutLine.count as Mock).mockResolvedValue(0)
    ;(prisma.sellerLifecycleCase.findFirst as Mock).mockResolvedValue(null)
    ;(getPricingIntelligence as Mock).mockResolvedValue(null)

    const ctx = await getReadyToListContext('item1')
    expect(ctx!.completedOrderCount).toBe(1)
    expect(ctx!.contradictions.map((c) => c.code)).toContain('available_but_sold_evidence')
  })

  it('fetches the agreement only when sellerAgreementId is set — no wasted query otherwise', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(baseItemRow({ sellerAgreementId: null }))
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.orderItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.sellerLifecycleCase.findFirst as Mock).mockResolvedValue(null)
    ;(getPricingIntelligence as Mock).mockResolvedValue(null)

    await getReadyToListContext('item1')
    expect(prisma.sellerAgreement.findUnique).not.toHaveBeenCalled()
  })

  it('an open return case is surfaced from the same RETURN_PENDING_CASE_TYPES/status predicate 15I uses', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(baseItemRow())
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.orderItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.sellerLifecycleCase.findFirst as Mock).mockResolvedValue({ id: 'case1' })
    ;(getPricingIntelligence as Mock).mockResolvedValue(null)

    const ctx = await getReadyToListContext('item1')
    expect(ctx!.hasOpenReturnCase).toBe(true)
    const call = (prisma.sellerLifecycleCase.findFirst as Mock).mock.calls[0][0]
    expect(call.where.caseType.in).toEqual(['return_to_seller', 'consignment_expiration', 'seller_withdrawal'])
    expect(call.where.status.in).toEqual(['open', 'action_required'])
  })
})

describe('getItemReadyToListStatus', () => {
  it('returns null for a missing item without evaluating anything', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(null)
    expect(await getItemReadyToListStatus('missing')).toBeNull()
  })

  it('evaluates the fetched context through the shared pure engine', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(baseItemRow())
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.orderItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.sellerLifecycleCase.findFirst as Mock).mockResolvedValue(null)
    ;(getPricingIntelligence as Mock).mockResolvedValue({ estimatedValueCents: 5000, confidence: { level: 'high' }, isAskOnly: false })

    const outcome = await getItemReadyToListStatus('item1')
    expect(outcome!.status).toBe('ready')
  })
})

describe('searchReadyToListPage — bounded batch scan (no N+1, no per-row 14C)', () => {
  it("'ready'/'review_required' candidates AND the safe status='available' predicate onto the (empty) ordinary filter — never a bare override", async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
    await searchReadyToListPage('ready', EMPTY_FILTER, null)
    const call = (prisma.itemInstance.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ AND: [{}, { status: 'available' }] })
  })

  it("'blocked' candidates are not status-narrowed — every status is a candidate (ordinary filter alone, no AND-wrapping)", async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
    await searchReadyToListPage('blocked', EMPTY_FILTER, null)
    const call = (prisma.itemInstance.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({})
  })

  it('hydrates a whole page with a bounded, fixed number of batch queries — never one per row', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => baseItemRow({
      id: `item${i}`, sku: `SKU-${i}`, catalog: { brand: 'Hot Wheels', name: 'GT3' }, sellerAgreementId: null,
    }))
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce(rows.map((r) => ({ ...r, sku: r.id, catalog: { brand: 'Hot Wheels', name: 'GT3' } })))
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    ;(prisma.orderItem.groupBy as Mock).mockResolvedValue([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.sellerLifecycleCase.findMany as Mock).mockResolvedValue([])
    ;(getPricingIntelligenceBatch as Mock).mockResolvedValue(new Map())

    await searchReadyToListPage('ready', EMPTY_FILTER, null, 10)

    // Exactly one call each — never scaled with the number of rows in the page.
    expect(prisma.orderItem.groupBy).toHaveBeenCalledTimes(1)
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.sellerLifecycleCase.findMany).toHaveBeenCalledTimes(1)
    expect(getPricingIntelligenceBatch).toHaveBeenCalledTimes(1)
    expect(prisma.sellerAgreement.findUnique).not.toHaveBeenCalled()
  })

  it('pricing is fetched via the BATCH function (distinct catalog ids), never per-row getPricingIntelligence', async () => {
    const rows = [
      baseItemRow({ id: 'a', sku: 'A', catalog: { brand: 'X', name: 'Y' }, catalogId: 'cat1' }),
      baseItemRow({ id: 'b', sku: 'B', catalog: { brand: 'X', name: 'Y' }, catalogId: 'cat1' }),
    ]
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce(rows)
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    ;(prisma.orderItem.groupBy as Mock).mockResolvedValue([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.sellerLifecycleCase.findMany as Mock).mockResolvedValue([])
    ;(getPricingIntelligenceBatch as Mock).mockResolvedValue(new Map())

    await searchReadyToListPage('ready', EMPTY_FILTER, null, 10)
    expect(getPricingIntelligenceBatch).toHaveBeenCalledWith(['cat1'])
    expect(getPricingIntelligence).not.toHaveBeenCalled()
  })

  it('only rows whose full evaluation matches the requested readiness are returned', async () => {
    const rows = [
      baseItemRow({ id: 'ready1', sku: 'R1', catalog: { brand: 'X', name: 'Y' } }),
      baseItemRow({ id: 'blocked1', sku: 'B1', catalog: { brand: 'X', name: 'Y' }, locationId: null }),
    ]
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce(rows)
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    ;(prisma.orderItem.groupBy as Mock).mockResolvedValue([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.sellerLifecycleCase.findMany as Mock).mockResolvedValue([])
    // High-confidence pricing for cat1 so ready1 lands on 'ready' rather than
    // 'review_required' (an empty pricing map would report no_evidence).
    ;(getPricingIntelligenceBatch as Mock).mockResolvedValue(
      new Map([['cat1', { estimatedValueCents: 5000, confidence: { level: 'high' }, isAskOnly: false }]]),
    )

    const result = await searchReadyToListPage('ready', EMPTY_FILTER, null, 10)
    expect(result.items.map((r) => r.id)).toEqual(['ready1'])
  })
})

describe('searchReadyToListPage — ordinary-filter composition (15J composable-filters focused review)', () => {
  it('the ordinary predicate embedded in the query is IDENTICAL to buildSearchWhere(filter) — no drifted second interpretation of q/status/condition/type', async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
    const filter: ItemSearchFilter = { q: 'porsche', status: '', condition: 'mint', cardedOrLoose: 'carded', sort: 'sku' }

    await searchReadyToListPage('blocked', filter, null) // 'blocked' embeds the ordinary predicate with no AND-wrapping
    const blockedWhere = (prisma.itemInstance.findMany as Mock).mock.calls[0][0].where
    expect(blockedWhere).toEqual(buildSearchWhere(filter))

    ;(prisma.itemInstance.findMany as Mock).mockClear()
    await searchReadyToListPage('ready', filter, null)
    const readyWhere = (prisma.itemInstance.findMany as Mock).mock.calls[0][0].where
    expect(readyWhere).toEqual({ AND: [buildSearchWhere(filter), { status: 'available' }] })
  })

  it('an explicit incompatible status (status=sold + readiness=ready) is ANDed, not overridden or dropped — the impossible combination is sent to the DB verbatim', async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
    const filter: ItemSearchFilter = { q: '', status: 'sold', condition: '', cardedOrLoose: '', sort: 'sku' }
    await searchReadyToListPage('ready', filter, null)
    const call = (prisma.itemInstance.findMany as Mock).mock.calls[0][0]
    // Both constraints are present in the query — neither the ordinary status=sold
    // filter nor the readiness candidate status=available predicate was silently
    // dropped to "resolve" the conflict (focused-review section 3).
    expect(call.where).toEqual({ AND: [{ status: 'sold' }, { status: 'available' }] })
  })
})

// ── Derived-filter pagination correctness (focused-review sections 5-10) ─────────
//
// A realistic in-memory keyset-cursor simulation of Prisma's actual
// findMany({ orderBy: {id:'asc'}, cursor, skip:1, take }) semantics — id-sorted,
// cursor-exclusive — so these tests exercise the REAL multi-chunk scan loop in
// searchReadyToListPage, not just a single mocked chunk. SCAN_CHUNK_SIZE is 50
// (internal to the module); 120 fixture rows guarantee >= 3 chunks.
describe('searchReadyToListPage — large-fixture pagination correctness', () => {
  const TOTAL = 120
  // Deterministic id-sortable ids: item000..item119. `condition`/`cardedOrLoose`/the
  // sku "porsche" marker are independent of the ready/blocked split so ordinary-
  // filter + readiness combinations below select genuinely different subsets.
  const ALL_ROWS = Array.from({ length: TOTAL }, (_, i) => {
    const id = `item${String(i).padStart(3, '0')}`
    const ready = i % 3 === 0 // 40 ready rows, interleaved with 80 blocked rows
    return {
      id, sku: i % 5 === 0 ? `${id}-porsche` : id, status: 'available',
      condition: i % 4 === 0 ? 'mint' : 'good',
      cardedOrLoose: i % 2 === 0 ? 'carded' : 'loose',
      locationId: ready ? 'loc1' : null, // null -> storage_missing -> blocked
      sourceType: 'buyout', sellerAgreementId: null, sellerPortfolioId: null,
      catalogId: 'cat1', catalog: { brand: 'X', name: 'Y' }, listing: null,
    }
  })
  const READY_IDS = ALL_ROWS.filter((_, i) => i % 3 === 0).map((r) => r.id)
  const BLOCKED_IDS = ALL_ROWS.filter((_, i) => i % 3 !== 0).map((r) => r.id)

  // Minimal Prisma `where`-shape evaluator covering exactly what buildSearchWhere +
  // the readiness candidate predicate can produce (AND/OR arrays, direct field
  // equality, and `{contains, mode}` substring matching on `sku`). Nested relation
  // filters (catalog/location/sellerPortfolio/listing/orderItems — none of which
  // this flat fixture models) conservatively evaluate to non-matching rather than
  // silently matching everything, so `q`'s OR-list can only match through the sku
  // branch here, never spuriously through an unmodeled relation branch.
  type Row = (typeof ALL_ROWS)[number]
  function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
    if ('AND' in where) return (where.AND as Record<string, unknown>[]).every((w) => matchesWhere(row, w))
    if ('OR' in where) return (where.OR as Record<string, unknown>[]).some((w) => matchesWhere(row, w))
    for (const [key, cond] of Object.entries(where)) {
      const val = (row as unknown as Record<string, unknown>)[key]
      if (cond && typeof cond === 'object' && 'contains' in (cond as Record<string, unknown>)) {
        const needle = String((cond as Record<string, unknown>).contains).toLowerCase()
        if (typeof val !== 'string' || !val.toLowerCase().includes(needle)) return false
      } else if (cond && typeof cond === 'object') {
        return false // unmodeled nested relation filter — never a false-positive match
      } else {
        if (val !== cond) return false
      }
    }
    return true
  }

  function installKeysetMock() {
    ;(prisma.itemInstance.findMany as Mock).mockImplementation(
      async (args: { where?: Record<string, unknown>; cursor?: { id: string }; take: number }) => {
        const filtered = ALL_ROWS.filter((r) => matchesWhere(r, args.where ?? {}))
        let startIdx = 0
        if (args.cursor) {
          const idx = filtered.findIndex((r) => r.id === args.cursor!.id)
          startIdx = idx + 1 // skip:1 — cursor row itself is excluded
        }
        return filtered.slice(startIdx, startIdx + args.take)
      },
    )
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    ;(prisma.orderItem.groupBy as Mock).mockResolvedValue([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.sellerLifecycleCase.findMany as Mock).mockResolvedValue([])
    ;(getPricingIntelligenceBatch as Mock).mockResolvedValue(
      new Map([['cat1', { estimatedValueCents: 5000, confidence: { level: 'high' }, isAskOnly: false }]]),
    )
  }

  async function collectAllPages(readiness: 'ready' | 'review_required' | 'blocked', filter: ItemSearchFilter, pageSize: number) {
    const pages: string[][] = []
    let cursor: string | null = null
    let guard = 0
    for (;;) {
      const result = await searchReadyToListPage(readiness, filter, cursor, pageSize)
      pages.push(result.items.map((r) => r.id))
      if (!result.nextCursor) break
      cursor = result.nextCursor
      if (++guard > 50) throw new Error('pagination did not terminate — likely infinite loop')
    }
    return pages
  }

  it('ready matches spread across 3 chunks: concatenating every page equals the full expected set, no dupes, no omissions, in order', async () => {
    installKeysetMock()
    const pages = await collectAllPages('ready', EMPTY_FILTER, 10)
    expect(pages.length).toBeGreaterThan(1) // proves multiple pages were needed
    const all = pages.flat()
    expect(all).toEqual(READY_IDS) // exact order, exact membership, no dupes/omissions
    expect(new Set(all).size).toBe(all.length)
  })

  it('a page that fills mid-chunk still returns a resumable cursor (the section-8 bug) — the NEXT page picks up immediately after the last match, not from scratch and not skipping ahead', async () => {
    installKeysetMock()
    // First 10 ready ids are all within chunk 1 (indices 0-49); page fills at the
    // 10th match, well before the chunk's natural end.
    const page1 = await searchReadyToListPage('ready', EMPTY_FILTER, null, 10)
    expect(page1.items.map((r) => r.id)).toEqual(READY_IDS.slice(0, 10))
    expect(page1.nextCursor).not.toBeNull() // must NOT claim exhaustion

    const page2 = await searchReadyToListPage('ready', EMPTY_FILTER, page1.nextCursor, 10)
    expect(page2.items.map((r) => r.id)).toEqual(READY_IDS.slice(10, 20))
  })

  it('a single page call correctly spans multiple internal chunks when the current chunk runs out of matches before pageSize is reached', async () => {
    installKeysetMock()
    // Chunk 1 (idx 0-49) has 17 ready rows. Requesting pageSize=17 starting from
    // scratch exhausts chunk 1 exactly; pageSize=18 forces the loop to fetch chunk 2.
    const result = await searchReadyToListPage('ready', EMPTY_FILTER, null, 18)
    expect(result.items.map((r) => r.id)).toEqual(READY_IDS.slice(0, 18))
  })

  it('blocked matches (80 of 120, unfiltered candidate pool) paginate completely across many chunks with no dupes/omissions', async () => {
    installKeysetMock()
    const pages = await collectAllPages('blocked', EMPTY_FILTER, 15)
    const all = pages.flat()
    expect(all).toEqual(BLOCKED_IDS)
    expect(new Set(all).size).toBe(all.length)
  })

  it('a readiness value with ZERO matches anywhere scans every chunk to true exhaustion — empty chunks never terminate the scan early, and the final result is an empty page with no next cursor', async () => {
    installKeysetMock()
    // No row in the fixture is ever 'review_required' (all are ready or blocked).
    const result = await searchReadyToListPage('review_required', EMPTY_FILTER, null, 10)
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeNull()
    // Proves every chunk was actually scanned, not just the first: the DB was
    // queried more than once (120 rows / 50-row chunks = 3 calls).
    expect((prisma.itemInstance.findMany as Mock).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('true source exhaustion (last chunk fully consumed, no page-fill involved) returns nextCursor: null', async () => {
    installKeysetMock()
    // pageSize larger than the total ready count (40) — the scan must consume
    // every chunk in full and correctly report exhaustion, not a resumable cursor.
    const result = await searchReadyToListPage('ready', EMPTY_FILTER, null, 1000)
    expect(result.items.map((r) => r.id)).toEqual(READY_IDS)
    expect(result.nextCursor).toBeNull()
  })

  it('ordering is the deterministic source id order, never OFFSET-based and never re-sorted after filtering', async () => {
    installKeysetMock()
    const result = await searchReadyToListPage('ready', EMPTY_FILTER, null, 40)
    const ids = result.items.map((r) => r.id)
    expect(ids).toEqual([...ids].sort())
  })

  it('candidate filter for ready/review is status=available, which cannot exclude a valid match (proof: every fixture row already has status=available, and the filter is a no-op superset here by construction — see readyToList.test.ts for the general engine-level proof)', async () => {
    installKeysetMock()
    await searchReadyToListPage('ready', EMPTY_FILTER, null, 5)
    const call = (prisma.itemInstance.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ AND: [{}, { status: 'available' }] })
  })

  // ── Composability: readiness + ordinary filters together (15J composable-filters
  // focused review, Part 9 "Pagination" requirements) — the same >1-internal-chunk
  // fixture, but now the candidate pool is ALSO narrowed by an ordinary filter, so
  // the expected matching set is the intersection, not just the readiness split. ──

  it('Ready + q=porsche: matches the intersection (readiness AND sku search) across 3 chunks, no dupes/omissions', async () => {
    installKeysetMock()
    const expected = ALL_ROWS.filter((_, i) => i % 3 === 0 && i % 5 === 0).map((r) => r.id)
    expect(expected.length).toBeGreaterThan(5) // sanity: a real multi-chunk-spanning set
    const filter: ItemSearchFilter = { q: 'porsche', status: '', condition: '', cardedOrLoose: '', sort: 'sku' }
    const pages = await collectAllPages('ready', filter, 3)
    expect(pages.length).toBeGreaterThan(1)
    const all = pages.flat()
    expect(all).toEqual(expected)
    expect(new Set(all).size).toBe(all.length)
  })

  it('Ready + condition=mint: matches the intersection across 3 chunks, no dupes/omissions', async () => {
    installKeysetMock()
    const expected = ALL_ROWS.filter((_, i) => i % 3 === 0 && i % 4 === 0).map((r) => r.id)
    expect(expected.length).toBeGreaterThan(5)
    const filter: ItemSearchFilter = { q: '', status: '', condition: 'mint', cardedOrLoose: '', sort: 'sku' }
    const pages = await collectAllPages('ready', filter, 3)
    const all = pages.flat()
    expect(all).toEqual(expected)
    expect(new Set(all).size).toBe(all.length)
  })

  it('Blocked + type=loose: matches the intersection across many chunks, no dupes/omissions (blocked stays status-unfiltered)', async () => {
    installKeysetMock()
    const expected = ALL_ROWS.filter((_, i) => i % 3 !== 0 && i % 2 !== 0).map((r) => r.id)
    expect(expected.length).toBeGreaterThan(20)
    const filter: ItemSearchFilter = { q: '', status: '', condition: '', cardedOrLoose: 'loose', sort: 'sku' }
    const pages = await collectAllPages('blocked', filter, 7)
    const all = pages.flat()
    expect(all).toEqual(expected)
    expect(new Set(all).size).toBe(all.length)
  })

  it('a page that fills mid-chunk under a combined ordinary+readiness filter still returns a correct resumable cursor', async () => {
    installKeysetMock()
    const expected = ALL_ROWS.filter((_, i) => i % 3 === 0 && i % 4 === 0).map((r) => r.id)
    const filter: ItemSearchFilter = { q: '', status: '', condition: 'mint', cardedOrLoose: '', sort: 'sku' }
    const page1 = await searchReadyToListPage('ready', filter, null, 3)
    expect(page1.items.map((r) => r.id)).toEqual(expected.slice(0, 3))
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await searchReadyToListPage('ready', filter, page1.nextCursor, 3)
    expect(page2.items.map((r) => r.id)).toEqual(expected.slice(3, 6))
  })

  it('an ordinary filter matching nothing in this fixture correctly reports an exhausted, empty result — the DB-level predicate (not evaluation) already excludes every row, so a single empty response correctly ends the scan', async () => {
    installKeysetMock()
    const filter: ItemSearchFilter = { q: 'zzz-no-such-token', status: '', condition: '', cardedOrLoose: '', sort: 'sku' }
    const result = await searchReadyToListPage('ready', filter, null, 10)
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeNull()
    // Distinct from the "review_required — ZERO matches anywhere" test above: there
    // the DB candidate pool is non-empty (120 rows) and evaluation rejects every one
    // across all 3 chunks. Here the ordinary filter itself makes the DB-level
    // candidate pool empty, so the (mocked, but realistic) DB correctly returns an
    // empty chunk on the very first call — that is truthful exhaustion, not an
    // early-termination bug.
    expect((prisma.itemInstance.findMany as Mock).mock.calls.length).toBe(1)
  })

  it('an explicit incompatible status (status=sold) + readiness=ready truthfully returns zero results — neither filter is silently dropped', async () => {
    installKeysetMock()
    const filter: ItemSearchFilter = { q: '', status: 'sold', condition: '', cardedOrLoose: '', sort: 'sku' }
    const result = await searchReadyToListPage('ready', filter, null, 10)
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeNull()
    // No fixture row has status 'sold' (all are 'available'), so the impossible
    // AND (status='sold' AND status='available') correctly yields zero DB rows on
    // the first call — proving the AND was actually sent to and honored by the
    // query. If status=sold had instead been silently dropped, every 'ready' row
    // would have matched and this would return a non-empty page instead.
    expect((prisma.itemInstance.findMany as Mock).mock.calls.length).toBe(1)
  })
})
