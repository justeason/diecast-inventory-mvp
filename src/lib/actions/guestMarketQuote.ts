'use server'

// 27B §11/§12/§53/§60: guest camera-first model-level valuation — fires the
// moment confirmCandidate resolves a CatalogModel, before any account
// creation. Public market context only: model-level 23B getValuation, never
// variant/condition (GuestSellerItem cannot canonically represent either —
// see 27A audit §18), and never Recorded Cost/commission terms/Estimated
// Difference (all private, authenticated-only — see sellerCostContext.ts).
import { getValuation, type ValuationResult } from '@/lib/marketValuation'

export type GuestMarketQuoteResult = { ok: true; valuation: ValuationResult } | { ok: false; error: string }

export async function getGuestMarketQuote(catalogModelId: string): Promise<GuestMarketQuoteResult> {
  if (!catalogModelId) return { ok: false, error: 'Missing catalog model.' }
  const valuation = await getValuation({ catalogModelId })
  return { ok: true, valuation }
}
