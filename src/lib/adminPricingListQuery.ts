// 32B: canonical Admin Pricing list-page composition — replaces the legacy
// 14C scanOpportunities() as the DB boundary for /admin/valuation. Bounded,
// keyset-paginated, time-budgeted candidate-model scan — same resumable-
// cursor shape as the legacy scan, rebuilt on canonical getValuationsBatch
// instead of buildBatchFromTargets (pricingIntelligenceQuery.ts).
//
// The "has any signal" candidate pre-filter below is schema-level, not 14C-
// specific — copied rather than imported, exactly like marketValuationMath.ts's
// own behavior-preserving extraction from resaleEstimator.ts, so this
// migration never risks changing legacy scanOpportunities' own behavior for
// any surface still reading it.
import { prisma } from '@/lib/prisma'
import { getValuationsBatch, type ValuationResult } from '@/lib/marketValuation'
import { isHighDispersion } from '@/lib/marketValuationMath'
import { eligibleListingWhere } from '@/lib/listingEligibility'
import { internalPriceToCents } from '@/lib/marketMoney'

export const ADMIN_PRICING_PAGE_SIZE = 25

// §31: stale_external_evidence has no canonical equivalent (canonical Market
// Range carries no external-ask-freshness concept) and listing_above/below_
// guidance depended entirely on the removed legacy blended range — both
// dropped rather than faked. High Dispersion is retained: it already has a
// direct canonical primitive (marketValuationMath.ts's own isHighDispersion,
// reused verbatim below, never a second dispersion formula).
export type AdminPricingFilter = 'low_confidence' | 'high_confidence' | 'no_sold_evidence' | 'high_dispersion'

export type AdminPricingRow = {
  catalogModelId: string
  brand: string
  name: string
  series: string | null
  year: number | null
  valuation: ValuationResult
  lowestAskCents: number | null
  availableCopies: number
}

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
    take: ADMIN_PRICING_PAGE_SIZE + 1,
  })
  const hasMore = rows.length > ADMIN_PRICING_PAGE_SIZE
  const page = hasMore ? rows.slice(0, ADMIN_PRICING_PAGE_SIZE) : rows
  return { ids: page.map((r) => r.id), nextCursor: hasMore ? page[page.length - 1].id : null }
}

async function fetchTargets(ids: string[]): Promise<{ id: string; brand: string; name: string; series: string | null; year: number | null }[]> {
  if (ids.length === 0) return []
  return prisma.catalogModel.findMany({
    where: { id: { in: ids } },
    select: { id: true, brand: true, name: true, series: true, year: true },
  })
}

// §30/§28: ONE page-scoped batched query for current supply — never
// N x getInternalAskSummary. Same reduce-in-process shape as
// catalogDiscoveryQuery.ts's finishResult, reusing the exact same canonical
// "purchasable" predicate (listingEligibility.ts) — never a second, drifted
// eligibility definition.
async function fetchSupplyByModel(modelIds: string[]): Promise<Map<string, { lowestAskCents: number | null; availableCopies: number }>> {
  const supply = new Map<string, { lowestAskCents: number | null; availableCopies: number }>()
  for (const id of modelIds) supply.set(id, { lowestAskCents: null, availableCopies: 0 })
  if (modelIds.length === 0) return supply

  const listings = await prisma.listing.findMany({
    where: eligibleListingWhere(modelIds),
    select: { price: true, item: { select: { catalogId: true } } },
  })
  for (const listing of listings) {
    const entry = supply.get(listing.item.catalogId)
    if (!entry) continue
    entry.availableCopies += 1
    entry.lowestAskCents = entry.lowestAskCents === null ? listing.price : Math.min(entry.lowestAskCents, listing.price)
  }
  for (const [id, entry] of supply) {
    supply.set(id, {
      availableCopies: entry.availableCopies,
      lowestAskCents: entry.lowestAskCents !== null ? internalPriceToCents(entry.lowestAskCents) : null,
    })
  }
  return supply
}

function matchesFilter(row: AdminPricingRow, filter: AdminPricingFilter): boolean {
  const v = row.valuation
  switch (filter) {
    case 'low_confidence':
      return v.status === 'valued' && v.confidence === 'low'
    case 'high_confidence':
      return v.status === 'valued' && v.confidence === 'high'
    case 'no_sold_evidence':
      return v.status !== 'valued'
    case 'high_dispersion':
      return v.status === 'valued' && isHighDispersion(v.marketRangeLowCents, v.marketRangeHighCents, v.estimatedValueCents)
  }
}

// §32: same resumable-cursor guarantee as the legacy scan — a derived filter
// can only be evaluated after valuation, so a sparse filter legitimately
// scans past many source pages; the only backstop is a wall-clock time
// budget, never a fixed total-model cap that would silently hide matches.
const SCAN_TIME_BUDGET_MS = 8000

export async function scanAdminPricingOpportunities(
  filter: AdminPricingFilter | null,
  afterId: string | undefined,
  asOf: Date = new Date(),
  nowMs: () => number = Date.now,
): Promise<{ items: AdminPricingRow[]; nextCursor: string | null }> {
  const matches: AdminPricingRow[] = []
  let cursor = afterId
  let lastProcessedId: string | null = null
  let sourceExhausted = false
  const deadline = nowMs() + SCAN_TIME_BUDGET_MS

  while (matches.length < ADMIN_PRICING_PAGE_SIZE && nowMs() < deadline) {
    const { ids, nextCursor: pageCursor } = await fetchCandidatePage(cursor)
    if (ids.length === 0) {
      sourceExhausted = true
      break
    }

    const [targets, valuations, supply] = await Promise.all([
      fetchTargets(ids),
      getValuationsBatch({ catalogModelIds: ids, asOf }),
      fetchSupplyByModel(ids),
    ])
    const targetById = new Map(targets.map((t) => [t.id, t]))

    for (const id of ids) {
      const target = targetById.get(id)
      const valuation = valuations.get(id)
      if (target && valuation) {
        const s = supply.get(id) ?? { lowestAskCents: null, availableCopies: 0 }
        const row: AdminPricingRow = {
          catalogModelId: id,
          brand: target.brand,
          name: target.name,
          series: target.series,
          year: target.year,
          valuation,
          ...s,
        }
        if (!filter || matchesFilter(row, filter)) matches.push(row)
      }
      lastProcessedId = id
    }

    if (pageCursor === null) {
      sourceExhausted = true
      break
    }
    cursor = pageCursor
  }

  return { items: matches, nextCursor: sourceExhausted ? null : lastProcessedId }
}
