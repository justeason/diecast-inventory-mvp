// 24B: collapsed-by-default methodology disclosure — no client JS, plain <details>.
// Concise, no investment/appraisal framing, no implementation jargon.
export function MarketMethodology() {
  return (
    <details className="mt-2 text-xs text-gray-500">
      <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-900">How is this calculated?</summary>
      <ul className="mt-2 space-y-1 list-disc list-inside">
        <li>Uses actual completed (executed) comparable sales, never asking prices.</li>
        <li>Uses the median sale price among comparable sales.</li>
        <li>Compares only this exact catalog model — never a different model.</li>
        <li>Includes CollectNTrades and tracked external marketplace sales when available.</li>
        <li>Active asking prices never affect the estimated value.</li>
        <li>Statistical outliers may be excluded when enough comparable sales exist.</li>
      </ul>
    </details>
  )
}
