import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'
import { getCatalogModelHub, LISTING_PAGE_SIZE } from '@/lib/catalogModelHubQuery'
import { getMarketSaleHistory } from '@/lib/marketSaleQuery'
import { getMarketQuote } from '@/lib/marketQuoteQuery'
import { isValidPackagingType, findPackagingMarketVariant, type PackagingType } from '@/lib/marketVariant'
import { CatalogModelActions } from '@/components/store/CatalogModelActions'
import { CatalogListingOption } from '@/components/store/CatalogListingOption'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { MarketSnapshot } from '@/components/store/MarketSnapshot'
import { PriceHistoryChart } from '@/components/store/PriceHistoryChart'
import { RecentSalesList } from '@/components/store/RecentSalesList'

export const dynamic = 'force-dynamic'

const VARIANT_LABELS: Record<'all' | PackagingType, string> = {
  all: 'All',
  carded: 'Carded',
  loose: 'Loose',
}

const HISTORY_LIMIT = 500

// 24B: the canonical public Market Model Page. 16H established this as the
// first customer-facing route keyed by CatalogModel.id; 24B replaces this
// page's customer-facing EMV with 23B's canonical valuation engine — no other
// (legacy or admin-facing) engine is consulted here — and adds a Market
// Snapshot + Price History, composed from focused 22B/23B primitives.
// Public: no session required to view identity/Listings/valuation.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const model = await prisma.catalogModel.findUnique({
    where: { id },
    select: { brand: true, name: true, year: true, series: true },
  })
  if (!model) return { title: 'CollectNTrades' }
  const title = `${model.brand} ${model.name}${model.year ? ` (${model.year})` : ''} | CollectNTrades`
  // §48: stable identity language only — never EMV/ask/sale amounts, which
  // change far more often than a cached description should imply.
  const description = `Explore details, market activity, and available listings for the ${model.brand} ${model.name}${
    model.series ? ` — ${model.series}` : ''
  } on CollectNTrades.`
  return { title, description }
}

export default async function CatalogModelHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ cursor?: string; variant?: string }>
}) {
  const { id } = await params
  const { cursor, variant } = await searchParams

  // §5/§81: never trust a raw MarketVariant id from the public query string —
  // resolve a stable packaging slug server-side. An invalid/unrecognized value
  // silently falls back to All rather than erroring.
  const requestedPackaging = isValidPackagingType(variant) ? variant : null
  const resolvedVariant = requestedPackaging ? await findPackagingMarketVariant(prisma, id, requestedPackaging) : null
  const marketVariantId = resolvedVariant?.id ?? null
  const selectedVariant: 'all' | PackagingType = marketVariantId ? requestedPackaging! : 'all'
  const variantFilter = marketVariantId ? { marketVariantId } : {}

  const hub = await getCatalogModelHub(id, cursor, marketVariantId ?? undefined)
  if (!hub) notFound()

  const asOf = new Date()

  // 16H Part AB, reused: one narrowly-scoped relationship lookup for this
  // single model. §51: session and every independent market-data query run in
  // parallel; relationship state depends on session, so it follows sequentially.
  const [session, quote, history] = await Promise.all([
    getBuyerSession(),
    getMarketQuote({ catalogModelId: id, ...variantFilter, asOf, includeLastSale: true }),
    getMarketSaleHistory({ catalogModelId: id, ...variantFilter, endDate: asOf, limit: HISTORY_LIMIT }),
  ])
  const { valuation, askSummary, lastMarketSale, lastInternalSale } = quote
  const relationshipMap = session ? await getCatalogRelationshipState(session.profileId, [id]) : null
  const relationship = relationshipMap?.get(id) ?? null

  const modelName = `${hub.model.brand} ${hub.model.name}`
  const hasListings = hub.listings.length > 0

  // §6/§42: variant links never carry the listing cursor; the listing
  // pagination link always carries the currently selected variant.
  const variantHref = (v: 'all' | PackagingType) => (v === 'all' ? `/catalog/${id}` : `/catalog/${id}?variant=${v}`)
  const nextPageHref = hub.nextCursor
    ? `/catalog/${id}?${selectedVariant !== 'all' ? `variant=${selectedVariant}&` : ''}cursor=${encodeURIComponent(hub.nextCursor)}`
    : null

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex flex-wrap gap-x-4 gap-y-1">
        <Link href="/catalog" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Catalog
        </Link>
        <Link href="/browse" className="text-sm text-gray-500 hover:text-gray-900">
          ← Browse Listings
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row gap-6 mb-8">
        <div className="w-32 h-32 shrink-0 rounded-md overflow-hidden border border-gray-200 bg-gray-50 relative">
          <PhotoThumbnail photoUrl={hub.model.photoUrl} alt={modelName} size="fill" />
        </div>

        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 leading-snug">
            {modelName}
            {hub.model.year && <span className="font-normal text-gray-500"> ({hub.model.year})</span>}
          </h1>
          <div className="mt-1 space-y-0.5 text-sm text-gray-500">
            {hub.model.series && <p>{hub.model.series}</p>}
            {(hub.model.color || hub.model.scale) && (
              <p>{[hub.model.color, hub.model.scale].filter(Boolean).join(' · ')}</p>
            )}
          </div>

          <div className="mt-4">
            <CatalogModelActions catalogModelId={id} modelName={modelName} relationship={relationship} />
          </div>
        </div>
      </div>

      <nav aria-label="Market view" className="mb-4 flex items-center gap-2 text-sm">
        <span className="text-gray-500">Viewing:</span>
        {(['all', 'carded', 'loose'] as const).map((v) => {
          const active = selectedVariant === v
          return (
            <Link
              key={v}
              href={variantHref(v)}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white'
                  : 'rounded-md border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50'
              }
            >
              {VARIANT_LABELS[v]}
            </Link>
          )
        })}
      </nav>

      <MarketSnapshot
        valuation={valuation}
        lastMarketSale={lastMarketSale}
        lastInternalSale={lastInternalSale}
        askSummary={askSummary}
        listingsAnchorHref="#available-listings"
      />

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Price History</h2>
        {history.observations.length > 0 ? (
          <div className="space-y-4">
            <PriceHistoryChart points={history.observations} />
            <RecentSalesList observations={history.observations} />
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-gray-300 px-6 py-8 text-center">
            <p className="text-sm text-gray-500">No completed sales recorded yet.</p>
          </div>
        )}
      </section>

      <section id="available-listings" aria-labelledby="available-copies-heading">
        <h2 id="available-copies-heading" className="text-sm font-semibold text-gray-900 mb-1">
          Available Copies
        </h2>

        {hasListings ? (
          <>
            <p className="text-sm text-gray-500 mb-4">
              {hub.listingCount} {hub.listingCount === 1 ? 'copy' : 'copies'} available
              {hub.lowestPrice !== null && <> <span aria-hidden="true">·</span> Lowest price ${hub.lowestPrice.toFixed(2)}</>}
            </p>
            <ul className="divide-y divide-gray-200 border border-gray-200 rounded-md">
              {hub.listings.map((listing, index) => (
                <li key={listing.id}>
                  <CatalogListingOption listing={listing} modelName={modelName} index={index} />
                </li>
              ))}
            </ul>
            {nextPageHref && (
              <div className="mt-6">
                <Link href={nextPageHref} className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2">
                  Show more (next {LISTING_PAGE_SIZE}) →
                </Link>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-md border border-dashed border-gray-300 px-6 py-8 text-center">
            <p className="text-sm text-gray-500">No copies currently available.</p>
            {session && !relationship?.wanted && (
              <p className="text-sm text-gray-400 mt-1">Want this model to keep track of it.</p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
