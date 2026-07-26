// Admin-facing display helpers for seller lifecycle cases. Pure, no DB access.
// Distinct from the seller-safe labels in sellerLifecycle.ts — these are for
// admin surfaces and use precise internal terminology.

export const ADMIN_CASE_TYPE_LABELS: Record<string, string> = {
  buyer_dispute: 'Buyer dispute',
  buyer_return: 'Buyer return',
  lost_or_damaged: 'Lost or damaged',
  intake_rejection: 'Intake rejection',
  return_to_seller: 'Return to seller',
  consignment_expiration: 'Consignment expiration',
  seller_withdrawal: 'Seller withdrawal',
  other: 'Other',
}

export function adminCaseTypeLabel(caseType: string): string {
  return ADMIN_CASE_TYPE_LABELS[caseType] ?? caseType
}

export const ADMIN_CASE_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  action_required: 'Action required',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
}

export const ADMIN_CASE_STATUS_COLORS: Record<string, string> = {
  open: 'bg-yellow-100 text-yellow-700',
  action_required: 'bg-red-100 text-red-700',
  resolved: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
}

export function adminCaseStatusLabel(status: string): string {
  return ADMIN_CASE_STATUS_LABELS[status] ?? status
}

export function isOpenCaseStatus(status: string): boolean {
  return status === 'open' || status === 'action_required'
}
