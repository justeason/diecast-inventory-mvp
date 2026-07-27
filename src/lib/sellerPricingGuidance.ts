import { Prisma } from '@prisma/client'
import { median } from '@/lib/resaleEstimator'
import type { Confidence, MatchLevel, EstimateResult } from '@/lib/resaleEstimator'
import { calculateConsignmentPayoutSnapshot } from '@/lib/sellerPayoutCalculation'

export type PricingStrategy = 'sell_fast' | 'maximize_proceeds' | 'custom'

export type ConsignmentTerms = {
  commissionPercent: Prisma.Decimal | null
  fixedFee: Prisma.Decimal | null
  minimumSellerPayout: Prisma.Decimal | null
}

export type GuidanceInput = {
  strategy: PricingStrategy
  customTargetCents?: number | null
  estimateResult: EstimateResult
  consignmentTerms?: ConsignmentTerms | null
}

export type GuidanceOutput = {
  strategy: PricingStrategy
  targetPriceCents: number | null
  estimatedDaysToSell: number | null
  estimatedSellerProceedsCents: number | null
  confidence: Confidence
  comparableCount: number
  matchLevel: MatchLevel
  warnings: string[]
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function bandDays(sortedPricedDays: number[]): number | null {
  if (sortedPricedDays.length >= 1) return median(sortedPricedDays)
  return null
}

export function computeGuidance(input: GuidanceInput): GuidanceOutput {
  const { strategy, customTargetCents, estimateResult: er, consignmentTerms } = input
  const warnings: string[] = [...er.warnings]
  const hasEstimate = er.estimatedPrice !== null

  let targetPriceCents: number | null = null
  let estimatedDaysToSell: number | null = er.estimatedDaysToSell

  if (strategy === 'sell_fast') {
    targetPriceCents = er.lowPrice
    if (targetPriceCents !== null) {
      const band = er.comparables
        .filter((c) => c.soldPriceCents <= targetPriceCents! && c.daysToSell !== null)
        .map((c) => c.daysToSell as number)
        .sort((a, b) => a - b)
      const bandResult = bandDays(band)
      if (bandResult !== null) estimatedDaysToSell = bandResult
    }
  } else if (strategy === 'maximize_proceeds') {
    targetPriceCents = er.highPrice
    if (targetPriceCents !== null) {
      const band = er.comparables
        .filter((c) => c.soldPriceCents >= targetPriceCents! && c.daysToSell !== null)
        .map((c) => c.daysToSell as number)
        .sort((a, b) => a - b)
      const bandResult = bandDays(band)
      if (bandResult !== null) estimatedDaysToSell = bandResult
    }
  } else {
    // custom
    const price = customTargetCents ?? null
    targetPriceCents = price
    if (price !== null) {
      if (hasEstimate && er.lowPrice !== null && er.highPrice !== null) {
        if (price < er.lowPrice || price > er.highPrice) {
          warnings.push(
            `Your custom target price is outside the observed comparable range (${centsToDollars(er.lowPrice)} – ${centsToDollars(er.highPrice)}).`,
          )
        }
      }
      const nearest = [...er.comparables]
        .filter((c) => c.daysToSell !== null)
        .sort(
          (a, b) =>
            Math.abs(a.soldPriceCents - price) - Math.abs(b.soldPriceCents - price),
        )
        .slice(0, 5)
        .map((c) => c.daysToSell as number)
        .sort((a, b) => a - b)
      const nearestResult = bandDays(nearest)
      if (nearestResult !== null) estimatedDaysToSell = nearestResult
    }
  }

  // Estimated seller proceeds — consignment terms only; no buyout assumptions
  let estimatedSellerProceedsCents: number | null = null
  if (consignmentTerms && targetPriceCents !== null) {
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: targetPriceCents / 100,
      commissionPercent: consignmentTerms.commissionPercent,
      fixedFee: consignmentTerms.fixedFee,
      minimumSellerPayout: consignmentTerms.minimumSellerPayout,
    })
    estimatedSellerProceedsCents = Math.round(
      parseFloat(snapshot.netAmount.toString()) * 100,
    )
  }

  return {
    strategy,
    targetPriceCents,
    estimatedDaysToSell,
    estimatedSellerProceedsCents,
    confidence: er.confidence,
    comparableCount: er.comparableCount,
    matchLevel: er.matchLevel,
    warnings,
  }
}

export function isSubmissionPricingLocked(params: {
  agreements: Array<{ status: string }>
  intakeDrafts: Array<{ convertedItemId: string | null }>
}): boolean {
  return (
    params.agreements.some((a) => a.status === 'accepted') ||
    params.intakeDrafts.some((d) => d.convertedItemId !== null)
  )
}

export const VALID_STRATEGIES: PricingStrategy[] = [
  'sell_fast',
  'maximize_proceeds',
  'custom',
]

export const STRATEGY_LABELS: Record<PricingStrategy, string> = {
  sell_fast: 'Sell faster',
  maximize_proceeds: 'Maximize proceeds',
  custom: 'Custom target',
}
