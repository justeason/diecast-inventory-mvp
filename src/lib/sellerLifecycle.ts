// Pure, server-safe helpers for deriving seller transaction lifecycle state.
// No database access — all inputs are passed in. Safe to import from client or
// server components and to unit-test in isolation.

// ─── Stage / attention types ──────────────────────────────────────────────────

export type LifecycleStage =
  | 'submitted' | 'under_review' | 'approved_for_intake'
  | 'agreement_pending' | 'agreement_accepted' | 'awaiting_item'
  | 'intake_in_progress' | 'intake_rejected'
  | 'inventory_received' | 'ready_to_list' | 'listed'
  | 'sale_pending' | 'sold'
  | 'payout_eligible' | 'payout_preparing' | 'payout_approved' | 'paid'
  | 'closed'

export type AttentionStatus =
  | 'none' | 'on_hold' | 'return_in_progress' | 'dispute_open'
  | 'withdrawal_requested' | 'expired' | 'lost_or_damaged' | 'manual_review'

export type SellerLifecycleSummary = {
  stage: LifecycleStage
  attention: AttentionStatus
  label: string
  sellerDescription: string
  nextStep: string | null
}

// ─── Derivation inputs ─────────────────────────────────────────────────────────

export type LifecycleInput = {
  submission: { status: string }
  agreements: Array<{
    id: string
    type: string
    status: string
    proposedAt?: Date | null
    acceptedAt?: Date | null
  }>
  intakeDrafts: Array<{ status: string; convertedItemId: string | null }>
  items: Array<{
    status: string
    sourceType: string | null
    listing?: { status: string } | null
  }>
  payoutLines: Array<{
    status: string
    payoutId: string | null
    payout?: { status: string } | null
  }>
  openCases: Array<{ caseType: string; status: string }>
}

// ─── Labels ────────────────────────────────────────────────────────────────────

export const STAGE_LABELS: Record<LifecycleStage, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  approved_for_intake: 'Approved for intake',
  agreement_pending: 'Agreement proposed',
  agreement_accepted: 'Agreement accepted',
  awaiting_item: 'Awaiting your item',
  intake_in_progress: 'Intake in progress',
  intake_rejected: 'Intake review completed',
  inventory_received: 'Item received',
  ready_to_list: 'Preparing to list',
  listed: 'Listed for sale',
  sale_pending: 'Sale pending',
  sold: 'Sold',
  payout_eligible: 'Payout eligible',
  payout_preparing: 'Payout preparing',
  payout_approved: 'Payout approved',
  paid: 'Paid',
  closed: 'Closed',
}

export const STAGE_DESCRIPTIONS: Record<LifecycleStage, string> = {
  submitted: 'Your request has been received and is waiting for review.',
  under_review: 'Our team is reviewing your submission.',
  approved_for_intake: 'Your submission was approved. We are preparing to receive your item.',
  agreement_pending: 'We have proposed agreement terms. Please review them.',
  agreement_accepted: 'You accepted the agreement terms. Next we will receive your item.',
  awaiting_item: 'We are waiting to receive and process your item.',
  intake_in_progress: 'We are inspecting and cataloging your item.',
  intake_rejected: 'We completed the intake review. See the details for next steps.',
  inventory_received: 'We have received your item into inventory.',
  ready_to_list: 'Your item is being prepared for listing.',
  listed: 'Your item is listed for sale.',
  sale_pending: 'A buyer has reserved your item and the sale is in progress.',
  sold: 'Your item has sold.',
  payout_eligible: 'Your payout is eligible and awaiting batching.',
  payout_preparing: 'We are preparing your payout.',
  payout_approved: 'Your payout has been approved and is scheduled for payment.',
  paid: 'Your payment has been recorded.',
  closed: 'This request is closed.',
}

export const STAGE_NEXT_STEPS: Record<LifecycleStage, string | null> = {
  submitted: 'No action needed — we will review shortly.',
  under_review: 'No action needed while we review.',
  approved_for_intake: 'We will coordinate receiving your item.',
  agreement_pending: 'Review the proposed terms and contact us with any questions.',
  agreement_accepted: 'Arrange to get your item to us if you have not already.',
  awaiting_item: 'Get your item to us so we can process it.',
  intake_in_progress: 'No action needed while we inspect your item.',
  intake_rejected: 'Review the intake result details.',
  inventory_received: 'No action needed.',
  ready_to_list: 'No action needed.',
  listed: 'No action needed — we will notify you when it sells.',
  sale_pending: 'No action needed.',
  sold: 'No action needed — a payout will follow.',
  payout_eligible: 'No action needed — your payout is queued.',
  payout_preparing: 'No action needed.',
  payout_approved: 'No action needed — payment is scheduled.',
  paid: null,
  closed: null,
}

export const ATTENTION_LABELS: Record<AttentionStatus, string> = {
  none: '',
  on_hold: 'On hold',
  return_in_progress: 'Return in progress',
  dispute_open: 'Under review',
  withdrawal_requested: 'Withdrawal requested',
  expired: 'Consignment ended',
  lost_or_damaged: 'Item issue under review',
  manual_review: 'Manual review',
}

export const ATTENTION_DESCRIPTIONS: Record<AttentionStatus, string> = {
  none: '',
  on_hold: 'A payout related to this request is temporarily on hold.',
  return_in_progress: 'A return is in progress for this request.',
  dispute_open: 'This sale is under review.',
  withdrawal_requested: 'A withdrawal has been requested for this request.',
  expired: 'The consignment period for this item has ended.',
  lost_or_damaged: 'An item issue is under review.',
  manual_review: 'This request requires manual review by our team.',
}

// ─── Stage derivation ──────────────────────────────────────────────────────────

export function deriveLifecycleStage(input: LifecycleInput): LifecycleStage {
  const { submission, agreements, intakeDrafts, items, payoutLines } = input

  // 1. Payout state (highest priority for terminal stages).
  if (payoutLines.some((l) => l.payout?.status === 'paid')) return 'paid'
  if (payoutLines.some((l) => l.payout?.status === 'approved')) return 'payout_approved'
  if (payoutLines.some((l) => l.payout?.status === 'draft')) return 'payout_preparing'
  if (payoutLines.some((l) => l.status === 'eligible' && !l.payoutId)) return 'payout_eligible'

  // 2. Item / listing state.
  if (items.some((i) => i.status === 'sold')) return 'sold'
  if (items.some((i) => i.status === 'reserved')) return 'sale_pending'
  if (items.some((i) => i.listing?.status === 'active')) return 'listed'
  if (
    items.some(
      (i) => i.status === 'available' && i.sourceType === 'consignment' && !i.listing,
    )
  ) {
    return 'ready_to_list'
  }
  if (items.some((i) => i.status === 'available' && i.sourceType === 'buyout')) {
    return 'inventory_received'
  }
  // Any other available item (e.g. company_owned) counts as received.
  if (items.some((i) => i.status === 'available')) return 'inventory_received'

  // 3. Intake state.
  const rejectedNoConversion = intakeDrafts.some(
    (d) => d.status === 'rejected' && !d.convertedItemId,
  )
  if (rejectedNoConversion) return 'intake_rejected'
  if (intakeDrafts.some((d) => d.status === 'draft' || d.status === 'reviewed')) {
    return 'intake_in_progress'
  }

  // 4. Agreement state.
  const acceptedAgreement = agreements.find((a) => a.status === 'accepted')
  if (acceptedAgreement && intakeDrafts.length === 0) return 'awaiting_item'
  if (agreements.some((a) => a.status === 'proposed')) return 'agreement_pending'

  // 5. Submission status.
  if (submission.status === 'approved_for_intake') return 'approved_for_intake'
  if (submission.status === 'under_review') return 'under_review'
  return 'submitted'
}

// ─── Attention derivation ──────────────────────────────────────────────────────

export function deriveAttentionStatus(input: LifecycleInput): AttentionStatus {
  const { openCases, payoutLines } = input
  const isOpen = (c: { status: string }) =>
    c.status === 'open' || c.status === 'action_required'
  const openOfType = (t: string) => openCases.some((c) => c.caseType === t && isOpen(c))

  const hasOpenCase = openCases.some(isOpen)
  const hasApprovedOrPaidPayout = payoutLines.some(
    (l) => l.payout?.status === 'approved' || l.payout?.status === 'paid',
  )

  // Manual review: an open case coincides with an approved/paid payout.
  if (hasOpenCase && hasApprovedOrPaidPayout) return 'manual_review'

  if (openOfType('lost_or_damaged')) return 'lost_or_damaged'
  if (openOfType('buyer_return') || openOfType('buyer_dispute')) return 'dispute_open'
  if (openOfType('consignment_expiration')) return 'expired'
  if (openOfType('return_to_seller')) return 'return_in_progress'
  if (openOfType('seller_withdrawal')) return 'withdrawal_requested'

  if (payoutLines.some((l) => l.status === 'held')) return 'on_hold'

  return 'none'
}

// ─── Summary ───────────────────────────────────────────────────────────────────

export function deriveSellerLifecycleSummary(input: LifecycleInput): SellerLifecycleSummary {
  const stage = deriveLifecycleStage(input)
  const attention = deriveAttentionStatus(input)
  return {
    stage,
    attention,
    label: STAGE_LABELS[stage],
    sellerDescription: STAGE_DESCRIPTIONS[stage],
    nextStep: STAGE_NEXT_STEPS[stage],
  }
}

// ─── Seller-safe case type labels ──────────────────────────────────────────────

export const CASE_TYPE_LABELS: Record<string, string> = {
  buyer_dispute: 'Payment under review',
  buyer_return: 'Return in progress',
  lost_or_damaged: 'Item issue under review',
  intake_rejection: 'Intake review completed',
  return_to_seller: 'Return in progress',
  consignment_expiration: 'Consignment ended',
  seller_withdrawal: 'Withdrawal recorded',
  other: 'Issue under review',
}

export function sellerSafeCaseLabel(caseType: string): string {
  return CASE_TYPE_LABELS[caseType] ?? 'Issue under review'
}

// ─── Timeline ──────────────────────────────────────────────────────────────────

export type TimelineEvent = {
  key: string
  source: 'persisted' | 'synthesized'
  eventType: string
  title: string
  description: string | null
  adminDescription: string | null
  sellerVisible: boolean
  occurredAt: Date
}

export type TimelineInput = {
  submission: { createdAt: Date; status: string }
  agreements: Array<{
    id: string
    proposedAt?: Date | null
    acceptedAt?: Date | null
    cancelledAt?: Date | null
    type: string
    status: string
  }>
  intakeDrafts: Array<{
    id: string
    createdAt: Date
    updatedAt: Date
    status: string
    rejectedAt?: Date | null
    sellerRejectionReason?: string | null
  }>
  items: Array<{ id: string; createdAt: Date; sourceType: string | null }>
  listings: Array<{ id: string; createdAt: Date; status: string }>
  orderItems: Array<{
    id: string
    order: { id: string; status: string; completedAt?: Date | null }
  }>
  payoutLines: Array<{
    id: string
    eligibleAt: Date
    lineType: string
    heldAt?: Date | null
    voidedAt?: Date | null
    payout?: { status: string; approvedAt?: Date | null; paidAt?: Date | null } | null
  }>
  persistedEvents: Array<{
    eventKey: string
    eventType: string
    sellerTitle?: string | null
    sellerDescription?: string | null
    adminDescription?: string | null
    sellerVisible: boolean
    occurredAt: Date
  }>
}

// ─── Event key builders ────────────────────────────────────────────────────────

export function agreementEventKey(event: string, agreementId: string): string {
  return `${event}:${agreementId}`
}
export function intakeEventKey(event: string, intakeDraftId: string): string {
  return `${event}:${intakeDraftId}`
}
export function listingEventKey(event: string, listingId: string): string {
  return `${event}:${listingId}`
}
export function orderEventKey(event: string, orderId: string): string {
  return `${event}:${orderId}`
}
export function payoutLineEventKey(event: string, lineId: string, suffix?: string): string {
  return suffix ? `${event}:${lineId}:${suffix}` : `${event}:${lineId}`
}
export function payoutEventKey(event: string, payoutId: string): string {
  return `${event}:${payoutId}`
}
export function caseEventKey(event: string, caseId: string): string {
  return `${event}:${caseId}`
}

export function buildSellerLifecycleTimeline(
  input: TimelineInput,
  options: { sellerView?: boolean } = {},
): TimelineEvent[] {
  const synthesized: TimelineEvent[] = []

  const push = (
    key: string,
    eventType: string,
    occurredAt: Date,
    title: string,
    description: string | null,
    sellerVisible: boolean,
  ) => {
    synthesized.push({
      key,
      source: 'synthesized',
      eventType,
      title,
      description,
      adminDescription: null,
      sellerVisible,
      occurredAt,
    })
  }

  // Submission received.
  push(
    'submission-received',
    'submission_received',
    input.submission.createdAt,
    'Request received',
    'We received your sell request.',
    true,
  )

  // Agreements.
  for (const a of input.agreements) {
    if (a.proposedAt) {
      push(
        agreementEventKey('agreement-proposed', a.id),
        'agreement_proposed',
        a.proposedAt,
        'Agreement proposed',
        'We proposed agreement terms for your item.',
        true,
      )
    }
    if (a.acceptedAt) {
      push(
        agreementEventKey('agreement-accepted', a.id),
        'agreement_accepted',
        a.acceptedAt,
        'Agreement accepted',
        'The agreement terms were accepted.',
        true,
      )
    }
  }

  // Intake started.
  for (const d of input.intakeDrafts) {
    push(
      intakeEventKey('intake-started', d.id),
      'intake_started',
      d.createdAt,
      'Intake started',
      'We started inspecting and cataloging your item.',
      true,
    )
  }

  // Items received.
  for (const item of input.items) {
    push(
      `item-received:${item.id}`,
      'item_received',
      item.createdAt,
      'Item received',
      'Your item was received into inventory.',
      true,
    )
  }

  // Listings created.
  for (const l of input.listings) {
    push(
      listingEventKey('listing-created', l.id),
      'listing_created',
      l.createdAt,
      'Listed for sale',
      'Your item was listed for sale.',
      true,
    )
  }

  // Orders completed.
  for (const oi of input.orderItems) {
    if (oi.order.completedAt) {
      push(
        orderEventKey('order-completed', oi.order.id),
        'order_completed',
        oi.order.completedAt,
        'Sale completed',
        'The sale of your item was completed.',
        true,
      )
    }
  }

  // Payout milestones.
  for (const line of input.payoutLines) {
    push(
      payoutLineEventKey('payout-eligible', line.id),
      'payout_eligible',
      line.eligibleAt,
      'Payout eligible',
      'Your payout became eligible.',
      false,
    )
    if (line.payout?.approvedAt) {
      push(
        payoutLineEventKey('payout-approved', line.id),
        'payout_approved',
        line.payout.approvedAt,
        'Payout approved',
        'Your payout was approved.',
        true,
      )
    }
    if (line.payout?.paidAt) {
      push(
        payoutLineEventKey('payout-paid', line.id),
        'payout_paid',
        line.payout.paidAt,
        'Payment recorded',
        'We recorded your payout as paid.',
        true,
      )
    }
  }

  // Merge persisted events (persisted wins on duplicate key).
  const byKey = new Map<string, TimelineEvent>()
  for (const e of synthesized) {
    byKey.set(e.key, e)
  }
  for (const p of input.persistedEvents) {
    byKey.set(p.eventKey, {
      key: p.eventKey,
      source: 'persisted',
      eventType: p.eventType,
      title: p.sellerTitle ?? p.eventType,
      description: p.sellerDescription ?? null,
      adminDescription: p.adminDescription ?? null,
      sellerVisible: p.sellerVisible,
      occurredAt: p.occurredAt,
    })
  }

  let events = [...byKey.values()]

  if (options.sellerView) {
    events = events
      .filter((e) => e.sellerVisible)
      .map((e) => ({ ...e, adminDescription: null }))
  }

  events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  return events
}

// ─── Financial reconciliation warnings ─────────────────────────────────────────

export type LifecycleWarning = {
  code: string
  severity: 'warning' | 'critical'
  message: string
}

export type ReconciliationInput = {
  cases: Array<{
    id: string
    caseType: string
    status: string
    returnedAt?: Date | null
    itemInstanceId?: string | null
    listingId?: string | null
    orderItemId?: string | null
  }>
  payoutLines: Array<{
    id: string
    status: string
    payoutId: string | null
    orderItemId?: string | null
    payout?: { status: string } | null
  }>
  items: Array<{
    id: string
    status: string
    listing?: { status: string } | null
  }>
  intakeDrafts: Array<{ status: string; convertedItemId: string | null }>
}

export function findLifecycleFinancialWarnings(
  input: ReconciliationInput,
): LifecycleWarning[] {
  const warnings: LifecycleWarning[] = []
  const isOpen = (s: string) => s === 'open' || s === 'action_required'

  const openCases = input.cases.filter((c) => isOpen(c.status))
  const resolvedCases = input.cases.filter((c) => c.status === 'resolved')

  const disputeOrReturnOpen = openCases.filter(
    (c) => c.caseType === 'buyer_dispute' || c.caseType === 'buyer_return',
  )

  // 1. Open dispute/return case + eligible unbatched unheld line → suggest hold.
  const eligibleUnheld = input.payoutLines.filter(
    (l) => l.status === 'eligible' && !l.payoutId,
  )
  if (disputeOrReturnOpen.length > 0 && eligibleUnheld.length > 0) {
    warnings.push({
      code: 'suggest_hold',
      severity: 'warning',
      message:
        'An open dispute or return case exists while an eligible payout line is unbatched. Consider holding the line until the case resolves.',
    })
  }

  // 2. Open case + line in draft payout → action required.
  const inDraftPayout = input.payoutLines.filter((l) => l.payout?.status === 'draft')
  if (openCases.length > 0 && inDraftPayout.length > 0) {
    warnings.push({
      code: 'action_required_draft_payout',
      severity: 'warning',
      message:
        'An open case exists while a related payout line is in a draft payout. Remove the line from the draft batch before it is approved.',
    })
  }

  // 3. Open case + approved payout → critical manual review.
  const inApprovedPayout = input.payoutLines.filter((l) => l.payout?.status === 'approved')
  if (openCases.length > 0 && inApprovedPayout.length > 0) {
    warnings.push({
      code: 'critical_approved_payout',
      severity: 'critical',
      message:
        'An open case exists while a related payout is already approved. Manual review is required — do not send payment until resolved.',
    })
  }

  // 4. Open case + paid payout → critical manual review.
  const inPaidPayout = input.payoutLines.filter((l) => l.payout?.status === 'paid')
  if (openCases.length > 0 && inPaidPayout.length > 0) {
    warnings.push({
      code: 'critical_paid_payout',
      severity: 'critical',
      message:
        'An open case exists while a related payout has already been paid. Manual review and possible recovery is required.',
    })
  }

  // 5. Resolved case + held line → suggest release.
  const heldLines = input.payoutLines.filter((l) => l.status === 'held')
  if (resolvedCases.length > 0 && heldLines.length > 0) {
    warnings.push({
      code: 'suggest_release',
      severity: 'warning',
      message:
        'A case is resolved while a payout line remains on hold. Consider releasing the hold if no further action is needed.',
    })
  }

  // 6. Returned item (returnedAt set on case) + active listing.
  const returnedCases = input.cases.filter((c) => c.returnedAt)
  for (const c of returnedCases) {
    const item = c.itemInstanceId
      ? input.items.find((i) => i.id === c.itemInstanceId)
      : null
    if (item?.listing?.status === 'active') {
      warnings.push({
        code: 'returned_item_active_listing',
        severity: 'warning',
        message:
          'An item marked as returned still has an active listing. Archive the listing to prevent it from selling.',
      })
    }
  }

  // 7. Intake rejected + converted item exists.
  const rejectedButConverted = input.intakeDrafts.some(
    (d) => d.status === 'rejected' && d.convertedItemId,
  )
  if (rejectedButConverted) {
    warnings.push({
      code: 'intake_rejected_with_conversion',
      severity: 'critical',
      message:
        'An intake draft is rejected but has a converted inventory item. This is inconsistent and requires manual review.',
    })
  }

  // 8. Return case resolved but no returnedAt.
  const returnResolvedNoReturnedAt = input.cases.some(
    (c) =>
      (c.caseType === 'buyer_return' || c.caseType === 'return_to_seller') &&
      c.status === 'resolved' &&
      !c.returnedAt,
  )
  if (returnResolvedNoReturnedAt) {
    warnings.push({
      code: 'return_resolved_without_returned_at',
      severity: 'warning',
      message:
        'A return case is resolved but no returned date is recorded. Confirm the item was received back.',
    })
  }

  return warnings
}
