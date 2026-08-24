import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'
import { getCatalogModelHub, LISTING_PAGE_SIZE } from '@/lib/catalogModelHubQuery'
import { getCatalogValuation } from '@/lib/advancedValuationQuery'
import type { AdvancedConfidence } from '@/lib/advancedValuation'
import { CatalogModelActions } from '@/components/store/CatalogModelActions'
import { CatalogListingOption } from '@/components/store/CatalogListingOption'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'

export const dynamic = 'force-dynamic'

// 16H: the canonical public CatalogModel customer hub. /browse/[id] is a Listing
// detail page (keyed by Listing.id, one physical item) — this is the first
// customer-facing route keyed by CatalogModel.id. Public: no session required to
// view identity/Listings/valuation.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const model = await prisma.catalogModel.findUnique({
    where: { id },
    select: { brand: true, name: true, year: true },
  })
  if (!model) return { title: 'CollectNTrades' }
  const title = `${model.brand} ${model.name}${model.year ? ` (${model.year})` : ''} | CollectNTrades`
  return { title }
}

function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

const CONFIDENCE_LABELS: Record<AdvancedConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  insufficient: 'Not enough sales data yet',
}

export default async function CatalogModelHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ cursor?: string }>
}) {
  const { id } = await params
  const { cursor } = await searchParams

  const hub = await getCatalogModelHub(id, cursor)
  if (!hub) notFound()

  // 16H Part AB: one narrowly-scoped relationship lookup for this single model —
  // reuses the exact 16F batched query (with a one-element id array), never a
  // second engine. Never queried for anonymous visitors.
  const session = await getBuyerSession()
  const relationshipMap = session ? await getCatalogRelationshipState(session.profileId, [id]) : null
  const relationship = relationshipMap?.get(id) ?? null

  // 16H Part N: one model-level valuation call (14C, already batching internally —
  // 3 queries total regardless of Listing count), never per-Listing.
  const valuation = await getCatalogValuation(id)

  const modelName = `${hub.model.brand} ${hub.model.name}`
  const hasListings = hub.listings.length > 0

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <Link href="/browse" className="text-sm text-gray-500 hover:text-gray-900">
          ← Browse
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

      {/* 16H Part N/O: truthful valuation — never $0 for unknown, exact existing
          14C terminology/confidence semantics, single model-level call above. */}
      {valuation.estimatedValue !== null ? (
        <section className="mb-8 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Market</h2>
          <p className="text-lg font-semibold text-gray-900">
            {centsToDisplay(valuation.estimatedValue)}
            {valuation.lowEstimate !== null && valuation.highEstimate !== null && (
              <span className="text-sm font-normal text-gray-500">
                {' '}({centsToDisplay(valuation.lowEstimate)}–{centsToDisplay(valuation.highEstimate)})
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {CONFIDENCE_LABELS[valuation.confidence]} · based on completed CollectNTrades sales, not an appraisal
          </p>
        </section>
      ) : (
        <section className="mb-8 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Market</h2>
          <p className="text-sm text-gray-400">{CONFIDENCE_LABELS.insufficient}</p>
        </section>
      )}

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
            {hub.nextCursor && (
              <div className="mt-6">
                <Link
                  href={`/catalog/${id}?cursor=${encodeURIComponent(hub.nextCursor)}`}
                  className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
                >
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
