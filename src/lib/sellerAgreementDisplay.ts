export const AGREEMENT_TYPE_LABELS: Record<string, string> = {
  buyout: 'Buyout (outright sale)',
  consignment: 'Consignment',
}

export const AGREEMENT_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  proposed: 'Proposed to seller',
  accepted: 'Accepted',
  cancelled: 'Cancelled',
}

export const AGREEMENT_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700',
  proposed: 'bg-blue-100 text-blue-700',
  accepted: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
}

export const ACCEPTANCE_METHOD_LABELS: Record<string, string> = {
  email: 'Email confirmation',
  in_person: 'In person',
  platform: 'Platform (signed in-app)',
}

export function formatAmount(value: string | null | undefined): string {
  if (!value) return '—'
  const n = parseFloat(value)
  return `$${n.toFixed(2)}`
}

export function formatCommissionDisplay(storedValue: string | null | undefined): string {
  if (!storedValue) return '—'
  const n = parseFloat(storedValue) * 100
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}%`
}

export function storedCommissionToInputValue(storedValue: string | null | undefined): string {
  if (!storedValue) return ''
  const n = parseFloat(storedValue) * 100
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)
}
