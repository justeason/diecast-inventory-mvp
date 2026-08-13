// 15D: pure logic for the bulk intake workbench — progress/count math, overage
// detection, deterministic risk flags, and lease-state helpers. No DB access (see
// intakeWorkbenchQuery.ts for that boundary). Mirrors the itemLifecycle.ts /
// itemLifecycleQuery.ts pure/DB-boundary split.
//
// ── Count definitions (section 13/14) — kept intentionally distinct, never conflated:
//   expected  = SellerInboundShipment.expectedQuantity (seller-declared, informational)
//   received  = SellerInboundShipment.receivedQuantity (admin-confirmed TOTAL physical
//               count, set exactly once by the existing receiveSellerInboundShipment
//               action — the workbench never writes this field, only consumes it, so a
//               120-unit receipt can never become "240 received" from item-by-item
//               confirms)
//   processed = count of converted IntakeDraft rows linked to this shipment (= created
//               ItemInstance count)
//   exceptions = count of unresolved (unconverted, exception-flagged) IntakeDraft rows
//               linked to this shipment — the 15E hand-off queue
//   remaining = received - processed - exceptions (only meaningful once received is
//               known; null otherwise)

export type WorkbenchCountsInput = {
  expectedQuantity: number
  receivedQuantity: number | null
  processedCount: number
  exceptionCount: number
}

export type WorkbenchProgress = {
  expected: number
  received: number | null
  processed: number
  exceptions: number
  remaining: number | null
}

export function computeWorkbenchProgress(input: WorkbenchCountsInput): WorkbenchProgress {
  const remaining =
    input.receivedQuantity == null
      ? null
      : Math.max(0, input.receivedQuantity - input.processedCount - input.exceptionCount)

  return {
    expected: input.expectedQuantity,
    received: input.receivedQuantity,
    processed: input.processedCount,
    exceptions: input.exceptionCount,
    remaining,
  }
}

// Section 24: "complete" requires processed count reconciled against received, AND no
// unresolved exceptions — never shown as complete while exceptions remain, and never
// derived from expectedQuantity (seller-declared, not admin-confirmed).
export type WorkbenchCompletionResult = { complete: boolean; blockedReasons: string[] }

export function evaluateWorkbenchCompletion(progress: WorkbenchProgress): WorkbenchCompletionResult {
  const blockedReasons: string[] = []
  if (progress.received == null) {
    blockedReasons.push('Shipment has not been marked received yet.')
  } else if (progress.processed < progress.received) {
    blockedReasons.push(`${progress.received - progress.processed} received unit(s) not yet processed.`)
  }
  if (progress.exceptions > 0) {
    blockedReasons.push(`${progress.exceptions} unresolved exception(s).`)
  }
  return { complete: blockedReasons.length === 0, blockedReasons }
}

// Section 17: an item is "unexpected" when confirming it would push the accounted-for
// count (already processed + already exceptioned + this confirm's quantity) past the
// admin-confirmed received total. Gated on `receivedQuantity` — the only count that
// represents physical units actually confirmed in hand — never on expectedQuantity
// (which is merely what the seller said they'd ship).
export function wouldExceedReceived(
  receivedQuantity: number | null,
  alreadyAccountedFor: number,
  incomingQuantity: number,
): boolean {
  if (receivedQuantity == null) return false
  return alreadyAccountedFor + incomingQuantity > receivedQuantity
}

// ── Section 19: deterministic hand-off flags for 15E/15F — never an invented risk
// score, just named, individually-explainable booleans. ──────────────────────────────

export type IntakeRiskFlag = { code: string; message: string }

export type IntakeRiskInput = {
  pricingConfidence: 'high' | 'medium' | 'low' | 'insufficient' | null
  catalogConfidence: 'exact' | 'strong' | 'possible' | null
  estimatedValueCents: number | null
  highValueThresholdCents: number
}

export function deriveIntakeRiskFlags(input: IntakeRiskInput): IntakeRiskFlag[] {
  const flags: IntakeRiskFlag[] = []

  if (input.pricingConfidence === 'low' || input.pricingConfidence === 'insufficient') {
    flags.push({ code: 'pricing_confidence_low', message: 'Pricing intelligence confidence is low for this model.' })
  }
  if (input.catalogConfidence === 'possible') {
    flags.push({ code: 'catalog_confidence_low', message: 'Catalog match confidence is low — verify the model manually.' })
  }
  if (input.estimatedValueCents != null && input.estimatedValueCents >= input.highValueThresholdCents) {
    flags.push({ code: 'high_value', message: `Estimated value is at or above the $${(input.highValueThresholdCents / 100).toFixed(2)} review threshold.` })
  }

  return flags
}

// Configurable in code only — no admin settings UI in 15D's scope.
export const DEFAULT_HIGH_VALUE_THRESHOLD_CENTS = 20000

export function describeCatalogConfidence(confidence: 'exact' | 'strong' | 'possible'): 'High' | 'Medium' | 'Low' {
  if (confidence === 'exact') return 'High'
  if (confidence === 'strong') return 'Medium'
  return 'Low'
}

// ── Section 21: lease helpers — DB-backed, expiring, renewable, explicit takeover
// only. Claim/renew/release (actions/intakeWorkbench.ts) are informational (page-load
// banner, takeover button); the actual write guard against two simultaneous
// confirmers/reconcilers is the equivalent check run INSIDE confirmWorkbenchItem's and
// reconcileWorkbenchShipment's own transactions (15D-review section 2), which reuses
// the same active/expired decision this module expresses. ─────────────────────────

export type WorkbenchLeaseRow = { claimToken: string; expiresAt: Date } | null

export function isLeaseActive(lease: WorkbenchLeaseRow, now: Date): boolean {
  return lease !== null && lease.expiresAt.getTime() > now.getTime()
}

export function isLeaseHeldByOther(lease: WorkbenchLeaseRow, myClaimToken: string, now: Date): boolean {
  return isLeaseActive(lease, now) && lease!.claimToken !== myClaimToken
}

export const WORKBENCH_LEASE_TTL_MS = 5 * 60 * 1000
export const MAX_WORKBENCH_BATCH_QUANTITY = 20

// ── Physical reconciliation (15D-review "final financial & reconciliation pass",
// sections 2/3) ──────────────────────────────────────────────────────────────────────
// `remaining === 0` is NEVER, by itself, "complete" — completion requires an explicit,
// audited admin action (reconcileWorkbenchShipment) confirming the physically observed
// count. Two independent axes are tracked, never conflated:
//   1. reconciliation status — has an admin explicitly confirmed the physical count,
//      and does that confirmation still match the CURRENT counts (isReconciliationCurrent)?
//   2. unresolved exceptions — a live, independent fact; a shipment CAN be physically
//      reconciled (every unit accounted for) while individual units still await 15E
//      resolution — see the worked example in the review: 200 observed (194 processed
//      + 3 exceptions) against 200 recorded = reconciled, exceptions still remain.

// observedPhysical: every physical unit this shipment has produced evidence for —
// either successfully converted (processed) or captured-but-unresolved (exceptions).
// Never derived from expectedQuantity or receivedQuantity themselves.
export function computeObservedPhysical(processedCount: number, exceptionCount: number): number {
  return processedCount + exceptionCount
}

// variance: positive = more physical units observed than recorded received (overage);
// negative = fewer (shortage). Zero = exact match.
export function computeReconciliationVariance(recordedReceived: number, observedPhysical: number): number {
  return observedPhysical - recordedReceived
}

export type ReconciliationCounts = { recordedReceived: number; observedPhysical: number }

// A prior reconciliation event is only truthful RIGHT NOW if the counts it captured
// still match the current live counts — otherwise items/exceptions have changed since
// (e.g. an exception got resolved into a conversion), and the shipment must revert to
// "in progress" until reconciled again. This is what prevents a stale "Reconciled"
// label from silently surviving a later state change.
export function isReconciliationCurrent(snapshot: ReconciliationCounts | null, current: ReconciliationCounts): boolean {
  return snapshot !== null
    && snapshot.recordedReceived === current.recordedReceived
    && snapshot.observedPhysical === current.observedPhysical
}

export type IntakeReconciliationStatus = 'in_progress' | 'reconciled' | 'reconciled_with_variance'

// Pass null when no CURRENT (see isReconciliationCurrent) reconciliation snapshot
// exists — always 'in_progress' in that case, regardless of how close remaining is to
// zero. A snapshot with variance !== 0 is 'reconciled_with_variance', never silently
// upgraded to plain 'reconciled'.
export function deriveIntakeReconciliationStatus(currentSnapshot: { variance: number } | null): IntakeReconciliationStatus {
  if (!currentSnapshot) return 'in_progress'
  return currentSnapshot.variance === 0 ? 'reconciled' : 'reconciled_with_variance'
}
