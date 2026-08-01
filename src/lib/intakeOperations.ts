// Pure operational helpers — no DB access

export type IntakeOperationalStage =
  | 'expected'
  | 'received'
  | 'in_review'
  | 'ready_to_convert'
  | 'action_required'
  | 'rejected'
  | 'converted'
  | 'returned'
  | 'closed'

export type IntakeWarning =
  | 'qty_mismatch'
  | 'no_storage'
  | 'stale_received'
  | 'stale_reviewed'
  | 'open_case'
  | 'agreement_needed'
  | 'converted_no_item'
  | 'rejected_with_item'
  | 'approved_no_intake'
  | 'missing_catalog'
  | 'returned_with_listing'

export const INTAKE_STAGE_LABELS: Record<IntakeOperationalStage, string> = {
  expected:          'Expected',
  received:          'Received',
  in_review:         'In Review',
  ready_to_convert:  'Ready to Convert',
  action_required:   'Action Required',
  rejected:          'Rejected',
  converted:         'Converted',
  returned:          'Returned',
  closed:            'Closed',
}

export const INTAKE_WARNING_LABELS: Record<IntakeWarning, string> = {
  qty_mismatch:          'Qty mismatch',
  no_storage:            'No storage assigned',
  stale_received:        'Stale (received >7d)',
  stale_reviewed:        'Stale (reviewed >3d)',
  open_case:             'Open case',
  agreement_needed:      'Agreement needed',
  converted_no_item:     'Converted but item missing',
  rejected_with_item:    'Rejected with linked item',
  approved_no_intake:    'Approved — no intake started',
  missing_catalog:       'No catalog link',
  returned_with_listing: 'Returned with active listing',
}

type Agreement = { status: string }
type LifecycleCase = {
  status: string
  caseType: string
  intakeDraftId?: string | null
  returnedAt?: Date | null
}

export type IntakeRecord = {
  submission: {
    id: string
    status: string
    quantity: number
    catalogId?: string | null
    agreements: Agreement[]
    lifecycleCases: LifecycleCase[]
    createdAt: Date
  } | null
  intake: {
    id: string
    status: string
    receivedAt: Date | null
    receivedQuantity: number | null
    expectedQuantity: number | null
    storageLocationId: string | null
    convertedItemId: string | null
    hasActiveListing?: boolean | null
    createdAt: Date
  } | null
  now?: Date
}

export type IntakeOperationalResult = {
  stage: IntakeOperationalStage
  warnings: IntakeWarning[]
  ageDays: number
  nextStep: string
}

const STALE_RECEIVED_DAYS = 7
const STALE_REVIEWED_DAYS = 3

const NEXT_STEPS: Record<IntakeOperationalStage, string> = {
  expected:         'Receive item when it arrives',
  received:         'Review draft details and mark reviewed',
  in_review:        'Awaiting accepted seller agreement to convert',
  ready_to_convert: 'Convert to inventory',
  action_required:  'Resolve open case before proceeding',
  rejected:         'Intake rejected',
  converted:        'Item is in inventory',
  returned:         'Item has been returned to seller',
  closed:           'Submission closed',
}

export function deriveIntakeStage(record: IntakeRecord): IntakeOperationalStage {
  const { submission, intake } = record

  // Submission-level closed paths
  if (submission?.status === 'withdrawn' || submission?.status === 'declined') {
    return 'closed'
  }

  if (!intake) {
    return 'expected'
  }

  if (intake.status === 'converted') {
    // Check for return case resolved with returnedAt
    const returnCase = submission?.lifecycleCases.find(
      (c) => c.caseType === 'return_to_seller' && c.intakeDraftId === intake.id && c.returnedAt != null
    )
    return returnCase ? 'returned' : 'converted'
  }

  if (intake.status === 'rejected') {
    const hasOpenCase = (submission?.lifecycleCases ?? []).some(
      (c) =>
        (c.status === 'open' || c.status === 'action_required') &&
        c.caseType === 'intake_rejection' &&
        c.intakeDraftId === intake.id
    )
    return hasOpenCase ? 'action_required' : 'rejected'
  }

  if (intake.status === 'reviewed') {
    if (!submission) return 'ready_to_convert' // company-owned
    const hasAcceptedAgreement = submission.agreements.some((a) => a.status === 'accepted')
    return hasAcceptedAgreement ? 'ready_to_convert' : 'in_review'
  }

  // draft status
  if (!intake.receivedAt) return 'expected'
  return 'received'
}

export function deriveIntakeWarnings(record: IntakeRecord, stage: IntakeOperationalStage): IntakeWarning[] {
  const { submission, intake, now = new Date() } = record
  const warnings: IntakeWarning[] = []

  // approved_no_intake: submission approved but no draft created yet
  if (submission?.status === 'approved_for_intake' && !intake) {
    warnings.push('approved_no_intake')
  }

  if (!intake) return warnings

  if (
    intake.expectedQuantity != null &&
    intake.receivedQuantity != null &&
    intake.expectedQuantity !== intake.receivedQuantity
  ) {
    warnings.push('qty_mismatch')
  }

  // no_storage: also fires for converted items missing storage (reconciliation)
  if (
    (stage === 'received' || stage === 'in_review' || stage === 'ready_to_convert' || stage === 'converted') &&
    !intake.storageLocationId
  ) {
    warnings.push('no_storage')
  }

  if (stage === 'received' && intake.receivedAt) {
    const days = (now.getTime() - intake.receivedAt.getTime()) / 86_400_000
    if (days > STALE_RECEIVED_DAYS) warnings.push('stale_received')
  }

  if ((stage === 'in_review' || stage === 'ready_to_convert') && intake.receivedAt) {
    const days = (now.getTime() - intake.receivedAt.getTime()) / 86_400_000
    if (days > STALE_REVIEWED_DAYS) warnings.push('stale_reviewed')
  }

  const hasOpenCase = (submission?.lifecycleCases ?? []).some(
    (c) => c.status === 'open' || c.status === 'action_required'
  )
  if (hasOpenCase) warnings.push('open_case')

  if (stage === 'in_review') warnings.push('agreement_needed')

  // Reconciliation: converted status but no linked ItemInstance (item was deleted after conversion)
  if (intake.status === 'converted' && !intake.convertedItemId) {
    warnings.push('converted_no_item')
  }

  // Reconciliation: rejected but still has a linked ItemInstance (should not happen in normal flow)
  if (intake.status === 'rejected' && intake.convertedItemId) {
    warnings.push('rejected_with_item')
  }

  // Reconciliation: seller-sourced submission with no catalog link at actionable stages
  if (submission && !submission.catalogId && (stage === 'in_review' || stage === 'ready_to_convert')) {
    warnings.push('missing_catalog')
  }

  // Reconciliation: returned item that still has an active listing (listing was not deactivated)
  if (stage === 'returned' && intake.hasActiveListing) {
    warnings.push('returned_with_listing')
  }

  return warnings
}

export function deriveIntakeOperations(record: IntakeRecord): IntakeOperationalResult {
  const { intake, now = new Date() } = record
  const stage = deriveIntakeStage(record)
  const warnings = deriveIntakeWarnings(record, stage)

  const refDate = intake?.receivedAt ?? intake?.createdAt ?? record.submission?.createdAt ?? now
  const ageDays = Math.floor((now.getTime() - refDate.getTime()) / 86_400_000)

  return { stage, warnings, ageDays, nextStep: NEXT_STEPS[stage] }
}
