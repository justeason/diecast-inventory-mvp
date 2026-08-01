// Pure functional — no DB access

export type ShipmentWarning =
  | 'no_shipment_after_agreement'
  | 'shipped_not_received'
  | 'received_no_intake'
  | 'quantity_mismatch'
  | 'duplicate_tracking'
  | 'issue_no_case'
  | 'cancelled_linked_receipt'
  | 'received_missing_receivedAt'
  | 'intake_received_no_shipment'

export const SHIPMENT_WARNING_LABELS: Record<ShipmentWarning, string> = {
  no_shipment_after_agreement: 'Agreement accepted — no shipment created',
  shipped_not_received:        'Shipped package not yet received (>14d)',
  received_no_intake:          'Received package has no intake draft',
  quantity_mismatch:           'Shipment/intake quantity mismatch',
  duplicate_tracking:          'Duplicate tracking number',
  issue_no_case:               'Issue shipment without open case',
  cancelled_linked_receipt:    'Cancelled shipment linked to received intake',
  received_missing_receivedAt: 'Received status missing received date',
  intake_received_no_shipment: 'Intake receipt exists but no inbound shipment',
}

const AGREEMENT_NO_SHIPMENT_THRESHOLD_DAYS = 3
const SHIPPED_NOT_RECEIVED_THRESHOLD_DAYS = 14

export type ShipmentSummary = {
  id: string
  status: string
  trackingNumber: string | null
  expectedQuantity: number
  receivedQuantity: number | null
  receivedAt: Date | null
  shippedAt: Date | null
  conditionStatus: string | null
  intakeDraftId: string | null
}

export type IntakeDraftSummary = {
  id: string
  status: string
  receivedAt: Date | null
  receivedQuantity: number | null
}

export type ShipmentWarningInput = {
  hasAcceptedAgreement: boolean
  agreementAcceptedAt: Date | null
  shipments: ShipmentSummary[]
  intakeDrafts: IntakeDraftSummary[]
  openCaseTypes: string[]
  now?: Date
}

export function deriveShipmentWarnings(input: ShipmentWarningInput): ShipmentWarning[] {
  const {
    hasAcceptedAgreement,
    agreementAcceptedAt,
    shipments,
    intakeDrafts,
    openCaseTypes,
    now = new Date(),
  } = input

  const warnings: ShipmentWarning[] = []
  const activeShipments = shipments.filter((s) => s.status !== 'cancelled')
  const receivedShipments = activeShipments.filter((s) => s.status === 'received' || s.status === 'issue')
  const receivedDrafts = intakeDrafts.filter((d) => d.receivedAt != null)

  // Agreement accepted but no shipment and no intake after threshold
  if (
    hasAcceptedAgreement &&
    activeShipments.length === 0 &&
    intakeDrafts.filter((d) => d.status !== 'rejected').length === 0 &&
    agreementAcceptedAt
  ) {
    const days = (now.getTime() - agreementAcceptedAt.getTime()) / 86_400_000
    if (days > AGREEMENT_NO_SHIPMENT_THRESHOLD_DAYS) {
      warnings.push('no_shipment_after_agreement')
    }
  }

  // Shipped but not received after threshold
  for (const s of activeShipments) {
    if (s.status === 'shipped' && s.shippedAt) {
      const days = (now.getTime() - s.shippedAt.getTime()) / 86_400_000
      if (days > SHIPPED_NOT_RECEIVED_THRESHOLD_DAYS) {
        warnings.push('shipped_not_received')
        break
      }
    }
  }

  // Received shipment with no linked intake
  if (receivedShipments.some((s) => !s.intakeDraftId)) {
    warnings.push('received_no_intake')
  }

  // Quantity mismatch: received shipment totals vs intake received totals
  if (receivedShipments.length > 0 && receivedDrafts.length > 0) {
    const shipmentReceived = receivedShipments.reduce((acc, s) => acc + (s.receivedQuantity ?? 0), 0)
    const intakeReceived = receivedDrafts.reduce((acc, d) => acc + (d.receivedQuantity ?? 0), 0)
    if (shipmentReceived !== intakeReceived) {
      warnings.push('quantity_mismatch')
    }
  }

  // Duplicate tracking numbers among active shipments
  const trackings = activeShipments
    .map((s) => s.trackingNumber?.toLowerCase())
    .filter((t): t is string => !!t)
  if (new Set(trackings).size < trackings.length) {
    warnings.push('duplicate_tracking')
  }

  // Issue shipment without open lifecycle case
  if (
    activeShipments.some((s) => s.status === 'issue') &&
    !openCaseTypes.some((t) => t === 'lost_or_damaged' || t === 'other')
  ) {
    warnings.push('issue_no_case')
  }

  // Cancelled shipment linked to a received intake draft
  for (const s of shipments.filter((s) => s.status === 'cancelled' && s.intakeDraftId)) {
    const draft = intakeDrafts.find((d) => d.id === s.intakeDraftId)
    if (draft?.receivedAt) {
      warnings.push('cancelled_linked_receipt')
      break
    }
  }

  // Received status but missing receivedAt date
  if (receivedShipments.some((s) => !s.receivedAt)) {
    warnings.push('received_missing_receivedAt')
  }

  // Intake has receipt but no active inbound shipment (shipment workflow expected when agreement accepted)
  if (hasAcceptedAgreement && receivedDrafts.length > 0 && activeShipments.length === 0) {
    warnings.push('intake_received_no_shipment')
  }

  return warnings
}

export function deriveShipmentTotals(shipments: ShipmentSummary[]) {
  const active = shipments.filter((s) => s.status !== 'cancelled')
  const received = active.filter((s) => s.status === 'received' || s.status === 'issue')
  const open = active.filter((s) => s.status === 'draft' || s.status === 'shipped')
  const issue = active.filter((s) => s.status === 'issue')

  return {
    totalExpectedQuantity: active.reduce((acc, s) => acc + s.expectedQuantity, 0),
    totalReceivedQuantity: received.reduce((acc, s) => acc + (s.receivedQuantity ?? 0), 0),
    openPackageCount: open.length,
    issuePackageCount: issue.length,
  }
}
