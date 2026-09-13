// 22B: the one conversion boundary between stored money (internal Float dollars,
// external Decimal dollars) and the canonical market-evidence representation
// (integer cents). Built entirely on the existing Decimal-safe utilities in
// businessAnalyticsMath.ts — never an avoidably lossy string/float path.
import { Prisma } from '@prisma/client'
import { decimalFromFloatDollars, decimalToCents } from './businessAnalyticsMath'

// Internal OrderItem.price / Listing.price are Float dollars (always effectively
// 2dp USD in this schema). Route through Decimal via .toFixed(2) exactly like
// every other money computation in this codebase — never `Math.round(price*100)`.
export function internalPriceToCents(dollars: number): number {
  return decimalToCents(decimalFromFloatDollars(dollars))
}

// External ExternalMarketObservation.price is already a Prisma.Decimal(12,4) —
// may carry more than 2 decimal places. Rounding is ROUND_HALF_UP (matching
// decimalToCents' own fixed rounding mode) — e.g. $19.995 -> 2000 cents,
// $19.994 -> 1999 cents.
export function externalPriceToCents(price: Prisma.Decimal): number {
  return decimalToCents(price)
}
