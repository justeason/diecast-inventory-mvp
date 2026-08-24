import type { Metadata } from 'next'
import Link from 'next/link'
import { getCatalogDiscovery, CATALOG_PAGE_SIZE } from '@/lib/catalogDiscoveryQuery'
import { CatalogSearchBar } from '@/components/store/CatalogSearchBar'
import { CatalogModelCard } from '@/components/store/CatalogModelCard'
import { Pagination } from '@/components/shared/Pagination'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Model Catalog | CollectNTrades',
  description: 'Explore every model in the CollectNTrades catalog, including models not currently for sale.',
}

// 16J: the canonical public CatalogModel discovery surface — every CatalogModel
// row is discoverable here regardless of active Listing count (Part D). Distinct
// from /browse (Listing-centric marketplace inventory), which is intentionally
// left unchanged. Anonymous and authenticated visitors see the exact same query —
// no relationship state (Want/Own/Sell) is fetched here; that stays on
// /catalog/[id] (16H), keeping this route free of any private per-visitor query.
export default async function CatalogDiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; brand?: string; year?: string; page?: string }>
}) {
  const { q, brand, year, page: rawPage } = await searchParams
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1', 10) || 1)

  const result = await getCatalogDiscovery({ q, brand, year, page: requestedPage })

  const paginationParams: Record<string, string> = {}
  if (q?.trim()) paginationParams.q = q.trim()
  if (brand?.trim()) paginationParams.brand = brand.trim()
  if (year?.trim()) paginationParams.year = year.trim()

  const hasActiveFilters = !!(q?.trim() || brand?.trim() || year?.trim())

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Model Catalog</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every model we track — including ones not currently for sale.
        </p>
      </div>

      <CatalogSearchBar q={q} brand={brand} year={year} brands={result.brands} />

      {result.models.length === 0 ? (
        <div className="py-12 text-center space-y-2">
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
