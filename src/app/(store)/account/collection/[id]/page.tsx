import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { deleteCollectionItem } from '@/lib/actions/collectionItems'
import { deleteCollectionPhoto } from '@/lib/actions/collectionPhotos'
import { CollectionPhotoUpload } from '@/components/store/CollectionPhotoUpload'
import { CollectionAiScan } from '@/components/store/CollectionAiScan'
import { CatalogSuggestionForm } from '@/components/store/CatalogSuggestionForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Collection Item | CollectNTrades',
  robots: { index: false, follow: false },
}

const CONDITION_LABELS: Record<string, string> = {
  mint:      'Mint',
  near_mint: 'Near Mint',
  good:      'Good',
  fair:      'Fair',
  poor:      'Poor',
  damaged:   'Damaged',
}

const CONDITION_COLORS: Record<string, string> = {
  mint:      'bg-green-100 text-green-700',
  near_mint: 'bg-blue-100 text-blue-700',
  good:      'bg-gray-100 text-gray-700',
  fair:      'bg-yellow-100 text-yellow-700',
  poor:      'bg-orange-100 text-orange-700',
  damaged:   'bg-red-100 text-red-700',
}

const CARDED_LOOSE_LABELS: Record<string, string> = {
  carded: 'Carded',
  loose:  'Loose',
}

const PHOTO_TYPE_LABELS: Record<string, string> = {
  front:  'Front',
  back:   'Back',
  detail: 'Detail',
  other:  'Other',
}

function displayName(item: {
  brand: string | null
  name: string | null
  catalog: { brand: string; name: string } | null
}): string {
  if (item.catalog) return `${item.catalog.brand} ${item.catalog.name}`
  const parts = [item.brand, item.name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Unnamed item'
}

export default async function CollectionItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getBuyerSession()
  if (!session) notFound()

  const item = await prisma.collectionItem.findFirst({
    where: { id, profileId: session.profileId },
    include: {
      catalog: { select: { id: true, brand: true, name: true, year: true, color: true, series: true, scale: true } },
      photos:  { orderBy: { sortOrder: 'asc' } },
      catalogSuggestions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, status: true, adminNotes: true },
      },
    },
  })
  if (!item) notFound()

  const deleteItemAction = deleteCollectionItem.bind(null, item.id)

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link href="/account/collection" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to My Collection
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 leading-tight">
          {displayName(item)}
        </h1>
        <Link
          href={`/account/collection/${item.id}/edit`}
          className="shrink-0 ml-4 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Edit
        </Link>
      </div>

      {/* Condition/type badges */}
      <div className="flex flex-wrap gap-2 mb-6">
        {item.condition && (
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${CONDITION_COLORS[item.condition] ?? 'bg-gray-100 text-gray-600'}`}
          >
            {CONDITION_LABELS[item.condition] ?? item.condition}
          </span>
        )}
        {item.cardedOrLoose && (
          <span className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium bg-gray-100 text-gray-700">
            {CARDED_LOOSE_LABELS[item.cardedOrLoose] ?? item.cardedOrLoose}
          </span>
        )}
      </div>

      {/* Photos section */}
      <div className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Photos</h2>

        {item.photos.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            {item.photos.map((photo) => (
              <div key={photo.id} className="relative group rounded-md overflow-hidden border border-gray-200 bg-gray-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={PHOTO_TYPE_LABELS[photo.type] ?? photo.type}
                  className="w-full aspect-square object-cover"
                />
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-black/50 px-2 py-1">
                  <span className="text-xs text-white">
                    {PHOTO_TYPE_LABELS[photo.type] ?? photo.type}
                  </span>
                  <form action={deleteCollectionPhoto.bind(null, photo.id)}>
                    <button
                      type="submit"
                      className="text-xs text-white/80 hover:text-white transition-colors"
                      title="Delete photo"
                    >
                      ✕
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}

        {item.photos.length < 3 ? (
          <CollectionPhotoUpload itemId={item.id} />
        ) : (
          <p className="text-xs text-gray-400">Maximum of 3 photos reached.</p>
        )}
      </div>

      {/* AI scan section */}
      <CollectionAiScan
        itemId={item.id}
        hasPhotos={item.photos.length > 0}
        aiExtractionConfidence={item.aiExtractionConfidence}
        aiExtractionNotes={item.aiExtractionNotes}
        aiExtractedAt={item.aiExtractedAt}
      />

      {/* Catalog suggestion — only when no catalog match yet */}
      {!item.catalogId && (
        <CatalogSuggestionForm
          itemId={item.id}
          brand={item.brand}
          name={item.name}
          series={item.series}
          year={item.year}
          color={item.color}
          scale={item.scale}
          latestSuggestion={item.catalogSuggestions[0] ?? null}
        />
      )}

      {/* Item fields */}
      <div className="rounded-md border border-gray-200 bg-gray-50 p-5 mb-6">
        <dl className="space-y-2.5 text-sm">
          {item.catalog && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Catalog match</dt>
              <dd className="text-gray-900">
                {item.catalog.brand} {item.catalog.name}
                {item.catalog.year && ` (${item.catalog.year})`}
              </dd>
            </div>
          )}
          {item.brand && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Brand</dt>
              <dd className="text-gray-900">{item.brand}</dd>
            </div>
          )}
          {item.name && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Model</dt>
              <dd className="text-gray-900">{item.name}</dd>
            </div>
          )}
          {item.year && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Year</dt>
              <dd className="text-gray-900">{item.year}</dd>
            </div>
          )}
          {item.series && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Series</dt>
              <dd className="text-gray-900">{item.series}</dd>
            </div>
          )}
          {item.color && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Color</dt>
              <dd className="text-gray-900">{item.color}</dd>
            </div>
          )}
          {item.scale && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Scale</dt>
              <dd className="text-gray-900">{item.scale}</dd>
            </div>
          )}
          {item.conditionNotes && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Condition notes</dt>
              <dd className="text-gray-900">{item.conditionNotes}</dd>
            </div>
          )}
          <div className="flex gap-3">
            <dt className="text-gray-500 w-28 shrink-0">Quantity</dt>
            <dd className="text-gray-900">{item.quantity}</dd>
          </div>
          {item.purchasePrice != null && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Purchase price</dt>
              <dd className="text-gray-900">${item.purchasePrice.toFixed(2)}</dd>
            </div>
          )}
          {item.purchaseDate && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Purchase date</dt>
              <dd className="text-gray-900">{item.purchaseDate.toLocaleDateString()}</dd>
            </div>
          )}
          {item.notes && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Notes</dt>
              <dd className="text-gray-900 whitespace-pre-wrap">{item.notes}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* Timestamps */}
      <p className="text-xs text-gray-400 mb-8">
        Added {item.createdAt.toLocaleDateString()}
        {item.updatedAt > item.createdAt && ` · Updated ${item.updatedAt.toLocaleDateString()}`}
      </p>

      {/* Delete item */}
      <div className="pt-6 border-t border-gray-200">
        <p className="text-sm font-medium text-gray-700 mb-1">Remove from collection</p>
        <p className="text-xs text-gray-500 mb-3">
          This will permanently delete this item and all its photos. This cannot be undone.
        </p>
        <form action={deleteItemAction}>
          <button
            type="submit"
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
          >
            Delete item
          </button>
        </form>
      </div>
    </div>
  )
}
