// 15B: pure logic for SellerPortfolio — stage derivation and attention signals. No DB
// access (see sellerPortfolioQuery.ts for that boundary), mirrors the sellerLifecycle.ts
// pure/DB-boundary split used for submission lifecycle.
//
// Stage is DERIVED from linked-record facts, never trusted from a stored value — see
// derivePortfolioStage. The only stored, admin-writable states are
// draft | open | completed | cancelled (SellerPortfolio.status); the five operational
// in-between stages (awaiting_agreement/awaiting_shipment/inbound/intake/active) are
// always computed, so the displayed stage can never silently drift from reality.

export type PortfolioStage =
  | 'awaiting_agreement'
  | 'awaiting_shipment'
  | 'inbound'
  | 'intake'
  | 'active'
  | 'completed'
  | 'cancelled'

export type PortfolioStageInput = {
  status: string // SellerPortfolio.status: draft | open | completed | cancelled
  hasAcceptedAgreement: boolean
  hasNonCancelledShipment: boolean
  anyShipmentInTransit: boolean // shipped, not yet received/issue
  receivedItemCount: number // sum of receivedQuantity across non-cancelled shipments
  intakeCompleteCount: number // count of converted IntakeDrafts under this portfolio
  allInventoryResolved: boolean // every portfolio ItemInstance is sold/not_for_sale AND no outstanding payout liability
  hasOutstandingPayoutLiability: boolean
  // 15B-review section 4: an open intake exception (rejected draft or open/
  // action_required lifecycle case) means this portfolio's intake is NOT actually
  // finished, even if received <= intakeComplete numerically — must block 'completed'.
  hasOpenIntakeException: boolean
  // A shipment explicitly marked 'issue' (damaged/wrong-quantity/etc, set by
  // receiveSellerInboundShipment) is an unresolved inbound discrepancy that requires
  // admin resolution before the portfolio can be considered done — must block
  // 'completed'. This is the schema's authoritative "needs resolution" signal, not an
  // inferred raw quantity mismatch (which can have legitimate operational
  // explanations tracked elsewhere and is surfaced only as an attention signal).
  hasUnresolvedInboundDiscrepancy: boolean
}

export type PortfolioStageResult = {
  stage: PortfolioStage
  // true when the stored status (only meaningful for 'completed') no longer matches
  // what the underlying data implies — surfaced as an attention signal, not hidden.
  statusMismatch: boolean
}

// The exact completion predicate (section 4): a portfolio is 'completed' only when
// ALL of the following hold —
//   1. an agreement was accepted
//   2. at least one non-cancelled shipment exists and none are still in transit
//   3. all received items have completed intake (receivedItemCount <= intakeCompleteCount)
//   4. allInventoryResolved: every portfolio ItemInstance is sold/not_for_sale (no
//      unsold/unresolved owned consignment inventory left active/available)
//   5. no outstanding seller payout liability (eligible/held, unpaid)
//   6. no open intake exception (rejected draft / open lifecycle case)
//   7. no unresolved inbound discrepancy (a shipment flagged 'issue')
// Any one of 4-7 failing falls back to 'active' (work remains), never silently to
// 'completed'. This is intentionally not "impossible perfection" — it only requires
// facts this schema can already prove.
function deriveOperationalStage(input: PortfolioStageInput): Exclude<PortfolioStage, 'cancelled'> {
  if (!input.hasAcceptedAgreement) return 'awaiting_agreement'
  if (!input.hasNonCancelledShipment) return 'awaiting_shipment'
  if (input.anyShipmentInTransit) return 'inbound'
  if (input.receivedItemCount > input.intakeCompleteCount) return 'intake'
  if (
    input.allInventoryResolved &&
    !input.hasOutstandingPayoutLiability &&
    !input.hasOpenIntakeException &&
    !input.hasUnresolvedInboundDiscrepancy
  ) return 'completed'
  return 'active'
}

export function derivePortfolioStage(input: PortfolioStageInput): PortfolioStageResult {
  if (input.status === 'cancelled') return { stage: 'cancelled', statusMismatch: false }

  const dataStage = deriveOperationalStage(input)

  if (input.status === 'completed') {
    // Admin explicitly marked this done — but never display "Completed" if current
    // data contradicts it (e.g. new outstanding liability reappeared after closing).
    const mismatch = dataStage !== 'completed'
    return { stage: mismatch ? dataStage : 'completed', statusMismatch: mismatch }
  }

  return { stage: dataStage, statusMismatch: false }
}

// A portfolio may only be marked 'completed' if the data-derived stage already agrees
// — prevents "Completed while payout liability remains unexpectedly outstanding"
// (section 16) at the point of the admin action, not just at display time.
export function canMarkPortfolioCompleted(input: PortfolioStageInput): { ok: true } | { ok: false; reason: string } {
  const dataStage = deriveOperationalStage(input)
  if (dataStage !== 'completed') {
    let reason = 'This portfolio has unresolved inventory or intake and cannot be marked completed yet.'
    if (input.hasOutstandingPayoutLiability) {
      reason = 'This portfolio still has outstanding seller payout liability and cannot be marked completed.'
    } else if (input.hasOpenIntakeException) {
      reason = 'This portfolio has an open intake exception that must be resolved before it can be marked completed.'
    } else if (input.hasUnresolvedInboundDiscrepancy) {
      reason = 'This portfolio has an unresolved inbound shipment issue that must be resolved before it can be marked completed.'
    }
    return { ok: false, reason }
  }
  return { ok: true }
}

// ── Attention signals (section 17) — deterministic, provable from current schema only ──

export type PortfolioAttentionSignal = {
  code: string
  severity: 'warning' | 'critical'
  message: string
}

export type PortfolioAttentionInput = {
  status: string
  hasAnyAgreement: boolean
  hasAcceptedAgreement: boolean
  acceptedCount: number | null
  expectedShipmentQuantity: number | null // sum of SellerInboundShipment.expectedQuantity (non-cancelled)
  receivedShipmentQuantity: number | null // sum of SellerInboundShipment.receivedQuantity (non-cancelled, non-null)
  hasAnyShipment: boolean
  receivedItemCount: number
  intakeCompleteCount: number
  hasOpenIntakeException: boolean // any rejected IntakeDraft or open/action_required lifecycle case under this portfolio
  soldWithoutPayoutObligation: boolean
  outstandingEligiblePayoutCount: number
}

export function evaluatePortfolioAttentionSignals(input: PortfolioAttentionInput): PortfolioAttentionSignal[] {
  if (input.status === 'cancelled') return []

  const signals: PortfolioAttentionSignal[] = []

  if (
    input.receivedShipmentQuantity !== null &&
    input.expectedShipmentQuantity !== null &&
    input.receivedShipmentQuantity !== input.expectedShipmentQuantity
  ) {
    signals.push({
      code: 'received_quantity_mismatch',
      severity: 'warning',
      message: `Received quantity (${input.receivedShipmentQuantity}) differs from expected shipment quantity (${input.expectedShipmentQuantity}).`,
    })
  }

  if (
    input.hasAcceptedAgreement &&
    input.acceptedCount !== null &&
    input.expectedShipmentQuantity !== null &&
    input.acceptedCount !== input.expectedShipmentQuantity
  ) {
    signals.push({
      code: 'accepted_vs_expected_mismatch',
      severity: 'warning',
      message: `Agreement accepted count (${input.acceptedCount}) differs from expected shipment quantity (${input.expectedShipmentQuantity}).`,
    })
  }

  if (input.receivedItemCount > input.intakeCompleteCount) {
    signals.push({
      code: 'received_not_intaken',
      severity: 'warning',
      message: `${input.receivedItemCount - input.intakeCompleteCount} item(s) received but not yet completed through intake.`,
    })
  }

  if (!input.hasAnyAgreement && input.status !== 'draft') {
    signals.push({
      code: 'agreement_missing',
      severity: 'critical',
      message: 'This portfolio has no commercial agreement yet.',
    })
  }

  if (input.hasAcceptedAgreement && !input.hasAnyShipment) {
    signals.push({
      code: 'shipment_missing',
      severity: 'warning',
      message: 'Agreement is accepted but no inbound shipment has been recorded.',
    })
  }

  if (input.hasOpenIntakeException) {
    signals.push({
      code: 'intake_exception',
      severity: 'critical',
      message: 'An intake exception (rejected draft or open case) needs resolution.',
    })
  }

  if (input.soldWithoutPayoutObligation) {
    signals.push({
      code: 'sold_missing_payout_obligation',
      severity: 'critical',
      message: 'A sold item is missing its expected seller payout obligation.',
    })
  }

  if (input.outstandingEligiblePayoutCount > 0) {
    signals.push({
      code: 'payout_action_needed',
      severity: 'warning',
      message: `${input.outstandingEligiblePayoutCount} payout line(s) are eligible and awaiting batching/approval.`,
    })
  }

  return signals
}
