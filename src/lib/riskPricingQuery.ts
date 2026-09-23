// 32C: DB boundary for manual-admin risk pricing evidence — canonical
// getValuation only (§3). Deliberately NOT getPricingContext/
// safeGetAdminPricingContext: those also fetch Ask Summary/Ask Depth/Market
// Signals, none of which a risk decision may ever depend on (32C-A audit
// §19/§20/§32-34), and safeGetAdminPricingContext specifically swallows
// technical failures for optional DISPLAY enrichment — reusing it here would
// silently convert a technical failure into "proceed as if no evidence
// exists," exactly what §30/§31 forbid. A getValuation failure here
// propagates uncaught, by design — the caller's mutation must abort, never
// fall back to legacy pricing or a silent allow.
import { getValuation, type ValuationInput } from '@/lib/marketValuation'
import { buildPricingEvidence, type PricingEvidence } from '@/lib/riskPolicy'

export async function fetchRiskPricingEvidence(input: ValuationInput): Promise<PricingEvidence> {
  const asOf = input.asOf ?? new Date()
  const valuation = await getValuation(input)
  return buildPricingEvidence(valuation, asOf)
}
