// 25B: Portfolio V1 — the canonical customer-facing ownership + value + cost
// summary for a profile's Collection. Market value comes EXCLUSIVELY from 23B
// getValuationsBatch (model-level, no marketVariantId/condition — CollectionItem
// identity is not canonical enough for narrower tiers, 24A/25A). No
// AdvancedValuation, no resaleEstimator, no pricingIntelligence.
//
// "Recorded Cost" (never "Cost Basis") is deliberately conservative: purchasePrice
// is historically ambiguous between per-unit and total-holding intent, and that
// ambiguity cannot be resolved for existing data. It is only ever treated as a
// usable cost when quantity===1, where per-unit and holding-total interpretations
// are identical. A multi-copy row's recorded price is preserved (surfaced via
// costStatus) but deliberately excluded from every cost/gain-loss total — Series
// 26 owns proper acquisition-lot cost tracking.
import { prisma } from '@/lib/prisma'
import { getValuationsBatch } from '@/lib/marketValuation'
import { isValidQuantity } from '@/lib/advancedValuationQuery'
import { internalPriceToCents } from '@/lib/marketMoney'
import type { ValuationConfidence } from '@/lib/marketValuationMath'

export type HoldingCostStatus = 'known' | 'unknown' | 'ambiguous_quantity' | 'invalid'
export type HoldingValuationStatus = 'valued' | 'insufficient_data' | 'no_catalog_match' | 'invalid_quantity'

export type PortfolioHolding = {
  collectionItemId: string
  catalogModelId: string | null
  quantity: number
  quantityValid: boolean

  estimatedUnitValueCents: number | null
  estimatedHoldingValueCents: number | null
  confidence: ValuationConfidence | null
  valuationStatus: HoldingValuationStatus

  recordedCostCents: number | null
  costStatus: HoldingCostStatus

  unrealizedGainLossCents: number | null
  // Raw ratio (e.g. 0.184 for +18.4%), matching this codebase's existing
  // percentageChange convention (advancedValuation.ts::computeTrend) — never
  // pre-multiplied by 100, never annualized, never an expected return.
  unrealizedGainLossPercent: number | null
}

export type PortfolioResult = {
  asOf: Date

  // null (never 0) when zero holdings contribute — a total of "no data" must
  // never be confused with a true known $0.
  estimatedPortfolioValueCents: number | null
  recordedCostCents: number | null
  unrealizedGainLossCents: number | null

  marketValueCoverage: { valuedCopies: number; totalCopies: number }
  costCoverage: { knownCostCopies: number; totalCopies: number }
  gainLossCoverage: { comparableCopies: number; totalCopies: number }

  holdings: PortfolioHolding[]
}

// §19/§20 of 25B's spec, verbatim policy: quantity===1 is the only case where
// a single recorded purchasePrice is unambiguous (per-unit and holding-total
// interpretations coincide). Any other quantity makes the same number
// genuinely ambiguous, so it is preserved (costStatus) but never totaled.
function resolveHoldingCostStatus(quantity: number, purchasePrice: number | null): HoldingCostStatus {
  if (purchasePrice === null) return 'unknown'
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) return 'invalid'
  if (quantity === 1) return 'known'
  return 'ambiguous_quantity'
}

export async function getPortfolio(profileId: string, asOf: Date = new Date()): Promise<PortfolioResult> {
  const items = await prisma.collectionItem.findMany({
    where: { profileId },
    select: { id: true, catalogId: true, quantity: true, purchasePrice: true },
  })

  const catalogIds = [...new Set(items.map((i) => i.catalogId).filter((id): id is string => id !== null))]
  const valuations = catalogIds.length > 0 ? await getValuationsBatch({ catalogModelIds: catalogIds, asOf }) : new Map()

  let estimatedPortfolioValueCents = 0
  let hasAnyValue = false
  let recordedCostCents = 0
  let hasAnyCost = false
  let unrealizedGainLossCents = 0
  let hasAnyGainLoss = false

  let valuedCopies = 0
  let totalCopies = 0
  let knownCostCopies = 0
  let comparableCopies = 0

  const holdings: PortfolioHolding[] = items.map((item) => {
    const quantityValid = isValidQuantity(item.quantity)
    const copies = quantityValid ? item.quantity : 0
    totalCopies += copies

    let valuationStatus: HoldingValuationStatus
    let estimatedUnitValueCents: number | null = null
    let estimatedHoldingValueCents: number | null = null
    let confidence: ValuationConfidence | null = null

    const valuation = item.catalogId ? valuations.get(item.catalogId) : undefined

    if (!quantityValid) {
      valuationStatus = 'invalid_quantity'
    } else if (!item.catalogId) {
      valuationStatus = 'no_catalog_match'
    } else if (valuation?.status === 'valued') {
      valuationStatus = 'valued'
      estimatedUnitValueCents = valuation.estimatedValueCents
      estimatedHoldingValueCents = valuation.estimatedValueCents * item.quantity
      confidence = valuation.confidence
      valuedCopies += copies
      estimatedPortfolioValueCents += estimatedHoldingValueCents
      hasAnyValue = true
    } else {
      valuationStatus = 'insufficient_data'
    }

    const costStatus = resolveHoldingCostStatus(item.quantity, item.purchasePrice)
    let recordedCostForRow: number | null = null
    if (costStatus === 'known') {
      recordedCostForRow = internalPriceToCents(item.purchasePrice!)
      knownCostCopies += copies
      recordedCostCents += recordedCostForRow
      hasAnyCost = true
    }

    let unrealizedGainLossForRow: number | null = null
    let unrealizedGainLossPercent: number | null = null
    if (costStatus === 'known' && valuationStatus === 'valued') {
      unrealizedGainLossForRow = estimatedHoldingValueCents! - recordedCostForRow!
      unrealizedGainLossPercent = recordedCostForRow! > 0 ? unrealizedGainLossForRow / recordedCostForRow! : null
      comparableCopies += copies
      unrealizedGainLossCents += unrealizedGainLossForRow
      hasAnyGainLoss = true
    }

    return {
      collectionItemId: item.id,
      catalogModelId: item.catalogId,
      quantity: item.quantity,
      quantityValid,

      estimatedUnitValueCents,
      estimatedHoldingValueCents,
      confidence,
      valuationStatus,

      recordedCostCents: recordedCostForRow,
      costStatus,

      unrealizedGainLossCents: unrealizedGainLossForRow,
      unrealizedGainLossPercent,
    }
  })

  return {
    asOf,
    estimatedPortfolioValueCents: hasAnyValue ? estimatedPortfolioValueCents : null,
    recordedCostCents: hasAnyCost ? recordedCostCents : null,
    unrealizedGainLossCents: hasAnyGainLoss ? unrealizedGainLossCents : null,
    marketValueCoverage: { valuedCopies, totalCopies },
    costCoverage: { knownCostCopies, totalCopies },
    gainLossCoverage: { comparableCopies, totalCopies },
    holdings,
  }
}
