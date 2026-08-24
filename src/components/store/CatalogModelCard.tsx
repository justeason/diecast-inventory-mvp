import Link from 'next/link'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import type { CatalogDiscoveryModel, CatalogModelAvailability } from '@/lib/catalogDiscoveryQuery'

type Props = {
  model: CatalogDiscoveryModel
  availability: CatalogModelAvailability
}

// 16J: one CatalogModel = one discovery result. Deliberately not ListingCard —
// that entity boundary (one physical Listing) is wrong here; a model can have zero,
// one, or many purchasable copies. No AddToCart: the customer opens the model hub
// (/catalog/[id]) to choose an actual Listing (16I). No Want/Own/Sell here either —
// those stay on the hub, keeping search results cheap and free of private queries.
export function CatalogModelCard({ model, availability }: Props) {
  const modelName = `${model.brand} ${model.name}`
  const availabilityLabel =
    availability.count === 0
      ? 'No copies currently available'
      : `${availability.count} ${availability.count === 1 ? 'copy' : 'copies'} available`
  const priceLabel = availability.lowestPrice !== null ? ` · From $${availability.lowestPrice.toFixed(2)}` : ''
  const ariaLabel = `${modelName}${model.year ? ` (${model.year})` : ''} — ${availabilityLabel}${priceLabel}`

  return (
    <Link
      href={`/catalog/${model.id}`}
      aria-label={ariaLabel}
      className="block rounded-lg border border-gray-200 bg-white hover:border-gray-400 transition-colors"
    >
      <div className="aspect-square overflow-hidden rounded-t-lg relative">
        <PhotoThumbnail photoUrl={model.photoUrl} alt={modelName} size="fill" />
      </div>

      <div className="p-4">
        <h3 className="font-medium text-gray-900 leading-snug line-clamp-2">
          {modelName}
          {model.year && <span className="text-gray-500 font-normal"> ({model.year})</span>}
        </h3>
        {model.series && <p className="mt-0.5 text-xs text-gray-500 truncate">{model.series}</p>}

        <p className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-700">
          {availabilityLabel}
          {priceLabel && <span className="text-gray-500">{priceLabel}</span>}
        </p>
      </div>
    </Link>
  )
}
