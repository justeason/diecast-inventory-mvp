import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'
import { getCatalogDiscovery, CATALOG_PAGE_SIZE } from '@/lib/catalogDiscoveryQuery'
import { getValuationsBatch, type ValuationResult } from '@/lib/marketValuation'
import { logger } from '@/lib/serverLogger'
import { CatalogSearchBar } from '@/components/store/CatalogSearchBar'
import { CatalogModelCard } from '@/components/store/CatalogModelCard'
import { Pagination } from '@/components/shared/Pagination'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Market | CollectNTrades',
  description: 'Browse the full collectible catalog, see what’s available, and track what you want or own.',
}

// 20A: the unified Market discovery surface — every CatalogModel is
// discoverable here regardless of active Listing count (16J), now with
// available-first ranking (§19/§21), an Available Now filter, and the same
// Want/Own/Sell actions /browse and /catalog/[id] already offer. Distinct from
// /browse (Listing-centric purchasable inventory, unchanged) and /market
// (curated Trending/Fast Movers/Recently Sold merchandising, unchanged) — this
// route is the encyclopedia-style whole-catalog view, not either of those.
export default async function CatalogDiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; brand?: string; year?: string; page?: string; availableNow?: string }>
}) {
  const { q, brand, year, page: rawPage, availableNow: rawAvailableNow } = await searchParams
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1', 10) || 1)
  const availableNow = rawAvailableNow === '1'

  const result = await getCatalogDiscovery({ q, brand, year, page: requestedPage, availableNow })

  // 20A §11: batched, never per-card — same helper /browse and /catalog/[id]
  // already use. Never queried for anonymous visitors.
  const session = await getBuyerSession()
  const modelIds = result.models.map((m) => m.id)
  const relationshipMap = session ? await getCatalogRelationshipState(session.profileId, modelIds) : null

  // 29B: search/filter/sort/paginate happens above THIS line — modelIds is
  // already the exact visible page. Batch-value only those IDs, at one shared
  // asOf, using the same canonical getValuationsBatch as Portfolio (25B). A
  // thrown error here is isolated to this optional enrichment only — it must
  // never take down catalog identity/listing/relationship rendering.
  const asOf = new Date()
  let valuationByModel: Map<string, ValuationResult> | null = null
  try {
    valuationByModel = await getValuationsBatch({ catalogModelIds: modelIds, asOf })
  } catch (err) {
    logger.error('catalog_discovery_valuation_batch_failed', err, { route: '/catalog' })
    valuationByModel = null
  }

  const paginationParams: Record<string, string> = {}
  if (q?.trim()) paginationParams.q = q.trim()
  if (brand?.trim()) paginationParams.brand = brand.trim()
  if (year?.trim()) paginationParams.year = year.trim()
  if (availableNow) paginationParams.availableNow = '1'

  const hasActiveFilters = !!(q?.trim() || brand?.trim() || year?.trim() || availableNow)

  const paramsWithoutAvailableNow = new URLSearchParams(paginationParams)
  paramsWithoutAvailableNow.delete('availableNow')
  const clearAvailableNowQs = paramsWithoutAvailableNow.toString()
  const clearAvailableNowHref = clearAvailableNowQs ? `/catalog?${clearAvailableNowQs}` : '/catalog'

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Market</h1>
        <p className="mt-1 text-sm text-gray-500">
          Browse the full collectible catalog, see what&rsquo;s available, and track what you want or own.{' '}
          <Link href="/capture" className="text-gray-700 underline underline-offset-2">
            Identify from photo
          </Link>
        </p>
      </div>

      <CatalogSearchBar q={q} brand={brand} year={year} availableNow={availableNow} brands={result.brands} />

      {/* 20B §23: small, query-echoing result-context line — plain text, no
          HTML injection (q is rendered as normal React text), no relevance
          badges. Only shown when a search was actually performed. */}
      {q?.trim() && (
        <p className="mb-4 text-sm text-gray-500">
          {result.totalCount} {result.totalCount === 1 ? 'model' : 'models'} for &ldquo;{q.trim()}&rdquo;
        </p>
      )}

      {result.models.length === 0 ? (
        <div className="py-12 text-center space-y-2">
          {availableNow ? (
            <>
              <p className="text-sm text-gray-500">No available models match your filters.</p>
              <p className="text-sm text-gray-400">
                Try{' '}
                <Link href={clearAvailableNowHref} className="text-gray-700 underline underline-offset-2">
                  clearing Available Now
                </Link>{' '}
                or{' '}
                <Link href="/catalog" className="text-gray-700 underline underline-offset-2">
                  clearing all filters
                </Link>
                .
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500">No models found.</p>
              {hasActiveFilters && (
                <p className="text-sm text-gray-400">
                  Try adjusting your search or{' '}
                  <Link href="/catalog" className="text-gray-700 underline underline-offset-2">
                    clear all filters
                  </Link>
                  .
                </p>
              )}
            </>
          )}
          <p className="text-sm text-gray-400">
            Or{' '}
            <Link href="/capture" className="text-gray-700 underline underline-offset-2">
              try a photo
            </Link>
            .
          </p>
        </div>
      ) : (
        <section aria-labelledby="catalog-results-heading">
          <h2 id="catalog-results-heading" className="sr-only">
            Catalog results
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6">
            {result.models.map((model) => (
              <CatalogModelCard
                key={model.id}
                model={model}
                availability={result.availabilityByModel.get(model.id) ?? { count: 0, lowestPrice: null }}
                relationship={relationshipMap?.get(model.id) ?? null}
                marketValuation={valuationByModel?.get(model.id) ?? null}
              />
            ))}
          </div>
        </section>
      )}

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        totalCount={result.totalCount}
        pageSize={CATALOG_PAGE_SIZE}
        basePath="/catalog"
        params={paginationParams}
      />
    </>
  )
}
