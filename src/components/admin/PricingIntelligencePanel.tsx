import type { PricingIntelligenceResult, EvidenceSummary } from '@/lib/pricingIntelligence'

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-blue-100 text-blue-800',
  low: 'bg-yellow-100 text-yellow-800',
  insufficient: 'bg-gray-100 text-gray-600',
}

function usd(cents: number | null): string {
  return cents === null ? '—' : `$${(cents / 100).toFixed(2)}`
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '—'
}

function EvidenceCard({ title, e }: { title: string; e: EvidenceSummary }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{title}</p>
      <p className="text-lg font-bold text-gray-900 tabular-nums">{e.count} obs.</p>
      <p className="text-xs text-gray-500 mt-1">{e.windowLabel}</p>
      {e.medianCents !== null && (
        <p className="text-sm text-gray-700 mt-2 tabular-nums">
          Median {usd(e.medianCents)} ({usd(e.p25Cents)} – {usd(e.p75Cents)})
        </p>
      )}
      {e.outliers && e.outliers.excludedCount > 0 && (
        <p className="text-xs text-amber-600 mt-1">{e.outliers.excludedCount} outlier(s) excluded</p>
      )}
      <p className="text-xs text-gray-400 mt-1">Freshest: {fmtDate(e.freshestAt)}</p>
    </div>
  )
}

export function PricingIntelligencePanel({ result, modelLabel }: { result: PricingIntelligenceResult; modelLabel: string }) {
  const { recommendedListing: rec, confidence, evidence, marketPosition } = result

  return (
    <div className="space-y-6">
      {result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1">
          {result.warnings.map((w, i) => <p key={i}>{w}</p>)}
        </div>
      )}

      <div className="rounded-md border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-5 py-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Pricing Intelligence</p>
          <p className="text-sm font-medium text-gray-900">{modelLabel}</p>
          <p className="text-xs text-gray-400 mt-1">As of {new Date(result.asOf).toLocaleString()}</p>
        </div>
        {result.isAskOnly && (
          <div className="px-5 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-800">
            No completed-sale evidence is available. The figures below are active-market-ask context only — not a validated valuation.
          </div>
        )}
        <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-gray-400 mb-1">{result.isAskOnly ? 'Ask-only market context' : 'Estimated Value'}</p>
            <p className="text-lg font-bold text-gray-900 tabular-nums">
              {result.isAskOnly ? 'No completed sales' : result.estimatedValueCents !== null ? usd(result.estimatedValueCents) : 'No sold evidence'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">{result.isAskOnly ? 'Current asking-price range' : 'Recommended Range'}</p>
            <p className="text-sm text-gray-700 tabular-nums">
              {rec.targetCents !== null ? `${usd(rec.lowCents)} – ${usd(rec.highCents)}` : '—'}
            </p>
            {rec.targetCents !== null && (
              <p className="text-xs text-gray-500">{result.isAskOnly ? 'Median ask' : 'Target'} {usd(rec.targetCents)}</p>
            )}
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Confidence</p>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_COLORS[confidence.level]}`}>
              {confidence.level}
            </span>
            {confidence.score !== null && <p className="text-xs text-gray-400 mt-1">Score {confidence.score}</p>}
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Market Position</p>
            <p className="text-sm text-gray-700">{result.marketPositionClass.replace('_', ' ')}</p>
          </div>
        </div>
        <div className="border-t border-gray-100 px-5 py-3">
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">{result.isAskOnly ? 'Why this range?' : 'Why this price?'}</p>
          <p className="text-sm text-gray-700">{result.explanation}</p>
        </div>
        {confidence.reasons.length > 0 && (
          <div className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500 space-y-0.5">
            {confidence.reasons.map((r, i) => <p key={i}>• {r}</p>)}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Evidence</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <EvidenceCard title="First-party sold" e={evidence.firstPartySold} />
          <EvidenceCard title="External sold" e={evidence.externalSold} />
          <EvidenceCard title="External active asks" e={evidence.activeAsks} />
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Current market supply</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-md border border-gray-200 bg-white p-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">CollectNTrades active listings</p>
            <p className="text-lg font-bold text-gray-900 tabular-nums">{marketPosition.collectNTrades.activeListingCount}</p>
            {marketPosition.collectNTrades.activeListingCount > 0 && (
              <p className="text-xs text-gray-500 mt-1 tabular-nums">
                {usd(marketPosition.collectNTrades.lowestAskCents)} – {usd(marketPosition.collectNTrades.highestAskCents)} (median {usd(marketPosition.collectNTrades.medianAskCents)})
              </p>
            )}
          </div>
          <div className="rounded-md border border-gray-200 bg-white p-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">External active asks</p>
            <p className="text-lg font-bold text-gray-900 tabular-nums">{marketPosition.external.activeAskCount}</p>
            {marketPosition.external.activeAskCount > 0 && (
              <p className="text-xs text-gray-500 mt-1 tabular-nums">
                {usd(marketPosition.external.lowestAskCents)} – {usd(marketPosition.external.highestAskCents)} (median {usd(marketPosition.external.medianAskCents)})
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
