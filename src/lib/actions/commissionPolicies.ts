'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import {
  createCommissionPolicy,
  endDateCommissionPolicy,
  createSellerCommissionOverride,
  endSellerCommissionOverride,
} from '@/lib/commissionPolicyQuery'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'
import type { SellerCommissionOverrideContext } from '@/lib/riskPolicy'

// 15F: approvalRequestId is set only when a risk gate routed this action to the
// approval queue instead of performing the mutation.
export type CommissionPolicyActionState = { errors?: Record<string, string[]>; approvalRequestId?: string } | null

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

  const commissionBps = parsePercentToBps(formData.get('commissionPercent') as string | null)
  const minimumFeeCents = parseAmountToCents(formData.get('minimumFeeAmount') as string | null)

  // 15F: manual seller-specific overrides always require approval (never automatic
  // volume-tier resolution — see riskPolicy.ts). This is a create-new-row action, not
  // a mutation of existing shared state, so consumption is applied AFTER a successful
  // create rather than wrapped around it (createSellerCommissionOverride owns its own
  // transaction) — a crash between create and consume leaves the approval reusable,
  // but a literal retry is safely rejected by the overlap check below, never
  // duplicated.
  const riskContext: SellerCommissionOverrideContext = {
    sellerProfileId, commissionBps, minimumFeeCents, reason,
    effectiveFromIso: effectiveFrom.toISOString(),
    effectiveToIso: effectiveTo ? effectiveTo.toISOString() : null,
  }
  const gate = await checkRiskGate({ action: 'seller_commission_override', context: riskContext, targetType: 'seller_profile', targetId: sellerProfileId, requestedBy: 'admin' })
  if (gate.decision === 'deny') return { errors: { _form: [gate.reasons.join(' ')] } }
  if (gate.decision === 'pending') {
    return { errors: { _form: ['A seller-specific commission override requires approval.'] }, approvalRequestId: gate.approvalRequestId }
  }

  const result = await createSellerCommissionOverride({
    sellerProfileId,
    commissionBps,
    minimumFeeCents,
    effectiveFrom,
    effectiveTo,
    reason,
    createdBy: 'admin', // no per-admin identity in this system; matches existing audit convention elsewhere
  })
  if (!result.ok) return { errors: { _form: [result.error] } }

  if (gate.decision === 'consume_approved') {
    await prisma.$transaction(async (tx) => {
      const consumed = await consumeApprovedRiskGate(tx, { approvalRequestId: gate.approvalRequestId, action: 'seller_commission_override', targetId: sellerProfileId, context: riskContext })
      if (consumed.ok) await markApprovalConsumed(tx, gate.approvalRequestId)
    })
  }

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
