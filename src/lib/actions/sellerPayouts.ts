'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  buildBuyoutSourceKey,
  buildConsignmentSourceKey,
  calculateBuyoutPayoutSnapshot,
  calculateConsignmentPayoutSnapshot,
  checkForDuplicateLineIds,
  isItemEligibleForConsignmentPayout,
  isOrderStatusEligibleForConsignmentPayout,
  validateLinesForPayout,
  canApprovePayout,
  isValidPaymentMethod,
} from '@/lib/sellerPayoutCalculation'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'
import type { SellerPayoutMarkPaidContext } from '@/lib/riskPolicy'

// Resolve the seller submission id linked to a payout line via its agreement.
async function submissionIdForLine(lineId: string): Promise<string | null> {
  const line = await prisma.sellerPayoutLine.findUnique({
    where: { id: lineId },
    select: { agreement: { select: { submissionId: true } } },
  })
  return line?.agreement?.submissionId ?? null
}

// Resolve the distinct submission ids linked to a payout via its lines.
async function submissionIdsForPayout(payoutId: string): Promise<string[]> {
  const lines = await prisma.sellerPayoutLine.findMany({
    where: { payoutId },
    select: { agreement: { select: { submissionId: true } } },
  })
  return [
    ...new Set(
      lines
        .map((l) => l.agreement?.submissionId)
        .filter((s): s is string => !!s),
    ),
  ]
}

// ─── Shared action state ──────────────────────────────────────────────────────

export type PayoutLineActionState = { errors: Record<string, string[]> } | null
// 15F: approvalRequestId is set only when a risk gate routed this action to the
// approval queue instead of performing the mutation — see markSellerPayoutPaid.
export type PayoutActionState = { errors: Record<string, string[]>; approvalRequestId?: string } | null

// ─── Hold line ────────────────────────────────────────────────────────────────

export async function holdSellerPayoutLine(
  lineId: string,
  _prev: PayoutLineActionState,
  formData: FormData,
): Promise<PayoutLineActionState> {
  const holdReason = (formData.get('holdReason') as string)?.trim()
  if (!holdReason) return { errors: { holdReason: ['Hold reason is required.'] } }

  const line = await prisma.sellerPayoutLine.findUnique({
    where: { id: lineId },
    select: { id: true, status: true, payoutId: true, customerProfileId: true },
  })
  if (!line) return { errors: { _form: ['Payout line not found.'] } }
  if (line.status !== 'eligible') return { errors: { _form: ['Only eligible lines can be held.'] } }
  if (line.payoutId !== null) return { errors: { _form: ['Cannot hold a line that is already in a payout batch.'] } }

  await prisma.sellerPayoutLine.update({
    where: { id: lineId },
    data: { status: 'held', heldAt: new Date(), holdReason },
  })

  try {
    const sid = await submissionIdForLine(lineId)
    if (sid) {
      await ensureSellerLifecycleEvent({
        eventKey: `payout-line-held:${lineId}:${Date.now()}`,
        sellerSubmissionId: sid,
        eventType: 'payout_line_held',
        sourceEntityType: 'payout_line',
        sourceEntityId: lineId,
        sellerVisible: false,
        adminDescription: `Payout line held: ${holdReason}`,
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[holdSellerPayoutLine] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
  }

  revalidatePath('/admin/seller-payouts')
  revalidatePath(`/admin/seller-submissions`)
  return null
}

// ─── Release line ─────────────────────────────────────────────────────────────

export async function releaseSellerPayoutLine(
  lineId: string,
  _prev: PayoutLineActionState,
  formData: FormData,
): Promise<PayoutLineActionState> {
  void formData

  const line = await prisma.sellerPayoutLine.findUnique({
    where: { id: lineId },
    select: { id: true, status: true, payoutId: true },
  })
  if (!line) return { errors: { _form: ['Payout line not found.'] } }
  if (line.status !== 'held') return { errors: { _form: ['Only held lines can be released.'] } }
  if (line.payoutId !== null) return { errors: { _form: ['Cannot release a line that is in a payout batch.'] } }

  await prisma.sellerPayoutLine.update({
    where: { id: lineId },
    data: { status: 'eligible', heldAt: null, holdReason: null },
  })

  try {
    const sid = await submissionIdForLine(lineId)
    if (sid) {
      await ensureSellerLifecycleEvent({
        eventKey: `payout-line-released:${lineId}:${Date.now()}`,
        sellerSubmissionId: sid,
        eventType: 'payout_line_released',
        sourceEntityType: 'payout_line',
        sourceEntityId: lineId,
        sellerVisible: false,
        adminDescription: 'Payout line hold released.',
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[releaseSellerPayoutLine] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
  }

  revalidatePath('/admin/seller-payouts')
  return null
}

// ─── Void line ────────────────────────────────────────────────────────────────

export async function voidSellerPayoutLine(
  lineId: string,
  _prev: PayoutLineActionState,
  formData: FormData,
): Promise<PayoutLineActionState> {
  const voidReason = (formData.get('voidReason') as string)?.trim()
  if (!voidReason) return { errors: { voidReason: ['Void reason is required.'] } }

  const line = await prisma.sellerPayoutLine.findUnique({
    where: { id: lineId },
    select: { id: true, status: true, payoutId: true },
  })
  if (!line) return { errors: { _form: ['Payout line not found.'] } }
  if (line.status !== 'eligible' && line.status !== 'held') {
    return { errors: { _form: ['Only eligible or held lines can be voided.'] } }
  }
  if (line.payoutId !== null) {
    return { errors: { _form: ['Cannot void a line that is in a payout batch. Remove it from the batch first.'] } }
  }

  await prisma.sellerPayoutLine.update({
    where: { id: lineId },
    data: { status: 'voided', voidedAt: new Date(), voidReason },
  })

  try {
    const sid = await submissionIdForLine(lineId)
    if (sid) {
      await ensureSellerLifecycleEvent({
        eventKey: `payout-line-voided:${lineId}`,
        sellerSubmissionId: sid,
        eventType: 'payout_line_voided',
        sourceEntityType: 'payout_line',
        sourceEntityId: lineId,
        sellerVisible: false,
        adminDescription: `Payout line voided: ${voidReason}`,
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[voidSellerPayoutLine] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
  }

  revalidatePath('/admin/seller-payouts')
  return null
}

// ─── Create payout batch ──────────────────────────────────────────────────────
//
// Concurrency guarantee: after the draft SellerPayout is created, lines are
// attached with a conditional updateMany that requires payoutId IS NULL,
// status = 'eligible', and the correct customerProfileId and currency.  The
// row count returned by updateMany is compared to the number of requested IDs.
// If they differ, at least one line was concurrently claimed by another payout;
// the transaction rolls back and a clear error is returned.

export async function createSellerPayout(
  _prev: PayoutActionState,
  formData: FormData,
): Promise<PayoutActionState> {
  const lineIds = formData.getAll('lineIds') as string[]
  const sellerProfileId = (formData.get('sellerProfileId') as string)?.trim()
  const adminNotes = (formData.get('adminNotes') as string)?.trim() || null

  if (!lineIds.length) return { errors: { _form: ['At least one payout line must be selected.'] } }
  if (!sellerProfileId) return { errors: { sellerProfileId: ['Seller profile is required.'] } }

  // Reject duplicate IDs in the submitted form before entering the transaction.
  const { hasDuplicates, duplicateIds } = checkForDuplicateLineIds(lineIds)
  if (hasDuplicates) {
    return {
      errors: {
        _form: [`Duplicate payout line IDs submitted: ${duplicateIds.join(', ')}. Each line may only be selected once.`],
      },
    }
  }

  let newPayoutId: string | undefined
  let txError: { errors: Record<string, string[]> } | null = null

  try {
    await prisma.$transaction(async (tx) => {
      // Re-fetch all selected lines inside the transaction (authoritative read).
      const lines = await tx.sellerPayoutLine.findMany({
        where: { id: { in: lineIds } },
        select: { id: true, status: true, payoutId: true, customerProfileId: true, currency: true, netAmount: true },
      })

      if (lines.length !== lineIds.length) {
        txError = { errors: { _form: ['One or more selected lines could not be found.'] } }
        throw new Error('TX_VALIDATION')
      }

      // All lines must belong to the same customer.
      const profileIds = [...new Set(lines.map((l) => l.customerProfileId))]
      if (profileIds.length !== 1) {
        txError = { errors: { _form: ['All selected lines must belong to the same customer.'] } }
        throw new Error('TX_VALIDATION')
      }
      const targetCustomerProfileId = profileIds[0]

      const sellerProfile = await tx.sellerProfile.findUnique({
        where: { id: sellerProfileId },
        select: { id: true, profileId: true, status: true },
      })

      const validation = validateLinesForPayout(lines, sellerProfile, targetCustomerProfileId)
      if (!validation.valid) {
        txError = { errors: { _form: [validation.error] } }
        throw new Error('TX_VALIDATION')
      }

      const currency = lines[0].currency
      const ZERO = new Prisma.Decimal(0)
      const totalAmount = lines
        .reduce((acc, l) => acc.plus(l.netAmount), ZERO)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

      if (totalAmount.lessThanOrEqualTo(ZERO)) {
        txError = { errors: { _form: ['Payout total must be greater than zero.'] } }
        throw new Error('TX_VALIDATION')
      }

      const payout = await tx.sellerPayout.create({
        data: {
          status: 'draft',
          currency,
          customerProfileId: targetCustomerProfileId,
          sellerProfileId,
          totalAmount,
          adminNotes,
        },
      })
      newPayoutId = payout.id

      // Atomic claim: attach lines only if they are still unassigned, eligible,
      // belong to the correct customer, and use the correct currency.
      // Any concurrent transaction that already claimed one of these lines will
      // have set payoutId != null, causing the WHERE to match fewer rows.
      const claimed = await tx.sellerPayoutLine.updateMany({
        where: {
          id: { in: lineIds },
          payoutId: null,
          status: 'eligible',
          customerProfileId: targetCustomerProfileId,
          currency,
        },
        data: { payoutId: payout.id },
      })

      if (claimed.count !== lineIds.length) {
        // One or more lines were claimed by a concurrent payout — roll back.
        txError = {
          errors: {
            _form: ['One or more lines were claimed by another payout concurrently. Please refresh and try again.'],
          },
        }
        throw new Error('TX_VALIDATION')
      }
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  if (newPayoutId) {
    try {
      const sids = await submissionIdsForPayout(newPayoutId)
      for (const sid of sids) {
        await ensureSellerLifecycleEvent({
          eventKey: `payout-created:${newPayoutId}:${sid}`,
          sellerSubmissionId: sid,
          eventType: 'payout_created',
          sourceEntityType: 'payout',
          sourceEntityId: newPayoutId,
          sellerVisible: false,
          adminDescription: 'Payout batch created.',
          occurredAt: new Date(),
        })
      }
    } catch (err) {
      console.error('[createSellerPayout] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
    }
  }

  revalidatePath('/admin/seller-payouts')
  redirect(`/admin/seller-payouts/${newPayoutId}`)
}

// ─── Remove line from draft payout ────────────────────────────────────────────
//
// Race protection: the final payout total update uses updateMany WHERE status =
// 'draft'.  If the payout was concurrently approved between the status check and
// the update, count = 0 and the transaction rolls back, keeping the line
// attached.

export async function removeLineFromDraftPayout(
  payoutId: string,
  lineId: string,
  _prev: PayoutActionState,
  formData: FormData,
): Promise<PayoutActionState> {
  void formData

  let txError: { errors: Record<string, string[]> } | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const payout = await tx.sellerPayout.findUnique({
        where: { id: payoutId },
        select: { id: true, status: true },
      })
      if (!payout) {
        txError = { errors: { _form: ['Payout not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (payout.status !== 'draft') {
        txError = { errors: { _form: ['Lines can only be removed from draft payouts.'] } }
        throw new Error('TX_VALIDATION')
      }

      const line = await tx.sellerPayoutLine.findUnique({
        where: { id: lineId },
        select: { id: true, payoutId: true, netAmount: true },
      })
      if (!line || line.payoutId !== payoutId) {
        txError = { errors: { _form: ['Line does not belong to this payout.'] } }
        throw new Error('TX_VALIDATION')
      }

      await tx.sellerPayoutLine.update({
        where: { id: lineId },
        data: { payoutId: null },
      })

      // Recalculate total from remaining lines.
      const remaining = await tx.sellerPayoutLine.findMany({
        where: { payoutId },
        select: { netAmount: true },
      })
      const ZERO = new Prisma.Decimal(0)
      const newTotal = remaining
        .reduce((acc, l) => acc.plus(l.netAmount), ZERO)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

      // Conditional update: only succeeds while the payout is still draft.
      // If it was concurrently approved, count = 0 and the transaction rolls back.
      const updated = await tx.sellerPayout.updateMany({
        where: { id: payoutId, status: 'draft' },
        data: { totalAmount: newTotal },
      })
      if (updated.count === 0) {
        txError = {
          errors: { _form: ['Payout was approved concurrently. Line removal cancelled.'] },
        }
        throw new Error('TX_VALIDATION')
      }
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath('/admin/seller-payouts')
  revalidatePath(`/admin/seller-payouts/${payoutId}`)
  return null
}

// ─── Approve payout ───────────────────────────────────────────────────────────
//
// Race protection: the approval update uses updateMany WHERE status = 'draft'.
// A second concurrent approval attempt will see count = 0 after the first
// commits and will be rejected rather than overwriting approvedAt or totalAmount.

export async function approveSellerPayout(
  payoutId: string,
  _prev: PayoutActionState,
  formData: FormData,
): Promise<PayoutActionState> {
  void formData

  let txError: { errors: Record<string, string[]> } | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const payout = await tx.sellerPayout.findUnique({
        where: { id: payoutId },
        include: {
          lines: { select: { netAmount: true } },
          sellerProfile: { select: { status: true, profileId: true } },
        },
      })
      if (!payout) {
        txError = { errors: { _form: ['Payout not found.'] } }
        throw new Error('TX_VALIDATION')
      }

      const result = canApprovePayout({
        status: payout.status,
        customerProfileId: payout.customerProfileId,
        lines: payout.lines,
        sellerProfile: payout.sellerProfile,
      })
      if (!result.valid) {
        txError = { errors: { _form: [result.error] } }
        throw new Error('TX_VALIDATION')
      }

      // Conditional update: only succeeds while the payout is still draft.
      // Prevents two simultaneous approval requests from both committing.
      const updated = await tx.sellerPayout.updateMany({
        where: { id: payoutId, status: 'draft' },
        data: {
          status: 'approved',
          approvedAt: new Date(),
          totalAmount: result.recalculatedTotal,
        },
      })
      if (updated.count === 0) {
        txError = {
          errors: { _form: ['Payout was already approved by another request. Please refresh.'] },
        }
        throw new Error('TX_VALIDATION')
      }
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  try {
    const sids = await submissionIdsForPayout(payoutId)
    for (const sid of sids) {
      await ensureSellerLifecycleEvent({
        eventKey: `payout-approved:${payoutId}:${sid}`,
        sellerSubmissionId: sid,
        eventType: 'payout_approved',
        sourceEntityType: 'payout',
        sourceEntityId: payoutId,
        sellerVisible: true,
        sellerTitle: 'Payout approved',
        sellerDescription: 'CollectNTrades approved your payout.',
        occurredAt: new Date(),
      })
      revalidatePath(`/account/sell/${sid}`)
    }
  } catch (err) {
    console.error('[approveSellerPayout] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
  }

  revalidatePath('/admin/seller-payouts')
  revalidatePath(`/admin/seller-payouts/${payoutId}`)
  return null
}

// ─── Mark payout paid ─────────────────────────────────────────────────────────
//
// Race protection: the entire operation runs inside a transaction.  The update
// uses updateMany WHERE status = 'approved', so a second concurrent "mark paid"
// request returns count = 0 after the first commits, preventing paidAt,
// paymentMethod, or paymentReference from being overwritten.

export async function markSellerPayoutPaid(
  payoutId: string,
  _prev: PayoutActionState,
  formData: FormData,
): Promise<PayoutActionState> {
  const paymentMethod = (formData.get('paymentMethod') as string)?.trim()
  const paymentReference = (formData.get('paymentReference') as string)?.trim()
  const confirmed = formData.get('confirm') === 'on'

  if (!paymentMethod) return { errors: { paymentMethod: ['Payment method is required.'] } }
  if (!isValidPaymentMethod(paymentMethod)) {
    return { errors: { paymentMethod: ['Invalid payment method.'] } }
  }
  if (!paymentReference) return { errors: { paymentReference: ['Payment reference is required.'] } }
  if (!confirmed) return { errors: { _form: ['You must confirm that payment was made.'] } }

  const payout = await prisma.sellerPayout.findUnique({ where: { id: payoutId }, select: { totalAmount: true, status: true } })
  if (!payout) return { errors: { _form: ['Payout not found.'] } }

  // 15F: large payouts require an approval gate before the funds-sent record can be
  // written — the confirm checkbox above is sufficient below the configured
  // threshold. This action still never sends any payment either way (section 9/16).
  const riskContext: SellerPayoutMarkPaidContext = {
    payoutId, totalAmountCents: Math.round(parseFloat(payout.totalAmount.toString()) * 100),
    payoutStatus: payout.status, paymentMethod, paymentReference,
  }
  const gate = await checkRiskGate({ action: 'seller_payout_mark_paid', context: riskContext, targetType: 'seller_payout', targetId: payoutId, requestedBy: 'admin' })
  if (gate.decision === 'deny') return { errors: { _form: [gate.reasons.join(' ')] } }
  if (gate.decision === 'pending') {
    return { errors: { _form: ['This payout requires approval before it can be marked paid.'] }, approvalRequestId: gate.approvalRequestId }
  }

  let txError: { errors: Record<string, string[]> } | null = null

  try {
    await prisma.$transaction(async (tx) => {
      if (gate.decision === 'consume_approved') {
        const consumed = await consumeApprovedRiskGate(tx, { approvalRequestId: gate.approvalRequestId, action: 'seller_payout_mark_paid', targetId: payoutId, context: riskContext })
        if (!consumed.ok) { txError = { errors: { _form: [consumed.error] } }; throw new Error('TX_VALIDATION') }
      }

      // Conditional update: only succeeds while the payout is still approved.
      // Prevents two simultaneous "mark paid" requests from both committing.
      const updated = await tx.sellerPayout.updateMany({
        where: { id: payoutId, status: 'approved' },
        data: { status: 'paid', paidAt: new Date(), paymentMethod, paymentReference },
      })
      if (updated.count === 0) {
        txError = {
          errors: { _form: ['Payout is already paid or is not in approved status.'] },
        }
        throw new Error('TX_VALIDATION')
      }

      if (gate.decision === 'consume_approved') await markApprovalConsumed(tx, gate.approvalRequestId)
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath('/admin/seller-payouts')
  revalidatePath(`/admin/seller-payouts/${payoutId}`)

  // Revalidate seller-facing pages — find all submissions linked to this payout's lines.
  const lines = await prisma.sellerPayoutLine.findMany({
    where: { payoutId },
    select: {
      agreement: { select: { submissionId: true } },
    },
  })
  const submissionIds = [
    ...new Set(
      lines
        .map((l) => l.agreement?.submissionId)
        .filter((s): s is string => !!s),
    ),
  ]
  for (const sid of submissionIds) {
    try {
      await ensureSellerLifecycleEvent({
        eventKey: `payout-paid:${payoutId}:${sid}`,
        sellerSubmissionId: sid,
        eventType: 'payout_paid',
        sourceEntityType: 'payout',
        sourceEntityId: payoutId,
        sellerVisible: true,
        sellerTitle: 'Payment recorded',
        sellerDescription: 'CollectNTrades recorded this payout as paid.',
        occurredAt: new Date(),
      })
    } catch (err) {
      console.error('[markSellerPayoutPaid] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
    }
    revalidatePath(`/account/sell/${sid}`)
  }
  revalidatePath('/account/sell')

  return null
}

// ─── Idempotent consignment payout line generation ────────────────────────────
// Called after order completion. Must not throw in a way that blocks order completion.

export async function ensureConsignmentPayoutLinesForCompletedOrder(
  orderId: string,
): Promise<{ created: number; skipped: number }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      completedAt: true,
      orderItems: {
        select: {
          id: true,
          price: true,
          item: {
            select: {
              sourceType: true,
              sellerAgreementId: true,
              sellerAgreement: {
                select: {
                  id: true,
                  type: true,
                  status: true,
                  commissionPercent: true,
                  fixedFee: true,
                  minimumSellerPayout: true,
                  commissionMinimumFee: true,
                  submission: { select: { profileId: true } },
                },
              },
            },
          },
        },
      },
    },
  })

  if (!order || !isOrderStatusEligibleForConsignmentPayout(order.status)) {
    return { created: 0, skipped: 0 }
  }

  const eligibleAt = order.completedAt ?? new Date()
  let created = 0
  let skipped = 0

  for (const oi of order.orderItems) {
    const item = oi.item
    const agreement = item.sellerAgreement

    if (
      !isItemEligibleForConsignmentPayout({
        sourceType: item.sourceType,
        agreementType: agreement?.type ?? null,
        agreementStatus: agreement?.status ?? null,
      })
    ) {
      skipped++
      continue
    }

    const customerProfileId = agreement!.submission?.profileId
    if (!customerProfileId) {
      skipped++
      continue
    }

    const sourceKey = buildConsignmentSourceKey(oi.id)

    const existing = await prisma.sellerPayoutLine.findUnique({ where: { sourceKey } })
    if (existing) {
      skipped++
      continue
    }

    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat: oi.price,
      commissionPercent: agreement!.commissionPercent,
      fixedFee: agreement!.fixedFee,
      minimumSellerPayout: agreement!.minimumSellerPayout,
      commissionMinimumFee: agreement!.commissionMinimumFee,
    })

    await prisma.sellerPayoutLine.create({
      data: {
        sourceKey,
        lineType: 'consignment',
        status: 'eligible',
        currency: 'USD',
        customerProfileId,
        agreementId: agreement!.id,
        orderItemId: oi.id,
        grossSalePrice: snapshot.grossSalePrice,
        commissionPercent: snapshot.commissionPercent,
        commissionAmount: snapshot.commissionAmount,
        commissionMinimumFee: snapshot.commissionMinimumFee,
        fixedFee: snapshot.fixedFee,
        minimumSellerPayout: snapshot.minimumSellerPayout,
        minimumAdjustment: snapshot.minimumAdjustment,
        netAmount: snapshot.netAmount,
        eligibleAt,
      },
    })
    created++
  }

  return { created, skipped }
}

// ─── Generate missing payout lines for a completed order (reconciliation) ─────

export type GeneratePayoutLinesActionState =
  | { success: true; created: number }
  | { errors: Record<string, string[]> }
  | null

export async function generateMissingPayoutLines(
  orderId: string,
  _prev: GeneratePayoutLinesActionState,
  formData: FormData,
): Promise<GeneratePayoutLinesActionState> {
  void formData

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  })
  if (!order) return { errors: { _form: ['Order not found.'] } }
  if (order.status !== 'complete') {
    return { errors: { _form: ['Payout lines can only be generated for completed orders.'] } }
  }

  const { created } = await ensureConsignmentPayoutLinesForCompletedOrder(orderId)

  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/seller-payouts')

  return { success: true, created }
}

// ─── Ensure buyout payout line for an accepted agreement (reconciliation) ──────
//
// Idempotent: if a line for sourceKey buyout:{agreementId} already exists and is
// consistent, returns success without creating a duplicate.  If the existing line
// has a mismatched agreementId or customerProfileId, returns an error requiring
// manual review.  Never creates inventory, changes orders, or marks payment paid.
//
// Source-key semantics: one buyout obligation per agreement, not per ItemInstance.
// agreedBuyoutAmount is the total seller payment for the entire agreement
// regardless of how many inventory units are linked.

export type EnsureBuyoutPayoutLineActionState =
  | { success: true; created: boolean }
  | { errors: Record<string, string[]> }
  | null

export async function ensureBuyoutPayoutLineForAgreement(
  agreementId: string,
  _prev: EnsureBuyoutPayoutLineActionState,
  formData: FormData,
): Promise<EnsureBuyoutPayoutLineActionState> {
  void formData

  const agreement = await prisma.sellerAgreement.findUnique({
    where: { id: agreementId },
    select: {
      id: true,
      type: true,
      status: true,
      agreedBuyoutAmount: true,
      submissionId: true,
      submission: { select: { profileId: true } },
      items: { select: { id: true }, take: 1 },
    },
  })

  if (!agreement) return { errors: { _form: ['Agreement not found.'] } }
  if (agreement.type !== 'buyout') {
    return { errors: { _form: ['Agreement is not a buyout agreement.'] } }
  }
  if (agreement.status !== 'accepted') {
    return { errors: { _form: ['Agreement must be in accepted status.'] } }
  }
  if (!agreement.agreedBuyoutAmount || agreement.agreedBuyoutAmount.lessThanOrEqualTo(new Prisma.Decimal(0))) {
    return { errors: { _form: ['Agreed buyout amount must be greater than zero.'] } }
  }
  if (agreement.items.length === 0) {
    return { errors: { _form: ['No linked inventory found for this agreement. Eligibility requires at least one inventory item.'] } }
  }

  const customerProfileId = agreement.submission?.profileId
  if (!customerProfileId) {
    return { errors: { _form: ['Could not resolve seller profile for this agreement.'] } }
  }

  const sourceKey = buildBuyoutSourceKey(agreementId)
  const existing = await prisma.sellerPayoutLine.findUnique({ where: { sourceKey } })

  if (existing) {
    // Verify consistency — reject if the existing line conflicts.
    if (existing.agreementId !== agreementId || existing.customerProfileId !== customerProfileId) {
      return {
        errors: {
          _form: [
            'A conflicting payout line already exists for this source key with different agreement or customer data. Manual review required.',
          ],
        },
      }
    }
    // Idempotent: consistent line already exists — return success without creating.
    revalidatePath(`/admin/seller-submissions/${agreement.submissionId}/agreement`)
    revalidatePath('/admin/seller-payouts')
    return { success: true, created: false }
  }

  const snap = calculateBuyoutPayoutSnapshot(agreement.agreedBuyoutAmount)
  await prisma.sellerPayoutLine.create({
    data: {
      sourceKey,
      lineType: 'buyout',
      status: 'eligible',
      currency: 'USD',
      customerProfileId,
      agreementId,
      agreedBuyoutAmount: snap.agreedBuyoutAmount,
      netAmount: snap.netAmount,
      eligibleAt: new Date(),
    },
  })

  revalidatePath(`/admin/seller-submissions/${agreement.submissionId}/agreement`)
  revalidatePath('/admin/seller-payouts')

  return { success: true, created: true }
}
