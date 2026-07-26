'use client'

import { useRouter } from 'next/navigation'
import { CatalogModelSearch } from '@/components/shared/CatalogModelSearch'
import { type CatalogSearchResult, formatCatalogResult } from '@/lib/catalogFormat'

type Props = {
  selectedModelId?: string
  selectedModelLabel?: string
}

export function ResaleEstimatorForm({ selectedModelId, selectedModelLabel }: Props) {
  const router = useRouter()

  function handleSelect(m: CatalogSearchResult | null) {
    if (m) router.push(`/admin/resale-estimator?catalogId=${m.id}`)
    else router.push('/admin/resale-estimator')
  }

  return (
    <div className="mb-8 max-w-md">
      <label className="block text-sm font-medium text-gray-700 mb-2">Select Catalog Model</label>
      <CatalogModelSearch
        key={selectedModelId ?? 'none'}
        name="catalogId"
        defaultValue={selectedModelId ?? ''}
        defaultLabel={selectedModelLabel ?? ''}
        onSelect={handleSelect}
        placeholder="Search by brand, name, year, color…"
      />
    </div>
  )
}

export function formatModelForSearch(m: {
  id: string
  brand: string
  name: string
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
}): string {
  return formatCatalogResult(m)
}
