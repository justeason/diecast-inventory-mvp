// 31B: canonical Pricing Intelligence V2 — Pricing Context. Composition only,
// entirely over already-canonical 23B/24B primitives (getValuation,
// getInternalAskSummary) — introduces no new evidence rule. Deliberately
// minimal: Ask Depth / Market Signals are valid future admin context (Series
// 32) but are NOT required for the automation decision this milestone builds,
// and are intentionally excluded so auto-listing's sequential per-item
// execution stays bounded (never an unused query merely because it exists).
//
// Transaction-aware throughout: `client` (defaults to the global `prisma`)
// threads into BOTH canonical reads, so a caller holding an open transaction
// (auto-listing execution) sees one coherent DB snapshot for the whole
// pricing decision — never a mix of transaction reads and global-client
// reads for the same decision.
import { prisma, type DbClient } from '@/lib/prisma'
import { getValuation, type ValuationResult } from '@/lib/marketValuation'
import { getInternalAskSummary, type InternalAskSummary } from '@/lib/marketAskQuery'
import type { SpecificityTier } from '@/lib/marketValuationMath'

export type PricingContextInput = {
  catalogModelId: string
  marketVariantId?: string
  condition?: string
  asOf: Date
}

// Never hides a within-model fallback — resolved is null only when valuation
// itself produced no result at all (input_error/insufficient_data).
export type SpecificityDisclosure = {
  requested: SpecificityTier
  resolved: SpecificityTier | null
  exactMatch: boolean
}

// Null when valuation isn't 'valued' — there is no sample to disclose.
export type EvidenceDisclosure = {
  rawSampleCount: number
  usedSampleCount: number
  excludedOutlierCount: number
  internalSampleCount: number
  externalSampleCount: number
} | null

export type PricingContext = {
  valuation: ValuationResult
  askSummary: InternalAskSummary
  specificityDisclosure: SpecificityDisclosure
  evidenceDisclosure: EvidenceDisclosure
  asOf: Date
}

function requestedSpecificity(input: PricingContextInput): SpecificityTier {
  return input.condition !== undefined
    ? 'model_variant_condition'
    : input.marketVariantId !== undefined
      ? 'model_variant'
      : 'model'
}

export async function getPricingContext(input: PricingContextInput, client: DbClient = prisma): Promise<PricingContext> {
  const variantFilter = input.marketVariantId !== undefined ? { marketVariantId: input.marketVariantId } : {}
  const conditionFilter = input.condition !== undefined ? { condition: input.condition } : {}
  const requested = requestedSpecificity(input)

  // §52: one explicit asOf, passed straight through — no hidden new Date().
  // §53: askSummary needs no historical asOf (current supply), but MUST use
  // the same client as valuation for one coherent snapshot.
  const [valuation, askSummary] = await Promise.all([
    getValuation({ catalogModelId: input.catalogModelId, ...variantFilter, ...conditionFilter, asOf: input.asOf }, client),
    getInternalAskSummary({ catalogModelId: input.catalogModelId, ...variantFilter }, client),
  ])

  const resolved = valuation.status === 'valued' ? valuation.specificity : null
  const specificityDisclosure: SpecificityDisclosure = {
    requested,
    resolved,
    exactMatch: resolved !== null && resolved === requested,
  }

  const evidenceDisclosure: EvidenceDisclosure =
    valuation.status === 'valued'
      ? {
          rawSampleCount: valuation.rawSampleCount,
          usedSampleCount: valuation.usedSampleCount,
          excludedOutlierCount: valuation.excludedOutlierCount,
          internalSampleCount: valuation.internalSampleCount,
          externalSampleCount: valuation.externalSampleCount,
        }
      : null

  return { valuation, askSummary, specificityDisclosure, evidenceDisclosure, asOf: input.asOf }
}
