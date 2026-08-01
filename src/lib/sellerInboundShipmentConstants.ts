export const CONDITION_STATUSES = ['good', 'damaged', 'incomplete', 'wrong_item', 'other'] as const
export type ConditionStatus = (typeof CONDITION_STATUSES)[number]

export const CONDITION_LABELS: Record<ConditionStatus, string> = {
  good:       'Good condition',
  damaged:    'Damaged',
  incomplete: 'Incomplete',
  wrong_item: 'Wrong item',
  other:      'Other issue',
}

export const SELLER_CONDITION_LABELS: Record<ConditionStatus, string> = {
  good:       'Received in good condition',
  damaged:    'Received — condition noted',
  incomplete: 'Received — quantity noted',
  wrong_item: 'Received — item noted',
  other:      'Received — under review',
}

export const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  draft:     'Draft',
  shipped:   'Shipped',
  received:  'Received',
  issue:     'Received (issue)',
  cancelled: 'Cancelled',
}

export type ShipmentActionState = { errors: Record<string, string[]> } | null
