'use client'

import { useRouter } from 'next/navigation'
import { CatalogModelSearch } from '@/components/shared/CatalogModelSearch'
import type { CatalogSearchResult } from '@/lib/catalogFormat'

export function ValuationSearchForm() {
  const router = useRouter()

  function handleSelect(m: CatalogSearchResult | null) {
    if (m) router.push(`/admin/valuation/models/${m.id}`)
  }

  return (
    <div className="mb-8 max-w-md">
      <label className="block text-sm font-medium text-gray-700 mb-2">Look up a model</label>
      <CatalogModelSearch name="catalogId" onSelect={handleSelect} placeholder="Search by brand, name, year, color…" />
    </div>
  )
}
