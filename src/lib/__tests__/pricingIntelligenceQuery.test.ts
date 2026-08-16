import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findMany: vi.fn() },
    listing: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/advancedValuationQuery', () => ({
  getCatalogValuations: vi.fn(),
}))

vi.mock('@/lib/externalMarketResearch', () => ({
  getExternalMarketSummaries: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { getCatalogValuations } from '@/lib/advancedValuationQuery'
import { getExternalMarketSummaries } from '@/lib/externalMarketResearch'
import {
  getPricingIntelligenceBatch,
  getListingPriceComparison,
  scanOpportunities,
  OPPORTUNITY_PAGE_SIZE,
} from '@/lib/pricingIntelligenceQuery'
import type { AdvancedValuation } from '@/lib/advancedValuation'
import type { ExternalMarketSummary } from '@/lib/externalMarketResearch'

const ASOF = new Date('2026-08-01T00:00:00.000Z')

function fpVal(id: string, overrides: Partial<AdvancedValuation> = {}): AdvancedValuation {
  return {
    catalogModelId: id, asOf: ASOF, matchTier: 'exact', sampleCount: 0, effectiveSampleCount: 0,
    estimatedValue: null, lowEstimate: null, highEstimate: null, confidence: 'insufficient',
    confidenceReasons: [], latestSaleAt: null, medianDaysToSell: null,
    recentTrend: { direction: 'unavailable', percentageChange: null, recentMedian: null, priorMedian: null },
    activeAskContext: { activeListingCount: 0, lowestActiveAsk: null, medianActiveAsk: null, highestActiveAsk: null },
    liquidity: { medianDaysToSell: null, p25DaysToSell: null, p75DaysToSell: null, durationSampleCount: 0, recentCompletedSaleCount: 0, activePurchasableListingCount: 0 },
    outliersRemoved: false, unweightedMedian: null, weightedMedian: null, extendedHistoryUsed: false,
    minCents: null, maxCents: null, oldestSaleAt: null,
    ...overrides,
  }
}

function extSummary(id: string, overrides: Partial<ExternalMarketSummary> = {}): ExternalMarketSummary {
  return {
    catalogModelId: id, asOf: ASOF, soldSummary: null, activeAskCount: 0, lowestActiveAskCents: null,
    askSummary: null, researchFreshness: 'unavailable', latestSoldAt: null, latestAskObservedAt: null, providers: [],
    ...overrides,
  }
}

describe('pricingIntelligenceQuery: getPricingIntelligenceBatch (no N+1)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('fetches evidence with exactly one batched call per engine, regardless of batch size', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `cat${i}`)
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce(
      ids.map(id => ({ id, brand: 'Hot Wheels', name: 'Model', series: null, year: null })),
    )
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map(ids.map(id => [id, fpVal(id)])))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map(ids.map(id => [id, extSummary(id)])))

    const result = await getPricingIntelligenceBatch(ids, ASOF)

    expect(result.size).toBe(20)
    expect(getCatalogValuations).toHaveBeenCalledTimes(1) // one batched call, not one per model
    expect(getExternalMarketSummaries).toHaveBeenCalledTimes(1)
  })

  it('passes the single supplied asOf through unchanged to both engines', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }])
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map([['cat1', fpVal('cat1')]]))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map([['cat1', extSummary('cat1')]]))

    await getPricingIntelligenceBatch(['cat1'], ASOF)

    expect((getCatalogValuations as Mock).mock.calls[0][1]).toBe(ASOF)
    expect((getExternalMarketSummaries as Mock).mock.calls[0][1]).toBe(ASOF)
  })

  it('deduplicates repeated catalogModelIds before querying', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }])
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map([['cat1', fpVal('cat1')]]))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map([['cat1', extSummary('cat1')]]))

    await getPricingIntelligenceBatch(['cat1', 'cat1', 'cat1'], ASOF)

    expect((getCatalogValuations as Mock).mock.calls[0][0]).toEqual(['cat1'])
  })

  it('returns an empty map for an empty id list without querying', async () => {
    const result = await getPricingIntelligenceBatch([], ASOF)
    expect(result.size).toBe(0)
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
  })
})

describe('pricingIntelligenceQuery: transaction-aware client threading (execution-snapshot pass, Part 1)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('defaults to the global prisma client when no client is supplied — every pre-existing caller is unaffected', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }])
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map([['cat1', fpVal('cat1')]]))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map([['cat1', extSummary('cat1')]]))

    await getPricingIntelligenceBatch(['cat1'], ASOF)

    expect((getCatalogValuations as Mock).mock.calls[0][2]).toBe(prisma)
    expect((getExternalMarketSummaries as Mock).mock.calls[0][2]).toBe(prisma)
  })

  it('a caller-supplied client (e.g. an open transaction) is threaded through to BOTH evidence engines AND the CatalogModel lookup — never split across the tx client and the disconnected global client', async () => {
    const fakeTx = { catalogModel: { findMany: vi.fn().mockResolvedValue([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }]) } } as never
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map([['cat1', fpVal('cat1')]]))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map([['cat1', extSummary('cat1')]]))

    await getPricingIntelligenceBatch(['cat1'], ASOF, fakeTx)

    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled() // the plain global client must NOT be touched
    expect((fakeTx as { catalogModel: { findMany: Mock } }).catalogModel.findMany).toHaveBeenCalledTimes(1)
    expect((getCatalogValuations as Mock).mock.calls[0][2]).toBe(fakeTx)
    expect((getExternalMarketSummaries as Mock).mock.calls[0][2]).toBe(fakeTx)
  })

  it('getPricingIntelligence (single-model) forwards its client param through to the batch call', async () => {
    const fakeTx = { catalogModel: { findMany: vi.fn().mockResolvedValue([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }]) } } as never
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map([['cat1', fpVal('cat1')]]))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map([['cat1', extSummary('cat1')]]))

    const { getPricingIntelligence } = await import('@/lib/pricingIntelligenceQuery')
    await getPricingIntelligence('cat1', ASOF, fakeTx)

    expect((getCatalogValuations as Mock).mock.calls[0][2]).toBe(fakeTx)
  })
})

describe('pricingIntelligenceQuery: getListingPriceComparison (section 17, read-only)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('never mutates Listing — only reads price via findUnique, no update/upsert call anywhere in the module', () => {
    const src = readSrc('src/lib/pricingIntelligenceQuery.ts')
    expect(src).not.toMatch(/prisma\.listing\.(update|upsert|delete)/)
    expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('returns null for a nonexistent listing rather than throwing', async () => {
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce(null)
    const result = await getListingPriceComparison('missing-id', ASOF)
    expect(result).toBeNull()
  })

  it('converts Listing.price (Float dollars) to integer cents deterministically', async () => {
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 19.99, item: { catalogId: 'cat1' } })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }])
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map([['cat1', fpVal('cat1', { sampleCount: 5, effectiveSampleCount: 5, estimatedValue: 2000, unweightedMedian: 2000, lowEstimate: 1900, highEstimate: 2100, confidence: 'high', latestSaleAt: ASOF })]]))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map([['cat1', extSummary('cat1')]]))

    const result = await getListingPriceComparison('lst1', ASOF)
    expect(result?.comparison.listingPriceCents).toBe(1999) // $19.99 -> 1999 cents, no float drift
    expect(result?.comparison.classification).toBe('within_guidance') // 1999 vs target 2000 is within the tolerance band
  })
})

describe('pricingIntelligenceQuery: scanOpportunities (bounded pagination)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('requests at most OPPORTUNITY_PAGE_SIZE + 1 candidate rows per page (DB-bounded, not a full table scan)', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([]) // candidate page
    await scanOpportunities(null, undefined, ASOF)
    const call = (prisma.catalogModel.findMany as Mock).mock.calls[0][0]
    expect(call.take).toBe(OPPORTUNITY_PAGE_SIZE + 1)
  })

  it('candidate query is scoped to models with at least one signal (completed sale, active listing, or external observation) — never an unfiltered scan', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([])
    await scanOpportunities(null, undefined, ASOF)
    const call = (prisma.catalogModel.findMany as Mock).mock.calls[0][0]
    expect(call.where.OR).toBeDefined()
    expect(call.where.OR.length).toBeGreaterThanOrEqual(3)
  })

  it('nextCursor is null when fewer than PAGE_SIZE+1 candidates are returned', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `cat${i}`)
    ;(prisma.catalogModel.findMany as Mock)
      .mockResolvedValueOnce(ids.map(id => ({ id }))) // candidate page
      .mockResolvedValueOnce(ids.map(id => ({ id, brand: 'H', name: 'M', series: null, year: null }))) // fetchTargets
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map(ids.map(id => [id, fpVal(id)])))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map(ids.map(id => [id, extSummary(id)])))

    const result = await scanOpportunities(null, undefined, ASOF)
    expect(result.nextCursor).toBeNull()
  })

  it('nextCursor is set (and only PAGE_SIZE items are valued) when a 26th row signals more pages', async () => {
    const candidateRows = Array.from({ length: OPPORTUNITY_PAGE_SIZE + 1 }, (_, i) => ({ id: `cat${i}` }))
    ;(prisma.catalogModel.findMany as Mock)
      .mockResolvedValueOnce(candidateRows) // candidate page
      .mockResolvedValueOnce(candidateRows.slice(0, OPPORTUNITY_PAGE_SIZE).map(r => ({ id: r.id, brand: 'H', name: 'M', series: null, year: null }))) // fetchTargets

    const pageIds = candidateRows.slice(0, OPPORTUNITY_PAGE_SIZE).map(r => r.id)
    ;(getCatalogValuations as Mock).mockResolvedValueOnce(new Map(pageIds.map(id => [id, fpVal(id)])))
    ;(getExternalMarketSummaries as Mock).mockResolvedValueOnce(new Map(pageIds.map(id => [id, extSummary(id)])))

    const result = await scanOpportunities(null, undefined, ASOF)
    expect(result.nextCursor).toBe(`cat${OPPORTUNITY_PAGE_SIZE - 1}`)
    expect(getCatalogValuations).toHaveBeenCalledTimes(1) // one batched valuation call for the whole page, not per-row
  })

  it('cursor pagination is deterministic: identical inputs on repeated calls request the same next page', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockImplementation((args: { select?: { id?: boolean; brand?: boolean } }) =>
      Promise.resolve(args.select?.brand ? [{ id: 'catA', brand: 'H', name: 'M', series: null, year: null }] : [{ id: 'catA' }]),
    )
    ;(getCatalogValuations as Mock).mockResolvedValue(new Map([['catA', fpVal('catA')]]))
    ;(getExternalMarketSummaries as Mock).mockResolvedValue(new Map([['catA', extSummary('catA')]]))

    const calls = (prisma.catalogModel.findMany as Mock).mock.calls
    await scanOpportunities(null, 'cursor1', ASOF)
    await scanOpportunities(null, 'cursor1', ASOF)
    expect(calls[0][0].where.id).toEqual(calls[2][0].where.id) // candidate-page call in each invocation uses the same cursor predicate
  })

  it('an empty candidate page returns no items without calling the valuation engines', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([])
    const result = await scanOpportunities('low_confidence', undefined, ASOF)
    expect(result.items).toEqual([])
    expect(getCatalogValuations).not.toHaveBeenCalled()
  })
})

describe('pricingIntelligenceQuery: scanOpportunities — derived-filter multi-page continuation (section 1)', () => {
  beforeEach(() => vi.resetAllMocks())

  // Simulates 3 source pages of 25 candidates each: pages 1-2 have zero matches for
  // 'high_confidence', page 3 has 2 matches. A naive single-page scan would return
  // an empty result on the first call even though matches exist just beyond it.
  function mockThreePagesWithLateMatches() {
    // Each non-final page has PAGE_SIZE+1 raw rows so fetchCandidatePage's own
    // hasMore/slice logic signals "more pages exist" exactly like real Postgres
    // would — otherwise a mock returning exactly PAGE_SIZE rows looks like the last
    // page and the scan would (correctly) stop after page 1.
    const page1Raw = Array.from({ length: OPPORTUNITY_PAGE_SIZE + 1 }, (_, i) => `p1-${i}`)
    const page2Raw = Array.from({ length: OPPORTUNITY_PAGE_SIZE + 1 }, (_, i) => `p2-${i}`)
    const page1 = page1Raw.slice(0, OPPORTUNITY_PAGE_SIZE) // what the real code actually processes
    const page2 = page2Raw.slice(0, OPPORTUNITY_PAGE_SIZE)
    const page3 = ['p3-match-a', 'p3-match-b'] // final, short page — fewer than PAGE_SIZE+1 signals source exhaustion

    ;(prisma.catalogModel.findMany as Mock).mockImplementation((args: { select?: { brand?: boolean }; where?: { id?: { gt?: string; in?: string[] } } }) => {
      // Target lookups (fetchTargets) query by `id: { in: [...] }` — echo back exactly
      // the requested ids, regardless of which candidate page they came from.
      if (args.where?.id?.in) {
        return Promise.resolve(args.where.id.in.map(id => ({ id, brand: 'H', name: 'M', series: null, year: null })))
      }
      // Candidate-page lookups query by `id: { gt: cursor } }` (or no cursor for page 1).
      const cursor = args.where?.id?.gt
      if (cursor === undefined) return Promise.resolve(page1Raw.map(id => ({ id })))
      if (cursor === page1[page1.length - 1]) return Promise.resolve(page2Raw.map(id => ({ id })))
      if (cursor === page2[page2.length - 1]) return Promise.resolve(page3.map(id => ({ id })))
      return Promise.resolve([])
    })

    ;(getCatalogValuations as Mock).mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map(id => [
        id,
        fpVal(id, id.startsWith('p3-match') ? { sampleCount: 10, effectiveSampleCount: 10, confidence: 'high', estimatedValue: 1000, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, latestSaleAt: ASOF } : {}),
      ]))),
    )
    ;(getExternalMarketSummaries as Mock).mockImplementation((ids: string[]) => Promise.resolve(new Map(ids.map(id => [id, extSummary(id)]))))

    return { page1, page2, page3 }
  }

  it('continues scanning through empty intermediate pages and finds matches on a later page in a single call', async () => {
    const { page3 } = mockThreePagesWithLateMatches()
    const result = await scanOpportunities('high_confidence', undefined, ASOF)

    expect(result.items.map(i => i.catalogModelId).sort()).toEqual([...page3].sort())
    expect(result.items.length).toBe(2)
  })

  it('nextCursor after exhausting all 3 source pages is null (source exhausted), not the last match', async () => {
    mockThreePagesWithLateMatches()
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    expect(result.nextCursor).toBeNull()
  })

  it('an empty output page does not incorrectly imply "no later matches" — matches surface as soon as they exist, no matter how many intermediate empty pages precede them', async () => {
    const { page1, page2 } = mockThreePagesWithLateMatches()
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    // The scan itself absorbs pages 1 and 2 (which independently would look empty)
    // and still returns the real matches from page 3 in the very first call.
    expect(result.items.length).toBeGreaterThan(0)
    expect([...page1, ...page2].some(id => result.items.map(i => i.catalogModelId).includes(id))).toBe(false)
  })

  it('no matching model is skipped or repeated when the scan spans multiple source pages', async () => {
    mockThreePagesWithLateMatches()
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    const ids = result.items.map(i => i.catalogModelId)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
    expect(ids.sort()).toEqual(['p3-match-a', 'p3-match-b']) // no omissions
  })

})

describe('pricingIntelligenceQuery: scanOpportunities — no arbitrary total-model cap', () => {
  beforeEach(() => vi.resetAllMocks())

  // Zero-padded ids so `orderBy: { id: 'asc' }` / `id: { gt: cursor }` string
  // comparison matches real numeric order, exactly like the real DB.
  function idAt(n: number): string {
    return `model-${String(n).padStart(6, '0')}`
  }
  function indexOfId(id: string): number {
    return parseInt(id.slice('model-'.length), 10)
  }

  // A linear population of `totalModels` candidate CatalogModels, driven entirely by
  // real cursor semantics (no hardcoded "page1/page2/page3") — `matchIndices` are the
  // positions that resolve to a 'high_confidence' valuation, everywhere else resolves
  // to 'insufficient'. This lets tests place a match arbitrarily deep (position 501,
  // 5000, ...) and verify the scan actually reaches it.
  function mockLinearPopulation(totalModels: number, matchIndices: number[]) {
    ;(prisma.catalogModel.findMany as Mock).mockImplementation((args: {
      where?: { id?: { gt?: string; in?: string[] } }
      take?: number
      select?: { id?: boolean }
    }) => {
      if (args.where?.id?.in) {
        return Promise.resolve(args.where.id.in.map(id => ({ id, brand: 'H', name: 'M', series: null, year: null })))
      }
      const cursor = args.where?.id?.gt
      const startIdx = cursor === undefined ? 0 : indexOfId(cursor) + 1
      const take = args.take ?? OPPORTUNITY_PAGE_SIZE + 1
      const ids: string[] = []
      for (let i = startIdx; i < totalModels && ids.length < take; i++) ids.push(idAt(i))
      return Promise.resolve(ids.map(id => ({ id })))
    })

    ;(getCatalogValuations as Mock).mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map(id => [
        id,
        fpVal(id, matchIndices.includes(indexOfId(id))
          ? { sampleCount: 10, effectiveSampleCount: 10, confidence: 'high', estimatedValue: 1000, unweightedMedian: 1000, lowEstimate: 900, highEstimate: 1100, latestSaleAt: ASOF }
          : {}),
      ]))),
    )
    ;(getExternalMarketSummaries as Mock).mockImplementation((ids: string[]) => Promise.resolve(new Map(ids.map(id => [id, extSummary(id)]))))
  }

  it('a qualifying result beyond model 500 is still found and returned in a single call', async () => {
    mockLinearPopulation(600, [525])
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    expect(result.items.map(i => i.catalogModelId)).toEqual([idAt(525)])
  })

  it('a sparse derived filter traverses more than 20 source pages (500+ models) to find its one match', async () => {
    mockLinearPopulation(600, [575]) // 575 / 25 = page 24 — beyond the old 20-page/500-model cap
    const findManySpy = prisma.catalogModel.findMany as Mock
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    expect(result.items.map(i => i.catalogModelId)).toEqual([idAt(575)])
    // Candidate-page calls only (exclude the id:{in:...} target lookups).
    const candidatePageCalls = findManySpy.mock.calls.filter(([args]) => !args.where?.id?.in).length
    expect(candidatePageCalls).toBeGreaterThan(20)
  })

  it('every candidate-page query is individually bounded: fixed `take`, keyset `id: { gt }`, never OFFSET/skip, never an unbounded read', async () => {
    mockLinearPopulation(600, [575])
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    expect(result.items).toHaveLength(1)

    const findManySpy = prisma.catalogModel.findMany as Mock
    for (const [args] of findManySpy.mock.calls) {
      if (args.where?.id?.in) continue // target lookup, not a candidate page
      expect(args.take).toBe(OPPORTUNITY_PAGE_SIZE + 1) // same fixed bound on every page, however many pages
      expect(args).not.toHaveProperty('skip')
      expect(args.orderBy).toEqual({ id: 'asc' })
    }
  })

  it('no source model is skipped or repeated across a long multi-page scan', async () => {
    mockLinearPopulation(600, [10, 300, 575]) // matches spread across early/mid/late pages
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    const ids = result.items.map(i => i.catalogModelId)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
    expect(ids.sort()).toEqual([idAt(10), idAt(300), idAt(575)].sort()) // no omissions
  })

  it('eventual source exhaustion (no match anywhere) returns nextCursor=null, not a resumable cursor forever', async () => {
    mockLinearPopulation(60, []) // small, fully-scannable population, zero matches
    const result = await scanOpportunities('high_confidence', undefined, ASOF)
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('never loads a full candidate table into memory: each page fetch caps rows at PAGE_SIZE+1 regardless of how large the underlying population is', async () => {
    mockLinearPopulation(5000, [4900])
    const findManySpy = prisma.catalogModel.findMany as Mock
    await scanOpportunities('high_confidence', undefined, ASOF)
    const maxRowsRequestedPerCall = Math.max(...findManySpy.mock.calls.map(([args]) => args.take ?? args.where?.id?.in?.length ?? 0))
    expect(maxRowsRequestedPerCall).toBeLessThanOrEqual(OPPORTUNITY_PAGE_SIZE + 1)
  })

  it('a time-budget cutoff (runtime protection) returns an EXPLICIT incomplete result with a resumable cursor, never a silently truncated/lost scan', async () => {
    mockLinearPopulation(1000, []) // no matches anywhere; plenty of source population left unscanned
    let calls = 0
    const fakeNow = () => { calls++; return calls <= 3 ? 0 : 999_999 } // lets ~2 page fetches happen, then the budget check fails
    const result = await scanOpportunities('high_confidence', undefined, ASOF, fakeNow)
    expect(result.items).toEqual([])
    expect(result.nextCursor).not.toBeNull() // explicitly resumable — the 1000-model population was NOT exhausted
  })
})
