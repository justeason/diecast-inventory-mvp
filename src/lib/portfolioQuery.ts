// 26B: Portfolio V1 — now sources cost from the ownership ledger
// (AcquisitionLot) rather than CollectionItem.purchasePrice directly. Market
// value remains EXCLUSIVELY 23B getValuationsBatch (model-level). No
// AdvancedValuation, no resaleEstimator, no pricingIntelligence.
//
// "Recorded Cost" (never "Cost Basis") sums only KNOWN-cost remaining lots.
// A holding's Unrealized Gain/Loss is computed only at FULL remaining-cost
// coverage (every remaining copy has a known-cost lot) — never subtracting a
// partial known cost from the full market value and calling the result a
// gain/loss (26B §41). Recorded Realized Gain/Loss is a separate, portfolio-
// wide total over non-reversed sale-type disposals only.
import { prisma } from '@/lib/prisma'
import { getValuationsBatch } from '@/lib/marketValuation'
import { isValidQuantity } from '@/lib/advancedValuationQuery'
import { computeRealizedGain, resolveLegacyCostKnowledge, SALE_DISPOSAL_TYPES } from '@/lib/ownershipLedger'
import type { ValuationConfidence } from '@/lib/marketValuationMath'

export type HoldingCostStatus = 'known' | 'partial' | 'unknown'
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

  // Known-lot-only sum — shown even at partial coverage (costStatus discloses
  // which). Null only when zero remaining copies have known cost.
  recordedCostCents: number | null
  costStatus: HoldingCostStatus
  knownCostCopies: number
  // 26C: only non-null at FULL cost coverage (costStatus==='known') — never a
  // blended/partial average, never implies an unknown-cost copy shares it.
  averageRecordedCostCents: number | null

  // Only non-null when costStatus==='known' (full coverage) AND valued.
  unrealizedGainLossCents: number | null
  // Raw ratio (e.g. 0.184 for +18.4%), matching this codebase's existing
  // percentageChange convention — never pre-multiplied by 100, never
  // annualized, never an expected return.
  unrealizedGainLossPercent: number | null
}

export type PortfolioResult = {
  asOf: Date

  // null (never 0) when zero holdings contribute — a total of "no data" must
  // never be confused with a true known $0.
  estimatedPortfolioValueCents: number | null
  recordedCostCents: number | null
  unrealizedGainLossCents: number | null

  // Recorded Realized Gain/Loss — portfolio-wide, over non-reversed
  // platform_sale/external_sale disposals only (never gift/trade/
  // other_removal/correction — those are never realized-gain eligible).
  recordedRealizedGainLossCents: number | null

  marketValueCoverage: { valuedCopies: number; totalCopies: number }
  costCoverage: { knownCostCopies: number; totalCopies: number }
  gainLossCoverage: { comparableCopies: number; totalCopies: number }
  // Denominator: non-reversed platform_sale/external_sale disposals.
  // Numerator: those with fully calculable Recorded Realized Gain/Loss.
  realizedCoverage: { coveredDisposals: number; totalDisposals: number }

  holdings: PortfolioHolding[]
}

function classifyHoldingCost(totalCopies: number, knownCostCopies: number): HoldingCostStatus {
  if (totalCopies === 0 || knownCostCopies === 0) return 'unknown'
  if (knownCostCopies === totalCopies) return 'known'
  return 'partial'
}

// 26C §7/§49: holding-wide Average Recorded Cost / copy — ONLY meaningful at
// full cost coverage (costStatus==='known'); callers must gate on that
// themselves, since $0 recordedCostCents at zero copies is not "$0/copy".
// Integer-cent rounding matches this repo's existing per-unit-average
// convention (see marketValuationMath.ts's median calc).
export function computeAverageRecordedCostCents(recordedCostCents: number, copies: number): number | null {
  if (copies <= 0) return null
  return Math.round(recordedCostCents / copies)
}

type LotForCost = { collectionItemId: string; remainingQuantity: number; unitRecordedCostCents: number | null }
type SaleDisposalForRealized = { netProceedsCents: number | null; allocations: Array<{ allocatedRecordedCostCents: number | null }> }

export async function getPortfolio(profileId: string, asOf: Date = new Date()): Promise<PortfolioResult> {
  const items = await prisma.collectionItem.findMany({
    where: { profileId },
    select: { id: true, catalogId: true, quantity: true, purchasePrice: true },
  })
  const itemIds = items.map((i) => i.id)

  const catalogIds = [...new Set(items.map((i) => i.catalogId).filter((id): id is string => id !== null))]

  const [valuations, lots, saleDisposals] = await Promise.all([
    catalogIds.length > 0 ? getValuationsBatch({ catalogModelIds: catalogIds, asOf }) : Promise.resolve(new Map()),
    itemIds.length > 0
      ? prisma.acquisitionLot.findMany({
          where: { collectionItemId: { in: itemIds }, remainingQuantity: { gt: 0 } },
          select: { collectionItemId: true, remainingQuantity: true, unitRecordedCostCents: true },
        })
      : Promise.resolve([] as LotForCost[]),
    itemIds.length > 0
      ? prisma.collectionDisposal.findMany({
          where: { collectionItemId: { in: itemIds }, reversedAt: null, disposalType: { in: [...SALE_DISPOSAL_TYPES] } },
          select: { netProceedsCents: true, allocations: { select: { allocatedRecordedCostCents: true } } },
        })
      : Promise.resolve([] as SaleDisposalForRealized[]),
  ])

  const lotsByItem = new Map<string, LotForCost[]>()
  for (const lot of lots) {
    const arr = lotsByItem.get(lot.collectionItemId)
    if (arr) arr.push(lot)
    else lotsByItem.set(lot.collectionItemId, [lot])
  }

  let estimatedPortfolioValueCents = 0
  let hasAnyValue = false
  let recordedCostCents = 0
  let hasAnyCost = false
  let unrealizedGainLossCents = 0
  let hasAnyGainLoss = false

  let valuedCopies = 0
  let totalCopies = 0
  let knownCostCopiesTotal = 0
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

    const itemLots = lotsByItem.get(item.id) ?? []
    let knownCostCopies: number
    let recordedCostForRow: number
    let costStatus: HoldingCostStatus
    if (itemLots.length > 0) {
      knownCostCopies = itemLots.reduce(
        (sum, lot) => (lot.unitRecordedCostCents !== null ? sum + lot.remainingQuantity : sum),
        0,
      )
      recordedCostForRow = itemLots.reduce(
        (sum, lot) => (lot.unitRecordedCostCents !== null ? sum + lot.unitRecordedCostCents * lot.remainingQuantity : sum),
        0,
      )
      costStatus = classifyHoldingCost(copies, knownCostCopies)
    } else {
      // Final Gate §5/§6: a CollectionItem can legitimately have zero
      // AcquisitionLot rows between schema deployment and the separate,
      // idempotent backfill script reaching this specific item — never
      // interpret that as a known-zero-cost or fully-reconciled holding.
      // Fall back to the pre-26B (25B) conservative legacy purchasePrice
      // read, for THIS holding's display only — never fabricates a lot row,
      // and stops applying the instant even one real lot exists for it (see
      // itemLots.length > 0 branch above, which is then always authoritative).
      const legacy = resolveLegacyCostKnowledge(item.quantity, item.purchasePrice)
      if (legacy.costKnowledge === 'known') {
        knownCostCopies = copies
        recordedCostForRow = legacy.unitRecordedCostCents ?? 0
        costStatus = 'known'
      } else {
        // ambiguous_legacy (qty>1) and unknown both exclude from totals —
        // matches 25B's own "ambiguous/unknown excluded" cost policy.
        knownCostCopies = 0
        recordedCostForRow = 0
        costStatus = 'unknown'
      }
    }
    knownCostCopiesTotal += knownCostCopies
    if (knownCostCopies > 0) {
      recordedCostCents += recordedCostForRow
      hasAnyCost = true
    }

    const averageRecordedCostCents = costStatus === 'known' ? computeAverageRecordedCostCents(recordedCostForRow, copies) : null

    let unrealizedGainLossForRow: number | null = null
    let unrealizedGainLossPercent: number | null = null
    if (costStatus === 'known' && valuationStatus === 'valued') {
      unrealizedGainLossForRow = estimatedHoldingValueCents! - recordedCostForRow
      unrealizedGainLossPercent = recordedCostForRow > 0 ? unrealizedGainLossForRow / recordedCostForRow : null
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

      recordedCostCents: knownCostCopies > 0 ? recordedCostForRow : null,
      costStatus,
      knownCostCopies,
      averageRecordedCostCents,

      unrealizedGainLossCents: unrealizedGainLossForRow,
      unrealizedGainLossPercent,
    }
  })

  let recordedRealizedGainLossCents = 0
  let hasAnyRealizedGain = false
  let coveredDisposals = 0
  for (const disposal of saleDisposals) {
    const result = computeRealizedGain(disposal.netProceedsCents, disposal.allocations)
    if (result.status === 'calculable') {
      coveredDisposals++
      recordedRealizedGainLossCents += result.recordedRealizedGainLossCents
      hasAnyRealizedGain = true
    }
  }

  return {
    asOf,
    estimatedPortfolioValueCents: hasAnyValue ? estimatedPortfolioValueCents : null,
    recordedCostCents: hasAnyCost ? recordedCostCents : null,
    unrealizedGainLossCents: hasAnyGainLoss ? unrealizedGainLossCents : null,
    recordedRealizedGainLossCents: hasAnyRealizedGain ? recordedRealizedGainLossCents : null,
    marketValueCoverage: { valuedCopies, totalCopies },
    costCoverage: { knownCostCopies: knownCostCopiesTotal, totalCopies },
    gainLossCoverage: { comparableCopies, totalCopies },
    realizedCoverage: { coveredDisposals, totalDisposals: saleDisposals.length },
    holdings,
  }
}
