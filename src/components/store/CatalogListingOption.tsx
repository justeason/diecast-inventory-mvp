import Link from 'next/link'
import { AddToCartButton } from './AddToCartButton'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import type { CartItem } from '@/lib/cart'
import type { CatalogModelHubListing } from '@/lib/catalogModelHubQuery'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

type Props = {
  listing: CatalogModelHubListing
  modelName: string
  index: number
}

// 16I: one physical Listing = one purchase choice on the CatalogModel hub. Distinct
// from ListingCard (the /browse and /market grid card, left untouched) — this is a
// compact comparison row for choosing among copies of the SAME model, where model
// identity already appears once above (CatalogModelActions). No Want/Collection/
// Sell here — those are model-level. No second Buy implementation: AddToCartButton
// and the exact CartItem shape are reused verbatim, targeting this exact listing.id.
export function CatalogListingOption({ listing, modelName, index }: Props) {
  const { item } = listing
  const photo = item.photos[0]
  const conditionLabel = CONDITION_LABELS[item.condition] ?? item.condition
  const packagingLabel = item.cardedOrLoose === 'carded' ? 'Carded' : 'Loose'
  // Distinguishes visually-identical copies (Part T/S) without exposing the raw
  // Listing id as a visible/accessible label.
  const copyLabel = `${modelName} — copy ${index + 1}: $${listing.price.toFixed(2)}, ${packagingLabel}, ${conditionLabel}`

  const cartItem: CartItem = {
    listingId: listing.id,
    title: listing.title,
    price: listing.price,
    sku: item.sku,
    condition: item.condition,
    cardedOrLoose: item.cardedOrLoose,
    photoUrl: photo?.url ?? null,
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 px-4 py-4">
      <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
        <div className="w-14 h-14 shrink-0 rounded overflow-hidden border border-gray-200 bg-gray-50 relative">
          <PhotoThumbnail photoUrl={photo?.url ?? null} alt={copyLabel} size="fill" />
        </div>
        <div className="min-w-0">
          <p className="text-lg font-bold text-gray-900">${listing.price.toFixed(2)}</p>
          <p className="text-sm text-gray-500">
            {packagingLabel} <span aria-hidden="true">·</span> {conditionLabel}
          </p>
        </div>
      </div>

      <div className="flex gap-2 sm:w-56 sm:shrink-0">
        <Link
          href={`/browse/${listing.id}`}
          aria-label={`View copy details — ${copyLabel}`}
          className="flex-1 sm:flex-none inline-flex items-center justify-center rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
        >
          View Copy
        </Link>
        <div className="flex-1">
          <AddToCartButton item={cartItem} />
        </div>
      </div>
    </div>
  )
}
