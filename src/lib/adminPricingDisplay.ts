// 32B: pure display-logic helpers for canonical Admin Pricing Context. No
// Prisma, no React — mirrors marketModelPageDisplay.ts's own separation of
// pure formatting from data-fetching (24B). Client-safe (no server-only
// imports) so the same functions drive both server-rendered admin pages and
// the live, keystroke-reactive price classification on listing forms.
import type { ValuationResult } from '@/lib/marketValuation'
import { isFallbackSpecificity } from '@/lib/marketModelPageDisplay'
import { internalPriceToCents } from '@/lib/marketMoney'

export const ADMIN_CONFIDENCE_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

type ValuedResult = Extract<ValuationResult, { status: 'valued' }>

// §12/§13: admin display MAY show a within-model fallback (unlike 31B
// automation's exact-only gate), always visibly disclosed, never a raw enum
// name. Reuses the exact customer-facing copy (SellerMarketSnapshot.tsx)
// rather than inventing a second, possibly-contradictory admin phrasing.
export function describeSpecificityFallback(valuation: ValuedResult): string | null {
  if (!isFallbackSpecificity(valuation)) return null
  return valuation.specificity === 'model'
    ? 'Not enough packaging-specific sales — using broader model-level sales due to limited packaging-specific history.'
    : 'Not enough sales at the exact condition — using packaging-level sales across all conditions.'
}

// §38/§43: exact-bound classification — never a tolerance band. Null when no
// canonical Market Range exists to compare against. Display-only: never feeds
// risk/validation/mutation behavior (§44).
export type PriceVsMarketRange = 'below_range' | 'within_range' | 'above_range'

export function classifyPriceVsMarketRange(
  priceCents: number,
  rangeLowCents: number | null,
  rangeHighCents: number | null,
): PriceVsMarketRange | null {
  if (rangeLowCents === null || rangeHighCents === null) return null
  if (priceCents < rangeLowCents) return 'below_range'
  if (priceCents > rangeHighCents) return 'above_range'
  return 'within_range'
}

// §45: plain, non-judgmental labels — never fair/unfair/underpriced/overpriced.
export const PRICE_VS_RANGE_LABELS: Record<PriceVsMarketRange, string> = {
  below_range: 'Below Market Range',
  within_range: 'Within Market Range',
  above_range: 'Above Market Range',
}

// §69: reuses the canonical Float-dollars-to-cents boundary (marketMoney.ts)
// for a raw price `<input>` string — never a second ad hoc Math.round(price*100).
export function parsePriceInputToCents(priceStr: string): number | null {
  const dollars = parseFloat(priceStr)
  if (!Number.isFinite(dollars) || dollars < 0) return null
  return internalPriceToCents(dollars)
}
