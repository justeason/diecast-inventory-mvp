import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { AddToCartButton } from '@/components/store/AddToCartButton'
import { PhotoGallery } from '@/components/store/PhotoGallery'
import type { CartItem } from '@/lib/cart'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const listing = await prisma.listing.findUnique({
    where: { id },
    include: {
      item: {
        select: {
          sku: true,
          status: true,
          cardedOrLoose: true,
          condition: true,
          conditionNotes: true,
          catalog: {
            select: {
              brand: true,
              name: true,
              year: true,
              series: true,
              color: true,
              scale: true,
            },
          },
          photos: {
            select: { url: true, type: true, sortOrder: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  })

  if (!listing || listing.status !== 'active' || listing.item.status !== 'available') notFound()

  const { item } = listing
  const { catalog } = item
  const photos = item.photos

  const mainPhotoUrl = photos.find((p) => p.type === 'front')?.url ?? photos[0]?.url ?? null

  const cartItem: CartItem = {
    listingId: listing.id,
    title: listing.title,
    price: listing.price,
    sku: item.sku,
    condition: item.condition,
    cardedOrLoose: item.cardedOrLoose,
    photoUrl: mainPhotoUrl,
  }

  return (
    <>
      <div className="mb-6">
        <Link href="/browse" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Browse
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        {/* Photo gallery */}
        <PhotoGallery photos={photos} title={listing.title} />

        <div>
          <h1 className="text-2xl font-bold text-gray-900 leading-snug">{listing.title}</h1>
          <p className="text-3xl font-bold mt-2">${listing.price.toFixed(2)}</p>

          <div className="mt-4">
            <AddToCartButton item={cartItem} />
            <p className="mt-3 text-xs text-gray-500 leading-relaxed">
              Adding to cart starts an order request — no payment is taken now. We&apos;ll follow
              up by email to confirm availability and arrange combined shipping.
            </p>
          </div>

          {listing.description && (
            <p className="mt-4 text-gray-700 text-sm leading-relaxed">{listing.description}</p>
          )}

          <div className="mt-6 border-t border-gray-200 pt-6">
            <h2 className="font-semibold text-gray-900 mb-4">Item Details</h2>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-gray-500">SKU</dt>
              <dd className="font-mono text-xs">{item.sku}</dd>

              <dt className="text-gray-500">Brand</dt>
              <dd>{catalog.brand}</dd>

              <dt className="text-gray-500">Model</dt>
              <dd>{catalog.name}</dd>

              {catalog.year && (
                <>
                  <dt className="text-gray-500">Year</dt>
                  <dd>{catalog.year}</dd>
                </>
              )}
              {catalog.series && (
                <>
                  <dt className="text-gray-500">Series</dt>
                  <dd>{catalog.series}</dd>
                </>
              )}
              {catalog.color && (
                <>
                  <dt className="text-gray-500">Color</dt>
                  <dd>{catalog.color}</dd>
                </>
              )}
              {catalog.scale && (
                <>
                  <dt className="text-gray-500">Scale</dt>
                  <dd>{catalog.scale}</dd>
                </>
              )}

              <dt className="text-gray-500">Condition</dt>
              <dd>{CONDITION_LABELS[item.condition] ?? item.condition}</dd>

              <dt className="text-gray-500">Type</dt>
              <dd>{item.cardedOrLoose === 'carded' ? 'Carded' : 'Loose'}</dd>
            </dl>

            {item.conditionNotes && (
              <div className="mt-4 rounded-md bg-gray-50 border border-gray-200 p-3">
                <p className="text-xs font-medium text-gray-600 mb-1">Condition Notes</p>
                <p className="text-sm text-gray-700">{item.conditionNotes}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
