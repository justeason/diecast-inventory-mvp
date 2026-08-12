// 15C: pure logic for the unified ItemInstance lifecycle — display stage derivation,
// current-order selection, and contradiction ("needs attention") detection. No DB
// access (see itemLifecycleQuery.ts for that boundary). Mirrors the
// sellerPortfolio.ts pure/DB-boundary split from 15B.
//
// ItemInstance.status (draft|available|reserved|sold|not_for_sale) and Listing.status
// (active|sold|archived) remain the authoritative sub-statuses — this module NEVER
// replaces them, it only derives one simplified DISPLAY stage on top, recomputed on
// every read (never stored).

export type ItemLifecycleStage =
  | 'intake' // conceptual only — see note below; never returned for an existing ItemInstance
  | 'processing'
  | 'available'
  | 'listed'
  | 'reserved'
  | 'paid' // payment confirmed, awaiting order completion — see 15C-review section 3: this
           // schema proves PAYMENT, not physical fulfillment, so the stage is named honestly.
  | 'sold'
  | 'completed'
  | 'inactive' // withdrawn/held/archived — not_for_sale with no other evidence. NOT a
               // successful terminal sale; see 15C-review section 4.
  | 'exception'

export type ItemContradiction = {
  code: string
  message: string
}

// ── Current-order selection (15C-review section 2) ─────────────────────────────────
// An item can accumulate multiple order attempts over its life (order cancelled,
// item relisted, ordered again). Which one is "current" for display/stage purposes
// is NOT simply "most recently created" — a stale cancelled order must never mask a
// later active listing or a genuine completed sale. Precedence, most authoritative
// first:
//   1. any COMPLETE order — a completed sale is a terminal, authoritative fact and
//      always wins (ties broken by earliest createdAt, then orderItemId, so this is
//      deterministic even in the structurally-unexpected case of more than one).
//   2. else the most recently created NON-cancelled (pending) order — this is the
//      live reservation/payment state.
//   3. else null — only cancelled/no orders exist; the item's own status (already
//      reset to 'available' by cancellation) is what drives its stage, not history.
// Cancelled orders are never discarded — the caller still surfaces them in the
// timeline — this helper only decides what counts as "current".
export type ItemOrderCandidate = {
  orderItemId: string
  status: string // pending | complete | cancelled
}

export function selectCurrentOrder<T extends ItemOrderCandidate>(orders: T[], createdAtOf: (o: T) => Date): T | null {
  if (orders.length === 0) return null
  const sorted = [...orders].sort((a, b) =>
    createdAtOf(a).getTime() - createdAtOf(b).getTime() || a.orderItemId.localeCompare(b.orderItemId))
  const completed = sorted.find(o => o.status === 'complete')
  if (completed) return completed
  const active = sorted.filter(o => o.status !== 'cancelled')
  return active.length > 0 ? active[active.length - 1] : null
}

export type ItemLifecycleStageInput = {
  itemStatus: string // ItemInstance.status
  sourceType: string | null // 'consignment' | 'buyout' | 'company_owned' | null
  hasActiveListing: boolean
  hasCompletedOrder: boolean
  currentOrderStatus: string | null // status of the order selected by selectCurrentOrder, if any
  currentOrderPaymentStatus: string | null // Order.paymentStatus for that same order, null if none
  consignmentPayoutSettled: boolean | null // null = not applicable (not a consignment sale)
  contradictions: ItemContradiction[]
}

// The exact completion predicate (section 6, revised per 15C-review sections 3/4):
//   - 'paid': itemStatus='reserved' AND the CURRENT order's paymentStatus='paid' —
//     this schema proves payment was captured, nothing more; it is never relabeled
//     "fulfillment" because there is no persisted shipping/fulfillment state to prove
//     physical fulfillment is underway.
//   - 'sold': itemStatus='sold' (set atomically with order completion) but, for a
//     consignment sale, the seller payout obligation is not yet settled.
//   - 'completed': itemStatus='sold' AND order complete AND (not consignment, OR
//     consignment payout settled — paid/voided). Example: order complete + payout
//     unpaid -> stays 'sold', never 'completed'.
//   - 'inactive': itemStatus='not_for_sale' — this status means withdrawn/held/
//     archived (see markSellerItemReturned), NOT a successful sale, so it is never
//     reported as 'completed'.
export function deriveItemLifecycleStage(input: ItemLifecycleStageInput): ItemLifecycleStage {
  if (input.contradictions.length > 0) return 'exception'

  if (input.itemStatus === 'not_for_sale') return 'inactive'

  if (input.itemStatus === 'draft') return 'processing'

  if (input.itemStatus === 'available') {
    return input.hasActiveListing ? 'listed' : 'available'
  }

  if (input.itemStatus === 'reserved') {
    return input.currentOrderPaymentStatus === 'paid' ? 'paid' : 'reserved'
  }

  if (input.itemStatus === 'sold') {
    if (!input.hasCompletedOrder) return 'sold' // defensive; would normally be a contradiction
    if (input.sourceType === 'consignment' && input.consignmentPayoutSettled === false) return 'sold'
    return 'completed'
  }

  return 'exception' // unrecognized itemStatus — never silently guess
}

// ── Contradictions (section 17) — deterministic, provable from current schema only.
// Every check here is gated to fire ONLY once its authoritative triggering event has
// actually occurred — never during a normal pre-completion/pre-generation window
// (15C-review section 5). ──────────────────────────────────────────────────────────

export type ItemContradictionInput = {
  itemStatus: string
  hasActiveListing: boolean
  hasCompletedOrderItem: boolean
  sourceType: string | null
  hasAnyPayoutLine: boolean
  locationId: string | null
  sellerPortfolioId: string | null
  agreementPortfolioId: string | null | undefined // undefined = no agreement linked at all
  // 15C-review section 3: a bounded COUNT, not a loaded list — a physical item should
  // only ever be sold successfully once. If normal reservation/order-creation flow
  // already makes this structurally impossible, this simply never exceeds 1 in
  // practice; the check exists as a provable, non-silent backstop, not a guess.
  completedOrderCount: number
}

export function detectItemContradictions(input: ItemContradictionInput): ItemContradiction[] {
  const issues: ItemContradiction[] = []

  if (input.itemStatus === 'available' && input.hasCompletedOrderItem) {
    issues.push({
      code: 'available_but_sold_evidence',
      message: 'Item status is "available" but a completed order exists for it.',
    })
  }

  if (input.itemStatus === 'sold' && input.hasActiveListing) {
    issues.push({
      code: 'sold_but_listing_active',
      message: 'Item status is "sold" but its listing is still active.',
    })
  }

  if (input.hasActiveListing && !['available', 'reserved'].includes(input.itemStatus)) {
    issues.push({
      code: 'active_listing_status_mismatch',
      message: `An active listing exists but item status ("${input.itemStatus}") is incompatible with an active listing.`,
    })
  }

  // Gated on itemStatus === 'sold', which orders.ts sets ATOMICALLY (same transaction)
  // with Order.status='complete' — i.e. this is exactly "the authoritative event that
  // should have generated the payout obligation has occurred", never pending/
  // incomplete/cancelled order state (those never reach itemStatus='sold' at all).
  if (input.itemStatus === 'sold' && input.sourceType === 'consignment' && !input.hasAnyPayoutLine) {
    issues.push({
      code: 'consignment_sold_missing_payout',
      message: 'This consignment item is sold but has no seller payout line.',
    })
  }

  // Only 'available'/'reserved' truly require a known physical warehouse location —
  // sold/not_for_sale items may have shipped out or been returned to the seller, so
  // a null location there is expected, not an exception.
  if (['available', 'reserved'].includes(input.itemStatus) && !input.locationId) {
    issues.push({
      code: 'missing_storage_location',
      message: 'This sellable item has no storage location assigned.',
    })
  }

  // Explicit-FK-only: never inferred from seller identity — undefined means "no
  // agreement linked at all", which is not a mismatch, just absence of evidence.
  if (
    input.sellerPortfolioId !== null &&
    input.agreementPortfolioId !== undefined &&
    input.agreementPortfolioId !== input.sellerPortfolioId
  ) {
    issues.push({
      code: 'portfolio_agreement_mismatch',
      message: 'This item\'s portfolio does not match its linked agreement\'s portfolio.',
    })
  }

  if (input.completedOrderCount > 1) {
    issues.push({
      code: 'multiple_completed_sales',
      message: `This item has ${input.completedOrderCount} completed sales — a physical item should only sell once.`,
    })
  }

  return issues
}
