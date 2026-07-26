import { prisma } from '@/lib/prisma'
import { fetchComparableSales } from '@/lib/resaleEstimatorQuery'
import { computeEstimate } from '@/lib/resaleEstimator'
import { formatCatalogResult } from '@/lib/catalogFormat'
import { ResaleEstimatorForm } from '@/components/admin/ResaleEstimatorForm'
import { ResaleEstimatorResult } from '@/components/admin/ResaleEstimatorResult'

export const dynamic = 'force-dynamic'

export default async function ResaleEstimatorPage({
  searchParams,
}: {
  searchParams: Promise<{ catalogId?: string }>
}) {
  const { catalogId } = await searchParams

  let model: {
    id: string
    brand: string
    name: string
    series: string | null
    year: number | null
    color: string | null
    scale: string | null
  } | null = null

  let result = null

  if (catalogId) {
    model = await prisma.catalogModel.findUnique({
      where: { id: catalogId },
      select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
    })
    if (model) {
      const comparables = await fetchComparableSales(model)
      result = computeEstimate(model, comparables)
    }
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Resale Estimator</h1>
        <p className="text-sm text-gray-500 mt-1">
          Admin only. Estimates based on completed CollectNTrades sales. No external data.
        </p>
      </div>

      <ResaleEstimatorForm
        selectedModelId={catalogId}
        selectedModelLabel={model ? formatCatalogResult(model) : undefined}
      />

      {catalogId && !model && (
        <p className="text-sm text-red-600">Catalog model not found.</p>
      )}

      {result && model && (
        <ResaleEstimatorResult model={model} result={result} />
      )}
    </>
  )
}
