// 14C: DB boundary for pricing intelligence. Reuses the existing batch query
// functions from advancedValuationQuery.ts (12G-A) and externalMarketResearch.ts
// (12G-B) — two bounded queries total per batch, no N+1, no full-table reads. One
// `asOf` per request, passed through to both existing engines (both already accept
// an explicit asOf param, so no new "current time" read is introduced here).

import { prisma } from '@/lib/prisma'
import type { TargetModel } from '@/lib/resaleEstimator'
import { getCatalogValuations } from '@/lib/advancedValuationQuery'
import { getExternalMarketSummaries } from '@/lib/externalMarketResearch'
import { buildPricingIntelligence, compareListingToGuidance } from '@/lib/pricingIntelligence'
import type { PricingIntelligenceResult, ListingPriceComparison } from '@/lib/pricingIntelligence'

// Bounded page size for the admin opportunity scan (section 21/23) — a page of
// candidate models is fetched via keyset pagination, then valuation is computed in
// one batch for just that page. Never a full CatalogModel table scan per request.
export const OPPORTUNITY_PAGE_SIZE = 25

async function fetchTargets(catalogModelIds: string[]): Promise<TargetModel[]> {
  const rows = await prisma.catalogModel.findMany({
    where: { id: { in: catalogModelIds } },
    select: { id: true, brand: true, name: true, series: true, year: true },
  })
  return rows.map(r => ({ id: r.id, brand: r.brand, name: r.name, series: r.series, year: r.year }))
}

// Shared by getPricingIntelligenceBatch and scanOpportunities so callers that already
// have `targets` (e.g. a paginated scan) never re-issue the CatalogModel lookup.
async function buildBatchFromTargets(
  targets: TargetModel[],
  asOf: Date,
): Promise<Map<string, PricingIntelligenceResult>> {
  if (targets.length === 0) return new Map()
  const ids = targets.map(t => t.id)

  const [fpMap, extMap] = await Promise.all([
    getCatalogValuations(ids, asOf),
    getExternalMarketSummaries(ids, asOf),
  ])

  const result = new Map<string, PricingIntelligenceResult>()
  for (const target of targets) {
    const fp = fpMap.get(target.id)
    const ext = extMap.get(target.id)
    if (!fp || !ext) continue
    const cnt = {
      activeListingCount: fp.activeAskContext.activeListingCount,
      lowestAskCents: fp.activeAskContext.lowestActiveAsk,
      medianAskCents: fp.activeAskContext.medianActiveAsk,
      highestAskCents: fp.activeAskContext.highestActiveAsk,
    }
    result.set(target.id, buildPricingIntelligence(target.id, fp.matchTier, fp, ext, cnt, asOf))
  }
  return result
}

// Batch build: 1 CatalogModel lookup + 2 evidence queries (first-party, external)
// regardless of batch size.
export async function getPricingIntelligenceBatch(
  catalogModelIds: string[],
  asOf: Date = new Date(),
): Promise<Map<string, PricingIntelligenceResult>> {
  const deduped = [...new Set(catalogModelIds)]
  if (deduped.length === 0) return new Map()
  const targets = await fetchTargets(deduped)
  return buildBatchFromTargets(targets, asOf)
}

export async function getPricingIntelligence(
  catalogModelId: string,
  asOf: Date = new Date(),
): Promise<PricingIntelligenceResult | null> {
  const map = await getPricingIntelligenceBatch([catalogModelId], asOf)
  return map.get(catalogModelId) ?? null
}

// Section 17: compare one specific CollectNTrades Listing's price to guidance.
// Read-only — never writes Listing.price.
export async function getListingPriceComparison(listingId: string, asOf: Date = new Date()): Promise<{
  comparison: ListingPriceComparison
  catalogModelId: string
} | null> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { price: true, item: { select: { catalogId: true } } },
  })
  if (!listing) return null

  const result = await getPricingIntelligence(listing.item.catalogId, asOf)
  const targetCents = result?.recommendedListing.targetCents ?? null
  const listingPriceCents = Math.round(listing.price * 100)

  return {
    catalogModelId: listing.item.catalogId,
    comparison: compareListingToGuidance(listingPriceCents, targetCents),
  }
}

// ── Admin opportunity scan (bounded, keyset-paginated) ────────────────────────────

export type OpportunityFilter =
  | 'low_confidence'
  | 'high_confidence'
  | 'listing_above_guidance'
  | 'listing_below_guidance'
  | 'no_sold_evidence'
  | 'stale_external_evidence'
  | 'high_dispersion'

export type OpportunityRow = {
  catalogModelId: string
  brand: string
  name: string
  series: string | null
  year: number | null
  result: PricingIntelligenceResult
}

// Candidate models: those with at least one signal worth valuing (a completed
// first-party sale, an active first-party listing, or an external observation).
// This DB-side pre-filter is what keeps the scan bounded — models with zero signal
// are never fetched, valued, or paginated over.
//
// This SAME population is used for every filter, including 'no_sold_evidence': a
// model with an active listing or active external asks but zero completed sales is
// still a candidate (it has signal — it just lacks sold evidence, which is exactly
// what that filter looks for), so it is never silently excluded merely for lacking
// sales. Only a model with genuinely no signal of any kind (never listed, never
// sold, never observed externally) is excluded — there is nothing to price for it.
async function fetchCandidatePage(afterId: string | undefined): Promise<{ ids: string[]; nextCursor: string | null }> {
  const rows = await prisma.catalogModel.findMany({
    where: {
      ...(afterId ? { id: { gt: afterId } } : {}),
      OR: [
        { items: { some: { orderItems: { some: { order: { status: 'complete' } } } } } },
        { items: { some: { listing: { status: 'active' } } } },
        { externalObservations: { some: {} } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: OPPORTUNITY_PAGE_SIZE + 1,
  })
  const hasMore = rows.length > OPPORTUNITY_PAGE_SIZE
  const page = hasMore ? rows.slice(0, OPPORTUNITY_PAGE_SIZE) : rows
  return { ids: page.map(r => r.id), nextCursor: hasMore ? page[page.length - 1].id : null }
}

function matchesFilter(row: OpportunityRow, filter: OpportunityFilter): boolean {
  const r = row.result
  switch (filter) {
    case 'low_confidence': return r.confidence.level === 'low'
    case 'high_confidence': return r.confidence.level === 'high'
    case 'no_sold_evidence': return r.estimatedValueCents === null
    case 'stale_external_evidence': return r.evidence.externalSold.count === 0 || r.warnings.some(w => w.includes('30 days'))
    case 'high_dispersion': {
      const { lowCents, highCents, targetCents } = r.recommendedListing
      if (lowCents === null || highCents === null || targetCents === null || targetCents === 0) return false
      return (highCents - lowCents) / targetCents > 0.5
    }
    case 'listing_above_guidance': return r.marketPosition.collectNTrades.medianAskCents !== null
      && r.recommendedListing.targetCents !== null
      && r.marketPosition.collectNTrades.medianAskCents > r.recommendedListing.targetCents * 1.05
    case 'listing_below_guidance': return r.marketPosition.collectNTrades.medianAskCents !== null
      && r.recommendedListing.targetCents !== null
      && r.marketPosition.collectNTrades.medianAskCents < r.recommendedListing.targetCents * 0.95
  }
}

// A derived filter (confidence level, dispersion, listing-vs-guidance, ...) can only
// be evaluated AFTER valuation, so a single 25-row source page may yield zero
// matches even though later source pages have plenty. There is deliberately NO fixed
// total-model cap here — a sparse filter scanning past model 500, 5000, or however
// far the real candidate population goes is expected and correct; capping it would
// silently hide genuine matches. The only backstop is a wall-clock time budget, so a
// pathologically rare filter cannot hang a single request indefinitely. When the
// budget is hit, the scan returns an EXPLICIT incomplete result — whatever matches
// it already found (possibly none) plus `nextCursor` pointing at the last fully
// processed source model — so the caller resumes exactly where it left off. This is
// never a silent, arbitrary "give up after N models" omission: every source page
// between calls is still individually DB-bounded (OPPORTUNITY_PAGE_SIZE+1 rows,
// keyset `id > cursor`, no OFFSET, no full-table read).
const SCAN_TIME_BUDGET_MS = 8000

// Bounded, keyset-paginated scan that keeps fetching+valuing source pages — never a
// full-table read, always OPPORTUNITY_PAGE_SIZE-row pages — until either:
//   - enough matching rows have been collected to fill an output page, or
//   - the candidate source population is exhausted (nextCursor becomes null), or
//   - the time budget is exhausted (nextCursor stays non-null: resumable, not lost).
// A source page, once fetched and valued, is never partially discarded: every match
// it produces is kept (so a page that happens to match heavily can return more than
// OPPORTUNITY_PAGE_SIZE rows) — trimming to an exact page size would silently drop
// already-computed matches and force them to be re-scanned incorrectly next call.
// `nextCursor` is always the last SOURCE model fully examined, never merely the last
// matching result, so pagination cannot skip or repeat a candidate model.
//
// `nowMs` is an injectable clock (defaults to the real wall clock) purely for this
// function's own runtime-budget bookkeeping — it has no effect on the valuation
// itself, which is entirely governed by the caller-supplied `asOf`.
export async function scanOpportunities(
  filter: OpportunityFilter | null,
  afterId: string | undefined,
  asOf: Date = new Date(),
  nowMs: () => number = Date.now,
): Promise<{ items: OpportunityRow[]; nextCursor: string | null }> {
  const matches: OpportunityRow[] = []
  let cursor = afterId
  let lastProcessedId: string | null = null
  let sourceExhausted = false
  const deadline = nowMs() + SCAN_TIME_BUDGET_MS

  while (matches.length < OPPORTUNITY_PAGE_SIZE && nowMs() < deadline) {
    const { ids, nextCursor: pageCursor } = await fetchCandidatePage(cursor)
    if (ids.length === 0) { sourceExhausted = true; break }

    // Single CatalogModel lookup for this page, reused for both display names and
    // valuation targets — never a second, redundant lookup.
    const targets = await fetchTargets(ids)
    const results = await buildBatchFromTargets(targets, asOf)
    const nameById = new Map(targets.map(t => [t.id, t]))

    for (const id of ids) {
      const result = results.get(id)
      const target = nameById.get(id)
      if (result && target) {
        const row: OpportunityRow = { catalogModelId: id, brand: target.brand, name: target.name, series: target.series, year: target.year, result }
        if (!filter || matchesFilter(row, filter)) matches.push(row)
      }
      lastProcessedId = id // every id in this page is "fully processed" regardless of match
    }

    if (pageCursor === null) { sourceExhausted = true; break }
    cursor = pageCursor
  }

  return { items: matches, nextCursor: sourceExhausted ? null : lastProcessedId }
}
