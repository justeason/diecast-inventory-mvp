import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { fetchComparableSales } from '@/lib/resaleEstimatorQuery'
import { computeEstimate } from '@/lib/resaleEstimator'
import type { Confidence } from '@/lib/resaleEstimator'

const CONFIDENCE_COLORS: Record<Confidence, string> = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-blue-100 text-blue-800',
  low: 'bg-yellow-100 text-yellow-800',
  insufficient: 'bg-gray-100 text-gray-600',
}

function usd(cents: number | null): string {
  if (cents === null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

export async function ResaleEstimatorPanel({ catalogId }: { catalogId: string }) {
  const model = await prisma.catalogModel.findUnique({
    where: { id: catalogId },
    select: { id: true, brand: true, name: true, series: true, year: true },
  })
  if (!model) return null

  const comparables = await fetchComparableSales(model)
  const result = computeEstimate(model, comparables)

  const hasEstimate = result.estimatedPrice !== null

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <p className="font-semibold text-gray-700">Resale Estimate</p>
        <Link
          href={`/admin/resale-estimator?catalogId=${catalogId}`}
          className="text-xs text-blue-600 hover:underline"
        >
          Full estimator →
        </Link>
      </div>
      {hasEstimate ? (
        <div className="flex flex-wrap gap-4 text-gray-600">
          <span>
            Est. price:{' '}
            <span className="font-mono font-medium text-gray-900">
              {usd(result.estimatedPrice)}
            </span>
          </span>
          <span>
            Range:{' '}
            <span className="font-mono text-gray-700">
              {usd(result.lowPrice)} – {usd(result.highPrice)}
            </span>
          </span>
          {result.estimatedDaysToSell !== null && (
            <span>
              Days to sell:{' '}
              <span className="text-gray-700">~{result.estimatedDaysToSell}d</span>
            </span>
          )}
          <span>
            Comparables: <span className="text-gray-700">{result.comparableCount}</span>
          </span>
          <span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_COLORS[result.confidence]}`}
            >
              {result.confidence.charAt(0).toUpperCase() + result.confidence.slice(1)} confidence
            </span>
          </span>
        </div>
      ) : (
        <p className="text-gray-500">
          Not enough comparable completed sales to produce a reliable estimate.
          {result.comparableCount === 0 && ' (0 comparable sales found)'}
        </p>
      )}
    </div>
  )
}
