'use server'

// 15F: approval request lifecycle. Two-phase design, deliberately split across two
// entry points because they have different transaction-durability requirements:
//
//   checkRiskGate()          — called by an integrated action BEFORE its own mutation
//                               transaction. Runs in its OWN transaction: a newly
//                               created 'pending' row must durably commit even though
//                               the calling action then stops (does not mutate).
//
//   consumeApprovedRiskGate()
//   markApprovalConsumed()   — called INSIDE the caller's own mutation transaction,
//                               only when checkRiskGate returned 'consume_approved'.
//                               Approval consumption + the business mutation commit
//                               or roll back together, atomically (section 16).
//
// Approval NEVER performs the business mutation itself (section 16) — approving a
// request only flips its status to 'approved'; the original action must still be
// re-invoked, at which point checkRiskGate finds the matching approved+unconsumed
// request and this module lets the caller consume it exactly once.
import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { getEffectiveRiskPolicy } from '@/lib/riskPolicyQuery'
import {
  evaluateRiskPolicy,
  computeContextFingerprint,
  type RiskAction,
  type RiskContextFor,
} from '@/lib/riskPolicy'

type TxClient = Prisma.TransactionClient

const DEFAULT_APPROVAL_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000 // 14 days, uniform across actions

export type RiskGateCheckResult =
  | { decision: 'allow' }
  | { decision: 'consume_approved'; approvalRequestId: string }
  | { decision: 'pending'; approvalRequestId: string; riskLevel: 'medium' | 'high'; reasons: string[] }
  | { decision: 'deny'; reasons: string[] }

export async function checkRiskGate<A extends RiskAction>(params: {
  action: A
  context: RiskContextFor<A>
  targetType: string
  targetId: string
  requestedBy: string
  asOf?: Date
}): Promise<RiskGateCheckResult> {
  const asOf = params.asOf ?? new Date()
  const policy = await getEffectiveRiskPolicy(asOf)
  if (!policy) throw new Error('No effective risk policy is configured — the 15F migration seed should always provide one.')

  const decision = evaluateRiskPolicy({ action: params.action, context: params.context, policy, asOf })
  if (decision.outcome === 'allow') return { decision: 'allow' }
  if (decision.outcome === 'deny') return { decision: 'deny', reasons: decision.reasons }

  const fingerprint = computeContextFingerprint(params.action, params.targetId, params.context as Record<string, unknown>)

  return prisma.$transaction(async (tx) => {
    // Section 27: serialize concurrent create-or-find so two simultaneous requests
    // for the exact same (action, target, proposed change) never both insert a row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`risk-approval-dedupe:${params.action}:${params.targetId}:${fingerprint}`})::bigint)`

    const approved = await tx.riskApprovalRequest.findFirst({
      where: { action: params.action, targetId: params.targetId, contextFingerprint: fingerprint, status: 'approved' },
      orderBy: { approvedAt: 'desc' },
    })
    if (approved && (!approved.expiresAt || approved.expiresAt > asOf)) {
      return { decision: 'consume_approved', approvalRequestId: approved.id }
    }

    const pending = await tx.riskApprovalRequest.findFirst({
      where: { action: params.action, targetId: params.targetId, contextFingerprint: fingerprint, status: 'pending' },
    })
    if (pending) {
      return { decision: 'pending', approvalRequestId: pending.id, riskLevel: pending.riskLevel as 'medium' | 'high', reasons: (pending.reasons as string[]) ?? [] }
    }

    const created = await tx.riskApprovalRequest.create({
      data: {
        action: params.action,
        status: 'pending',
        riskLevel: decision.riskLevel,
        policyCode: decision.policyCode,
        policyVersion: policy.version,
        targetType: params.targetType,
        targetId: params.targetId,
        contextFingerprint: fingerprint,
        decisionContext: params.context as Prisma.InputJsonValue,
        reasons: decision.reasons,
        requestedBy: params.requestedBy,
        expiresAt: new Date(asOf.getTime() + DEFAULT_APPROVAL_EXPIRY_MS),
      },
    })
    return { decision: 'pending', approvalRequestId: created.id, riskLevel: decision.riskLevel, reasons: decision.reasons }
  })
}

// Must be called inside the caller's own mutation transaction, holding a row lock for
// the duration — the caller performs its business mutation strictly between this call
// and markApprovalConsumed, so two concurrent consumers can never both succeed.
export async function consumeApprovedRiskGate(
  tx: TxClient,
  params: { approvalRequestId: string; action: string; targetId: string; context: Record<string, unknown>; now?: Date },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = params.now ?? new Date()
  await tx.$queryRaw`SELECT id FROM "RiskApprovalRequest" WHERE id = ${params.approvalRequestId} FOR UPDATE`
  const row = await tx.riskApprovalRequest.findUnique({ where: { id: params.approvalRequestId } })
  if (!row) return { ok: false, error: 'Approval request not found.' }
  if (row.status !== 'approved') return { ok: false, error: `Approval request is ${row.status}, not approved.` }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    await tx.riskApprovalRequest.update({ where: { id: row.id }, data: { status: 'expired' } })
    return { ok: false, error: 'Approval request has expired. Request a new approval.' }
  }
  const currentFingerprint = computeContextFingerprint(params.action, params.targetId, params.context)
  if (currentFingerprint !== row.contextFingerprint) {
    return { ok: false, error: 'The proposed change no longer matches what was approved (context changed since the request was made). A new approval is required.' }
  }
  return { ok: true }
}

export async function markApprovalConsumed(tx: TxClient, approvalRequestId: string): Promise<void> {
  const result = await tx.riskApprovalRequest.updateMany({
    where: { id: approvalRequestId, status: 'approved' },
    data: { status: 'consumed', consumedAt: new Date() },
  })
  if (result.count !== 1) throw new Error('Approval request was not in an approved state at consumption time.')
}

// ── Admin decision actions ───────────────────────────────────────────────────────

export type RiskApprovalActionState = { errors?: Record<string, string[]> } | null

// Commercial-override and destructive/ownership-adjacent actions always require a
// decision note on approval, regardless of computed risk level (section 22).
const NOTE_REQUIRED_ACTIONS = new Set(['agreement_commission_override', 'seller_commission_override', 'item_catalog_reassignment', 'catalog_model_merge'])

export async function approveRiskApprovalRequest(
  id: string,
  _prev: RiskApprovalActionState,
  formData: FormData,
): Promise<RiskApprovalActionState> {
  if (!(await isAdminAuthenticated())) return { errors: { _form: ['Unauthorized'] } }
  const decisionNote = (formData.get('decisionNote') as string | null)?.trim() || null

  let txError: RiskApprovalActionState = null
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RiskApprovalRequest" WHERE id = ${id} FOR UPDATE`
      const row = await tx.riskApprovalRequest.findUnique({ where: { id } })
      if (!row) { txError = { errors: { _form: ['Approval request not found.'] } }; throw new Error('TX_VALIDATION') }
      if (row.status !== 'pending') { txError = { errors: { _form: [`Cannot approve — request is already ${row.status}.`] } }; throw new Error('TX_VALIDATION') }
      if ((row.riskLevel === 'high' || NOTE_REQUIRED_ACTIONS.has(row.action)) && !decisionNote) {
        txError = { errors: { decisionNote: ['A decision note is required to approve this action.'] } }
        throw new Error('TX_VALIDATION')
      }
      await tx.riskApprovalRequest.update({
        where: { id },
        data: { status: 'approved', approvedBy: 'admin', approvedAt: new Date(), decisionNote },
      })
    })
  } catch (e) {
    if ((e as Error).message !== 'TX_VALIDATION') throw e
  }
  if (txError) return txError

  revalidatePath('/admin/approvals')
  revalidatePath(`/admin/approvals/${id}`)
  return null
}

export async function rejectRiskApprovalRequest(
  id: string,
  _prev: RiskApprovalActionState,
  formData: FormData,
): Promise<RiskApprovalActionState> {
  if (!(await isAdminAuthenticated())) return { errors: { _form: ['Unauthorized'] } }
  const decisionNote = (formData.get('decisionNote') as string | null)?.trim() || null
  if (!decisionNote) return { errors: { decisionNote: ['A decision note is required to reject a request.'] } }

  let txError: RiskApprovalActionState = null
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RiskApprovalRequest" WHERE id = ${id} FOR UPDATE`
      const row = await tx.riskApprovalRequest.findUnique({ where: { id } })
      if (!row) { txError = { errors: { _form: ['Approval request not found.'] } }; throw new Error('TX_VALIDATION') }
      if (row.status !== 'pending') { txError = { errors: { _form: [`Cannot reject — request is already ${row.status}.`] } }; throw new Error('TX_VALIDATION') }
      await tx.riskApprovalRequest.update({
        where: { id },
        data: { status: 'rejected', rejectedBy: 'admin', rejectedAt: new Date(), decisionNote },
      })
    })
  } catch (e) {
    if ((e as Error).message !== 'TX_VALIDATION') throw e
  }
  if (txError) return txError

  revalidatePath('/admin/approvals')
  revalidatePath(`/admin/approvals/${id}`)
  return null
}

export async function cancelRiskApprovalRequest(
  id: string,
  prev: RiskApprovalActionState,
  formData: FormData,
): Promise<RiskApprovalActionState> {
  void prev
  void formData
  if (!(await isAdminAuthenticated())) return { errors: { _form: ['Unauthorized'] } }

  const result = await prisma.riskApprovalRequest.updateMany({
    where: { id, status: { in: ['pending', 'approved'] } },
    data: { status: 'cancelled' },
  })
  if (result.count === 0) return { errors: { _form: ['Request cannot be cancelled — it is not pending or approved.'] } }

  revalidatePath('/admin/approvals')
  revalidatePath(`/admin/approvals/${id}`)
  return null
}
