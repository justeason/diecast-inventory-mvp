import { centsToDisplay, saleSourceLabel, PACKAGING_LABELS, CONDITION_LABELS } from '@/lib/marketModelPageDisplay'
import { formatDate } from '@/lib/formatDate'
import type { MarketSaleObservation } from '@/lib/marketSaleQuery'

const RECENT_SALES_LIMIT = 10

// 24B: compact recent-sales list, normalized fields only (no provider, no
// matchMethod, no snapshotProvenance, no rawSnapshot, no seller identity).
// Doubles as the accessible fallback for PriceHistoryChart. Observations are
// already canonically sorted soldAt DESC by getMarketSaleHistory.
export function RecentSalesList({ observations }: { observations: MarketSaleObservation[] }) {
  const recent = observations.slice(0, RECENT_SALES_LIMIT)

  return (
    <ul className="divide-y divide-gray-200 border border-gray-200 rounded-md text-sm">
      {recent.map((sale) => (
        <li key={sale.observationId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2">
          <span className="text-gray-500">{formatDate(sale.soldAt, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          <span className="font-medium text-gray-900">{centsToDisplay(sale.priceCents)}</span>
          <span className="text-gray-500">{saleSourceLabel(sale)}</span>
          <span className="text-gray-500">{sale.packagingType ? PACKAGING_LABELS[sale.packagingType] : '—'}</span>
          <span className="text-gray-500">{sale.condition ? (CONDITION_LABELS[sale.condition] ?? sale.condition) : '—'}</span>
        </li>
      ))}
    </ul>
  )
}
