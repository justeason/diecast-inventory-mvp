import Link from 'next/link'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'

type Props = {
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  photoUrl: string | null
  primaryMetric: { label: string; value: string }
  secondaryMetric?: { label: string; value: string }
}

export function CatalogSummaryCard({
  catalogBrand,
  catalogName,
  catalogYear,
  catalogSeries,
  photoUrl,
  primaryMetric,
  secondaryMetric,
}: Props) {
  const name = `${catalogBrand} ${catalogName}${catalogYear ? ` (${catalogYear})` : ''}`
  const browseHref = `/browse?brand=${encodeURIComponent(catalogBrand)}&q=${encodeURIComponent(catalogName)}`

  return (
    <Link href={browseHref} className="block rounded-lg border border-gray-200 overflow-hidden bg-white hover:border-gray-400 transition-colors">
      <div className="aspect-square overflow-hidden relative">
        <PhotoThumbnail photoUrl={photoUrl} alt={name} size="fill" />
      </div>
      <div className="p-4">
        <p className="font-medium text-gray-900 leading-snug line-clamp-2 text-sm">{name}</p>
        {catalogSeries && <p className="text-xs text-gray-500 mt-0.5">{catalogSeries}</p>}
        <div className="mt-2 space-y-0.5">
          <p className="text-sm font-semibold text-gray-900">{primaryMetric.value}</p>
          <p className="text-xs text-gray-500">{primaryMetric.label}</p>
          {secondaryMetric && (
            <p className="text-xs text-gray-400">
              {secondaryMetric.value} {secondaryMetric.label}
            </p>
          )}
        </div>
      </div>
    </Link>
  )
}
