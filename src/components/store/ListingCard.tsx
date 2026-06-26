import Link from 'next/link'
import { AddToCartButton } from './AddToCartButton'
import type { CartItem } from '@/lib/cart'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

type Props = {
  listing: {
    id: string
    title: string
    price: number
    item: {
      sku: string
      cardedOrLoose: string
      condition: string
      catalog: {
        brand: string
        name: string
        year: number | null
        series: string | null
        color: string | null
      }
    }
  }
}

export function ListingCard({ listing }: Props) {
  const { item } = listing
  const { catalog } = item

  const cartItem: CartItem = {
    listingId: listing.id,
    title: listing.title,
    price: listing.price,
    sku: item.sku,
    condition: item.condition,
    cardedOrLoose: item.cardedOrLoose,
  }

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white hover:border-gray-400 transition-colors">
      <Link href={`/browse/${listing.id}`} className="group block">
        <div className="aspect-square bg-gray-100 flex items-center justify-center">
          <span className="text-gray-400 text-sm">No photo</span>
        </div>

        <div className="p-4 pb-3">
          <h3 className="font-medium text-gray-900 group-hover:text-black leading-snug line-clamp-2">
            {listing.title}
          </h3>
          <p className="text-xl font-bold mt-1">${listing.price.toFixed(2)}</p>

          <div className="mt-3 space-y-0.5 text-xs text-gray-500">
            <p className="font-mono">{item.sku}</p>
            <p>
              {catalog.brand} {catalog.name}
              {catalog.year ? ` (${catalog.year})` : ''}
            </p>
            {catalog.series && <p>{catalog.series}</p>}
            {catalog.color && <p>{catalog.color}</p>}
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100 flex gap-2 text-xs text-gray-500">
            <span>{CONDITION_LABELS[item.condition] ?? item.condition}</span>
            <span>·</span>
            <span>{item.cardedOrLoose === 'carded' ? 'Carded' : 'Loose'}</span>
          </div>
        </div>
      </Link>

      <div className="px-4 pb-4">
        <AddToCartButton item={cartItem} />
      </div>
    </div>
  )
}
