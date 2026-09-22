// 32B: canonical Admin Pricing Context — a detail-page-only composition for
// ADMIN display surfaces, built strictly on top of already-canonical
// primitives: 31B getPricingContext (valuation + internal ask summary +
// specificity/evidence disclosure), 28B getInternalAskDepth, 30B
// getMarketSignals. Introduces no new evidence rule of its own — this file is
// assembly only, never a second valuation/evidence engine.
//
// Deliberately kept OUT of pricingContext.ts itself (31B): Ask Depth and
// Market Signals are valid admin-only context but are not required for the
// automation pricing decision, and folding them into the canonical core would
// mean auto-listing's sequential per-item execution pays for queries it never
// uses (see pricingContext.ts's own header). This module is where that
// richer composition lives instead.
import { getPricingContext, type PricingContext, type PricingContextInput } from '@/lib/pricingContext'
import { getInternalAskDepth, type AskDepthLevel } from '@/lib/marketAskQuery'
import { getMarketSignals, type MarketSignals } from '@/lib/marketSignalsQuery'
import { logger, type LogMeta } from '@/lib/serverLogger'

export type AdminPricingContext = {
  pricing: PricingContext
  askDepth: AskDepthLevel[]
  signals: MarketSignals | null
}

export type AdminPricingContextInput = PricingContextInput & {
  // §9: Market Signals are detail-page-only, opt-in — never fetched for a
  // list/queue row (a full valuationChange30d/sales30d/daysToSell/wanted
  // fanout per row would defeat list-page batching).
  includeSignals?: boolean
}

export async function getAdminPricingContext(input: AdminPricingContextInput): Promise<AdminPricingContext> {
  const { includeSignals = false, ...pricingInput } = input
  const variantFilter = pricingInput.marketVariantId !== undefined ? { marketVariantId: pricingInput.marketVariantId } : {}

  // §10: one shared request-level asOf (input.asOf), passed straight through
  // to both valuation and signals — no hidden second `new Date()`. Ask
  // Depth/Ask Summary need no historical asOf — current supply only.
  const [pricing, askDepth] = await Promise.all([
    getPricingContext(pricingInput),
    getInternalAskDepth({ catalogModelId: pricingInput.catalogModelId, ...variantFilter }),
  ])

  // Follow-up §2: Market Signals is the one piece of AdminPricingContext that
  // is genuinely optional enrichment ON TOP of already-loaded facts (EMV/
  // Market Range/Confidence/Lowest Ask/Ask Depth) — isolated exactly like the
  // established customer-facing precedent (catalog/[id]/page.tsx's own
  // getMarketSignals try/catch), so a signals-only technical failure can
  // never blank pricing/askDepth that already loaded successfully. A failure
  // in getPricingContext/getInternalAskDepth themselves is NOT isolated here
  // — those are the base facts; their failure legitimately fails the whole
  // composition (see safeGetAdminPricingContext below for that boundary).
  let signals: MarketSignals | null = null
  if (includeSignals) {
    try {
      signals = await getMarketSignals({
        catalogModelId: pricingInput.catalogModelId,
        ...variantFilter,
        asOf: pricingInput.asOf,
        currentValuation: pricing.valuation,
      })
    } catch (err) {
      logger.error('admin_pricing_context_signals_failed', err, { catalogModelId: pricingInput.catalogModelId })
      signals = null
    }
  }

  return { pricing, askDepth, signals }
}

// Follow-up §1: narrow error-isolation boundary for OPTIONAL, display-only
// pricing enrichment. Never used to swallow auth redirects, notFound(),
// mutations, or risk-policy errors — those all live in entirely separate
// code paths this function never touches. Callers render the null case as
// neutral "Pricing context unavailable." copy — never raw exception text.
export async function safeGetAdminPricingContext(
  input: AdminPricingContextInput,
  logMeta: LogMeta,
): Promise<AdminPricingContext | null> {
  try {
    return await getAdminPricingContext(input)
  } catch (err) {
    logger.error('admin_pricing_context_failed', err, logMeta)
    return null
  }
}
