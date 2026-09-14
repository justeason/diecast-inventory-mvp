// 23B: Valuation Engine V1 — orchestration. Consumes ONLY 22B's canonical
// market evidence (getMarketSaleHistory) — never queries Order/OrderItem/
// ExternalMarketObservation directly. Estimated Market Value: a sale-derived
// estimate of what one comparable collectible would reasonably trade for in
// the current market, based on executed comparable sales. NOT an asking
// price, guaranteed sale price, instant-sell offer, seller payout, forecast,
// or investment value.
//
// Never crosses CatalogModel boundaries (23A §16/§48) — a deliberate break
// from resaleEstimator.ts's brand/name/series/year fallback. If same-model
// evidence is insufficient at every allowed specificity tier, the result is
// insufficient_data, never a "similar model" substitute.
//
// No asks, no trend, no velocity, no supply/demand, no condition/variant
// multipliers, no seller-offer logic — all deliberately out of scope for V1.
import { prisma } from '@/lib/prisma'
import { getMarketSaleHistory, getMarketSaleHistoryForModels } from '@/lib/marketSaleQuery'
import { ITEM_CONDITIONS } from '@/lib/itemMutations'
import { subtractMonths } from '@/lib/externalMarketResearch'
import {
  selectTier,
  assembleValuedResult,
  type SpecificityTier,
  type ValuationConfidence,
} from '@/lib/marketValuationMath'

const PRIMARY_WINDOW_MONTHS = 24
const HISTORY_LIMIT = 500

type TierTarget = { marketVariantId: string | null; condition: string | null }
type TierSelection = { specificity: SpecificityTier; observations: Awaited<ReturnType<typeof getMarketSaleHistory>>['observations'] }

// Resolves the correct specificity tier for one broad model-level query result,
// self-correcting for truncation: a truncated broad fetch (hasMore=true) may
// contain zero rows for a narrower tier in its own top-500 window purely
// because the model-level bound cut them off — NOT because the tier is
// actually empty. In that case, a targeted 22B query (server-side filtered by
// the exact marketVariantId/condition, same window/limit) is the only way to
// know the tier's true population, up to the same canonical bound. The
// targeted query's own observations/hasMore become the chosen sample —
// never a mix of the broad truncated subset with a different query's result.
//
// When the broad fetch was NOT truncated, the single in-memory pass already
// sees every eligible row, so no targeted query is ever issued (common case:
// exactly one query total for this window).
async function resolveTierSelection(
  catalogModelId: string,
  allowedTiers: SpecificityTier[],
  target: TierTarget,
  window: { startDate?: Date; endDate: Date },
  broad: { observations: TierSelection['observations']; hasMore: boolean },
): Promise<{ selection: TierSelection; sampleTruncated: boolean } | null> {
  if (!broad.hasMore) {
    const selection = selectTier(broad.observations, allowedTiers, target)
    return selection ? { selection, sampleTruncated: false } : null
  }

  for (const tier of allowedTiers) {
    if (tier === 'model') {
      // The broadest tier IS the broad query itself — nothing narrower to hide
      // beyond its own bound, so no targeted query is needed here.
      const selection = selectTier(broad.observations, ['model'], target)
      return selection ? { selection, sampleTruncated: broad.hasMore } : null
    }

    const targeted = await getMarketSaleHistory({
      catalogModelId,
      marketVariantId: target.marketVariantId!,
      ...(tier === 'model_variant_condition' ? { condition: target.condition! } : {}),
      ...window,
      limit: HISTORY_LIMIT,
    })
    if (targeted.observations.length > 0) {
      return { selection: { specificity: tier, observations: targeted.observations }, sampleTruncated: targeted.hasMore }
    }
  }
  return null
}

export type ValuationInput = {
  catalogModelId: string
  marketVariantId?: string
  condition?: string
  asOf?: Date
}

export type ValuationResult =
  | { status: 'input_error'; errors: Record<string, string[]> }
  | {
      status: 'insufficient_data'
      catalogModelId: string
      marketVariantId: string | null
      condition: string | null
      asOf: Date
      reason: 'no_sales'
    }
  | {
      status: 'valued'
      catalogModelId: string
      marketVariantId: string | null
      condition: string | null

      estimatedValueCents: number
      marketRangeLowCents: number | null
      marketRangeHighCents: number | null

      confidence: ValuationConfidence
      specificity: SpecificityTier
      primarySpecificity: SpecificityTier

      rawSampleCount: number
      usedSampleCount: number
      excludedOutlierCount: number

      internalSampleCount: number
      externalSampleCount: number

      asOf: Date
      windowStart: Date
      extendedHistoryUsed: boolean
      sampleTruncated: boolean

      method: 'median_sales'
      outlierMethod: 'iqr_1_5' | 'none'
      fallbackReason: 'no_sales_at_requested_specificity' | 'no_recent_sales' | null

      latestSaleAt: Date | null
    }

export async function getValuation(input: ValuationInput): Promise<ValuationResult> {
  const asOf = input.asOf ?? new Date()

  // §5/§74: a condition filter requires marketVariantId — never pool Carded
  // and Loose condition-specific sales together to answer a question the
  // tier hierarchy can't coherently represent.
  if (input.condition !== undefined && input.marketVariantId === undefined) {
    return {
      status: 'input_error',
      errors: { condition: ['A condition filter requires marketVariantId.'] },
    }
  }

  // §7/§79: only the shared six-value internal vocabulary.
  if (input.condition !== undefined && !(ITEM_CONDITIONS as readonly string[]).includes(input.condition)) {
    return { status: 'input_error', errors: { condition: ['Invalid condition.'] } }
  }

  // §6/§75/§78: marketVariantId, if supplied, must belong to catalogModelId.
  // One validation query — never per-observation.
  if (input.marketVariantId !== undefined) {
    const variant = await prisma.marketVariant.findUnique({
      where: { id: input.marketVariantId },
      select: { catalogModelId: true },
    })
    if (!variant || variant.catalogModelId !== input.catalogModelId) {
      return {
        status: 'input_error',
        errors: { marketVariantId: ['Market variant does not belong to this catalog model.'] },
      }
    }
  }

  const marketVariantId = input.marketVariantId ?? null
  const condition = input.condition ?? null
  const target = { marketVariantId, condition }

  // §8: primary specificity is REQUEST-relative — "exact" means the chosen
  // tier equals what was actually requested, not a hardcoded tier name.
  const primarySpecificity: SpecificityTier =
    condition !== null ? 'model_variant_condition' : marketVariantId !== null ? 'model_variant' : 'model'

  const allowedTiers: SpecificityTier[] =
    primarySpecificity === 'model_variant_condition'
      ? ['model_variant_condition', 'model_variant', 'model']
      : primarySpecificity === 'model_variant'
        ? ['model_variant', 'model']
        : ['model']

  // §49: fetch same-model evidence ONCE for the 24-month primary window — no
  // variant/condition filter at query time; tiers are partitioned in memory.
  const windowStart = subtractMonths(asOf, PRIMARY_WINDOW_MONTHS)
  const primary = await getMarketSaleHistory({
    catalogModelId: input.catalogModelId,
    startDate: windowStart,
    endDate: asOf,
    limit: HISTORY_LIMIT,
  })

  const primaryResolved = await resolveTierSelection(
    input.catalogModelId,
    allowedTiers,
    target,
    { startDate: windowStart, endDate: asOf },
    primary,
  )

  let selection = primaryResolved?.selection ?? null
  let extendedHistoryUsed = false
  let sampleTruncated = primaryResolved?.sampleTruncated ?? primary.hasMore
  let fallbackReason: 'no_sales_at_requested_specificity' | 'no_recent_sales' | null =
    selection && selection.specificity !== primarySpecificity ? 'no_sales_at_requested_specificity' : null

  // §12/§50/§51: only if the ENTIRE allowed hierarchy is empty within the
  // primary window — never extend an exact tier all-time before checking
  // broader RECENT tiers. Same truncation-safe resolution applies here too:
  // a truncated all-time fetch must not falsely erase an available narrower
  // same-model tier either.
  if (!selection) {
    const extended = await getMarketSaleHistory({
      catalogModelId: input.catalogModelId,
      endDate: asOf,
      limit: HISTORY_LIMIT,
    })
    const extendedResolved = await resolveTierSelection(
      input.catalogModelId,
      allowedTiers,
      target,
      { endDate: asOf },
      extended,
    )
    selection = extendedResolved?.selection ?? null
    if (selection) {
      extendedHistoryUsed = true
      // §38: historical extension takes precedence over the specificity-fallback reason.
      fallbackReason = 'no_recent_sales'
      sampleTruncated = extendedResolved!.sampleTruncated
    }
  }

  if (!selection) {
    return {
      status: 'insufficient_data',
      catalogModelId: input.catalogModelId,
      marketVariantId,
      condition,
      asOf,
      reason: 'no_sales',
    }
  }

  return assembleValuedResult({
    catalogModelId: input.catalogModelId,
    marketVariantId,
    condition,
    specificity: selection.specificity,
    primarySpecificity,
    observations: selection.observations,
    asOf,
    windowStart,
    extendedHistoryUsed,
    sampleTruncated,
    fallbackReason,
  })
}

// ── Batch composition (25B — Portfolio V1) ──────────────────────────────────
// Produces a ValuationResult per requested CatalogModel, semantically
// IDENTICAL to calling getValuation({catalogModelId, asOf}) individually for
// each one — same canonical 22B evidence eligibility, same assembleValuedResult
// math, same 24-month-then-extended-history resolution. Portfolio requests are
// always model-level only (no marketVariantId/condition), so the tier
// resolution collapses to its simplest case: the 'model' tier IS the broad
// fetch itself, so unlike the single-model API's variant/condition path, a
// batch request never needs a targeted narrower-tier query — only "primary
// window" then, if empty, "extended/all-time", both fetched batched across
// many models via getMarketSaleHistoryForModels (chunked/paginated IN-clause
// queries, never one query per model, and never a shared/global row budget —
// each model's own observations are bucketed and bounded to the canonical
// 500-row limit independently, exactly like the single-model API).
export type ValuationBatchInput = {
  catalogModelIds: string[]
  asOf?: Date
}

export async function getValuationsBatch(input: ValuationBatchInput): Promise<Map<string, ValuationResult>> {
  const asOf = input.asOf ?? new Date()
  const windowStart = subtractMonths(asOf, PRIMARY_WINDOW_MONTHS)
  const uniqueIds = [...new Set(input.catalogModelIds)]

  const results = new Map<string, ValuationResult>()
  if (uniqueIds.length === 0) return results

  const primaryByModel = await getMarketSaleHistoryForModels({
    catalogModelIds: uniqueIds,
    startDate: windowStart,
    endDate: asOf,
    limit: HISTORY_LIMIT,
  })

  const needsExtension: string[] = []
  for (const id of uniqueIds) {
    const bucket = primaryByModel.get(id) ?? { observations: [], hasMore: false }
    if (bucket.observations.length === 0) {
      needsExtension.push(id)
      continue
    }
    results.set(
      id,
      assembleValuedResult({
        catalogModelId: id,
        marketVariantId: null,
        condition: null,
        specificity: 'model',
        primarySpecificity: 'model',
        observations: bucket.observations,
        asOf,
        windowStart,
        extendedHistoryUsed: false,
        sampleTruncated: bucket.hasMore,
        fallbackReason: null,
      }),
    )
  }

  if (needsExtension.length > 0) {
    const extendedByModel = await getMarketSaleHistoryForModels({
      catalogModelIds: needsExtension,
      endDate: asOf,
      limit: HISTORY_LIMIT,
    })
    for (const id of needsExtension) {
      const bucket = extendedByModel.get(id) ?? { observations: [], hasMore: false }
      if (bucket.observations.length === 0) {
        results.set(id, { status: 'insufficient_data', catalogModelId: id, marketVariantId: null, condition: null, asOf, reason: 'no_sales' })
        continue
      }
      results.set(
        id,
        assembleValuedResult({
          catalogModelId: id,
          marketVariantId: null,
          condition: null,
          specificity: 'model',
          primarySpecificity: 'model',
          observations: bucket.observations,
          asOf,
          windowStart,
          extendedHistoryUsed: true,
          sampleTruncated: bucket.hasMore,
          fallbackReason: 'no_recent_sales',
        }),
      )
    }
  }

  return results
}
