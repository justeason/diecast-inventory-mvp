import type { MarketSignals } from '@/lib/marketSignalsQuery'
import { formatValuationChange30d } from '@/lib/marketModelPageDisplay'
import { MarketMethodology } from './MarketMethodology'

// 30B: recent-behavior signals, kept structurally distinct from Market
// Snapshot's current-state fields (30A §4/§32). Compact, stacked rows — no
// table, no ticker/color treatment, no Confidence row (Market Snapshot
// already owns Confidence; §16 forbids a duplicate here). Every row degrades
// honestly and independently — one unavailable signal never hides another.
export function MarketActivity({ signals }: { signals: MarketSignals }) {
  const { valuationChange30d, sales30d, medianDaysToSell, wantedCount } = signals

  return (
    <section className="mb-8 rounded-md border border-gray-200 bg-gray-50 px-4 py-3 space-y-1">
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Market Activity</h2>

      <p className="text-sm text-gray-700">
        <span className="font-medium">30D Est. Value Change:</span>{' '}
        {valuationChange30d.status === 'available' ? (
          <span className="text-gray-900">{formatValuationChange30d(valuationChange30d)}</span>
        ) : (
          <span className="text-gray-400">
            Unavailable
            {valuationChange30d.status === 'incomparable' && ' — comparison uses different evidence scopes'}
            {valuationChange30d.status === 'insufficient_data' && ' — limited comparable sales'}
          </span>
        )}
      </p>

      <p className="text-sm text-gray-700">
        <span className="font-medium">Tracked Sales, Last 30 Days:</span>{' '}
        <span className="text-gray-900">{sales30d.total}</span>
      </p>

      <p className="text-sm text-gray-700">
        <span className="font-medium">Median Days to Sell:</span>{' '}
        {medianDaysToSell.status === 'available' ? (
          <span className="text-gray-900">{medianDaysToSell.medianDays} days</span>
        ) : (
          <span className="text-gray-400">Not enough CollectNTrades sales</span>
        )}
      </p>

      {wantedCount > 0 && (
        <p className="text-sm text-gray-700">
          Wanted by {wantedCount} {wantedCount === 1 ? 'Collector' : 'Collectors'}
        </p>
      )}

      <MarketMethodology variant="activity" />
    </section>
  )
}
