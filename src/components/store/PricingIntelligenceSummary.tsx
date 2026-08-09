// Seller-facing summary — informational only, no automatic pricing acceptance.
// PricingIntelligenceResult never carries buyer/seller PII, raw external provider
// records, internal purchase cost, or payout/margin figures (see pricingIntelligence.ts
// and its tests), so it is safe to render directly here.

export type SerializedPricingIntelligence = {
  estimatedValueCents: number | null
  isAskOnly: boolean
  recommendedListing: { lowCents: number | null; targetCents: number | null; highCents: number | null }
  confidence: { level: string; reasons: string[] }
  evidence: {
    firstPartySold: { count: number }
    externalSold: { count: number }
    activeAsks: { count: number }
  }
  explanation: string
}

function usd(cents: number | null): string {
  return cents === null ? '—' : `$${(cents / 100).toFixed(2)}`
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-green-700',
  medium: 'text-blue-700',
  low: 'text-yellow-700',
  insufficient: 'text-gray-500',
}

export function PricingIntelligenceSummary({ result }: { result: SerializedPricingIntelligence }) {
  const evidenceCount = result.evidence.firstPartySold.count + result.evidence.externalSold.count

  if (result.isAskOnly) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm">
        <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Active ask context</p>
        <p className="text-xs text-amber-800 mb-2">
          No completed-sale evidence is available for this model yet. The range below reflects current active
          asking prices only — it is not a validated market value.
        </p>
        {result.recommendedListing.targetCents !== null && (
          <p className="text-sm text-gray-800">
            Current asking-price range: {usd(result.recommendedListing.lowCents)} – {usd(result.recommendedListing.highCents)}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Estimated market value</p>
      <div className="flex items-baseline gap-3">
        <p className="text-xl font-bold text-gray-900 tabular-nums">
          {result.estimatedValueCents !== null ? usd(result.estimatedValueCents) : 'No sold evidence'}
        </p>
        <span className={`text-xs font-medium ${CONFIDENCE_COLORS[result.confidence.level] ?? 'text-gray-500'}`}>
          {result.confidence.level} confidence
        </span>
      </div>
      {result.recommendedListing.targetCents !== null && (
        <p className="text-xs text-gray-600 mt-1">
          Recommended range: {usd(result.recommendedListing.lowCents)} – {usd(result.recommendedListing.highCents)}
        </p>
      )}
      <p className="text-xs text-gray-500 mt-2">{result.explanation}</p>
      <p className="text-xs text-gray-400 mt-1">{evidenceCount} completed sale(s) considered.</p>
    </div>
  )
}
