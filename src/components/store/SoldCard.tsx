import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import type { PublicSoldItem } from '@/lib/marketplaceMerchandising'
import { formatDate } from '@/lib/formatDate'

export function SoldCard({ item }: { item: PublicSoldItem }) {
  const name = `${item.catalogBrand} ${item.catalogName}${item.catalogYear ? ` (${item.catalogYear})` : ''}`
  const soldDate = formatDate(item.soldAt, { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white">
      <div className="aspect-square overflow-hidden relative">
        <PhotoThumbnail photoUrl={item.photoUrl} alt={name} size="fill" />
        <div className="absolute top-2 left-2 bg-gray-900 text-white text-xs px-2 py-0.5 rounded">
          Sold
        </div>
      </div>
      <div className="p-4">
        <p className="font-medium text-gray-900 leading-snug line-clamp-2 text-sm">{name}</p>
        {item.catalogSeries && (
          <p className="text-xs text-gray-500 mt-0.5">{item.catalogSeries}</p>
        )}
        <p className="text-xs text-gray-400 mt-2">{soldDate}</p>
      </div>
    </div>
  )
}
