// 24B: collapsed-by-default methodology disclosure — no client JS, plain <details>.
// Concise, no investment/appraisal framing, no implementation jargon.
// 30B §45: extended (not duplicated) with an 'activity' variant for Market
// Activity's four signals — the default 'valuation' variant's markup/copy is
// byte-identical to 24B's original, so MarketSnapshot's existing call site
// (`<MarketMethodology />`, no props) is unaffected.
const VALUATION_BULLETS = [
  'Uses actual completed (executed) comparable sales, never asking prices.',
  'Uses the median sale price among comparable sales.',
  'Compares only this exact catalog model — never a different model.',
  'Includes CollectNTrades and tracked external marketplace sales when available.',
  'Active asking prices never affect the estimated value.',
  'Statistical outliers may be excluded when enough comparable sales exist.',
]

const ACTIVITY_BULLETS = [
  '30D Est. Value Change compares the canonical estimated market value now versus 30 days earlier, using the same rules both times.',
  'Tracked Sales includes CollectNTrades sales and tracked external marketplace sales.',
  'Median Days to Sell uses CollectNTrades sales only — from when a listing was created to when it sold.',
  'Wanted reflects current CollectNTrades collector interest, not market demand or a price signal.',
]

export function MarketMethodology({ variant = 'valuation' }: { variant?: 'valuation' | 'activity' }) {
  const bullets = variant === 'activity' ? ACTIVITY_BULLETS : VALUATION_BULLETS
  const summary = variant === 'activity' ? 'What do these mean?' : 'How is this calculated?'
  return (
    <details className="mt-2 text-xs text-gray-500">
      <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-900">{summary}</summary>
      <ul className="mt-2 space-y-1 list-disc list-inside">
        {bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
    </details>
  )
}
