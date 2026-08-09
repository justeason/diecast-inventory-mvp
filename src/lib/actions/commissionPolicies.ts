'use server'

import { revalidatePath } from 'next/cache'
import {
  createCommissionPolicy,
  endDateCommissionPolicy,
  createSellerCommissionOverride,
  endSellerCommissionOverride,
} from '@/lib/commissionPolicyQuery'
import { isAdminAuthenticated } from '@/lib/adminAuth'

export type CommissionPolicyActionState = { errors?: Record<string, string[]> } | null

function parseAmountToCents(raw: string | null): number | null {
  if (!raw || raw.trim() === '') return null
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

function parsePercentToBps(raw: string | null): number | null {
  if (!raw || raw.trim() === '') return null
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

// Section 17: policy activation requires confirmation — enforced client-side via
// ConfirmSubmitButton (see component); this action re-checks admin auth server-side
// regardless of client confirmation state.
export async function createCommissionPolicyAction(
  _prev: CommissionPolicyActionState,
  formData: FormData,
): Promise<CommissionPolicyActionState> {
  if (!await isAdminAuthenticated()) return { errors: { _form: ['Unauthorized'] } }

  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { errors: { name: ['Name is required'] } }

  const defaultCommissionBps = parsePercentToBps(formData.get('defaultCommissionPercent') as string | null)
  if (defaultCommissionBps === null) return { errors: { defaultCommissionPercent: ['Default commission % is required'] } }

  const minimumFeeCents = parseAmountToCents(formData.get('minimumFeeAmount') as string | null)
  if (minimumFeeCents === null) return { errors: { minimumFeeAmount: ['Minimum fee is required'] } }

  const effectiveFromRaw = String(formData.get('effectiveFrom') ?? '')
  const effectiveFrom = effectiveFromRaw ? new Date(`${effectiveFromRaw}T00:00:00.000Z`) : null
  if (!effectiveFrom || Number.isNaN(effectiveFrom.getTime())) {
    return { errors: { effectiveFrom: ['A valid effective-from date is required'] } }
  }
  const effectiveToRaw = String(formData.get('effectiveTo') ?? '')
  const effectiveTo = effectiveToRaw ? new Date(`${effectiveToRaw}T00:00:00.000Z`) : null

  const tierMinItems = formData.getAll('tierMinItems') as string[]
  const tierPercents = formData.getAll('tierCommissionPercent') as string[]
  const tierMinFees = formData.getAll('tierMinimumFee') as string[]

  const tiers: Array<{ minItems: number; commissionBps: number; minimumFeeCents: number | null }> = []
  for (let i = 0; i < tierMinItems.length; i++) {
    if (!tierMinItems[i]?.trim() && !tierPercents[i]?.trim()) continue // skip fully-empty rows
    const minItems = parseInt(tierMinItems[i], 10)
    const bps = parsePercentToBps(tierPercents[i])
    if (!Number.isInteger(minItems) || bps === null) {
      return { errors: { _form: [`Tier row ${i + 1} is incomplete.`] } }
    }
    tiers.push({ minItems, commissionBps: bps, minimumFeeCents: parseAmountToCents(tierMinFees[i]) })
  }

  const activateImmediately = formData.get('activateImmediately') === 'on'

  const result = await createCommissionPolicy({
    name,
    effectiveFrom,
    effectiveTo,
    defaultCommissionBps,
    minimumFeeCents,
    tiers,
    activateImmediately,
  })
  if (!result.ok) return { errors: { _form: [result.error] } }

  revalidatePath('/admin/commission-policies')
  return null
}

export async function endDateCommissionPolicyAction(
  policyId: string,
  _prev: CommissionPolicyActionState,
  formData: FormData,
): Promise<CommissionPolicyActionState> {
  if (!await isAdminAuthenticated()) return { errors: { _form: ['Unauthorized'] } }

  const effectiveToRaw = String(formData.get('effectiveTo') ?? '')
  const effectiveTo = effectiveToRaw ? new Date(`${effectiveToRaw}T00:00:00.000Z`) : new Date()

  const result = await endDateCommissionPolicy(policyId, effectiveTo)
  if (!result.ok) return { errors: { _form: [result.error] } }

  revalidatePath('/admin/commission-policies')
  return null
}

export async function createSellerCommissionOverrideAction(
  sellerProfileId: string,
  _prev: CommissionPolicyActionState,
  formData: FormData,
): Promise<CommissionPolicyActionState> {
  if (!await isAdminAuthenticated()) return { errors: { _form: ['Unauthorized'] } }

  const reason = String(formData.get('reason') ?? '').trim()
  const effectiveFromRaw = String(formData.get('effectiveFrom') ?? '')
  const effectiveFrom = effectiveFromRaw ? new Date(`${effectiveFromRaw}T00:00:00.000Z`) : new Date()
  const effectiveToRaw = String(formData.get('effectiveTo') ?? '')
  const effectiveTo = effectiveToRaw ? new Date(`${effectiveToRaw}T00:00:00.000Z`) : null

  const result = await createSellerCommissionOverride({
    sellerProfileId,
    commissionBps: parsePercentToBps(formData.get('commissionPercent') as string | null),
    minimumFeeCents: parseAmountToCents(formData.get('minimumFeeAmount') as string | null),
    effectiveFrom,
    effectiveTo,
    reason,
    createdBy: 'admin', // no per-admin identity in this system; matches existing audit convention elsewhere
  })
  if (!result.ok) return { errors: { _form: [result.error] } }

  revalidatePath('/admin/commission-policies')
  revalidatePath(`/admin/seller-profiles/${sellerProfileId}`)
  return null
}

export async function endSellerCommissionOverrideAction(
  overrideId: string,
  sellerProfileId: string,
  _prev: CommissionPolicyActionState,
  formData: FormData,
): Promise<CommissionPolicyActionState> {
  if (!await isAdminAuthenticated()) return { errors: { _form: ['Unauthorized'] } }
  void formData

  const result = await endSellerCommissionOverride(overrideId, new Date())
  if (!result.ok) return { errors: { _form: [result.error] } }

  revalidatePath('/admin/commission-policies')
  revalidatePath(`/admin/seller-profiles/${sellerProfileId}`)
  return null
}
