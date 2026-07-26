'use server'

import { revalidatePath } from 'next/cache'
import { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'

type TxClient = Prisma.TransactionClient | PrismaClient

export type LifecycleActionState = { errors: Record<string, string[]> } | { success: true } | null

// ─── Idempotent lifecycle event creation ───────────────────────────────────────

export async function ensureSellerLifecycleEvent(params: {
  eventKey: string
  sellerSubmissionId: string
  eventType: string
  sourceEntityType?: string
  sourceEntityId?: string
  sellerVisible: boolean
  sellerTitle?: string
  sellerDescription?: string
  adminDescription?: string
  metadata?: Record<string, unknown>
  occurredAt: Date
  tx?: TxClient
}): Promise<void> {
  const db = params.tx ?? prisma

  const existing = await db.sellerLifecycleEvent.findUnique({
    where: { eventKey: params.eventKey },
    select: { id: true, sellerSubmissionId: true },
  })

  if (existing) {
    if (existing.sellerSubmissionId !== params.sellerSubmissionId) {
      throw new Error(
        `Lifecycle event key conflict for ${params.eventKey}: different sellerSubmissionId.`,
      )
    }
    // Consistent event already exists — idempotent skip.
    return
  }

  try {
    await db.sellerLifecycleEvent.create({
      data: {
        eventKey: params.eventKey,
        sellerSubmissionId: params.sellerSubmissionId,
        eventType: params.eventType,
        sourceEntityType: params.sourceEntityType ?? null,
        sourceEntityId: params.sourceEntityId ?? null,
        sellerVisible: params.sellerVisible,
        sellerTitle: params.sellerTitle ?? null,
        sellerDescription: params.sellerDescription ?? null,
        adminDescription: params.adminDescription ?? null,
        metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
        occurredAt: params.occurredAt,
      },
    })
  } catch (err) {
    // Unique constraint race — another writer created the same event. Safe to ignore.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return
    }
    throw err
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function trimOrNull(v: FormDataEntryValue | null): string | null {
  const t = typeof v === 'string' ? v.trim() : ''
  return t || null
}

function parseDate(v: FormDataEntryValue | null): Date | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function revalidateLifecyclePaths(submissionId: string) {
  revalidatePath('/admin/seller-lifecycle')
  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath('/account/sell')
}

// ─── Reject seller intake ──────────────────────────────────────────────────────

export async function rejectSellerIntake(
  intakeDraftId: string,
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const rejectionReason = trimOrNull(formData.get('rejectionReason'))
  const sellerRejectionReason = trimOrNull(formData.get('sellerRejectionReason'))
  const confirm = formData.get('confirm') === 'on'

  if (!rejectionReason) return { errors: { rejectionReason: ['Internal rejection reason is required.'] } }
  if (!sellerRejectionReason) {
    return { errors: { sellerRejectionReason: ['Seller-facing reason is required.'] } }
  }
  if (!confirm) return { errors: { _form: ['You must confirm the rejection.'] } }

  let txError: { errors: Record<string, string[]> } | null = null
  let submissionId: string | null = null
  let caseId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const draft = await tx.intakeDraft.findUnique({
        where: { id: intakeDraftId },
        select: { id: true, status: true, convertedItemId: true, sellerSubmissionId: true, rejectedAt: true },
      })
      if (!draft) {
        txError = { errors: { _form: ['Intake draft not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (draft.convertedItemId) {
        txError = { errors: { _form: ['This draft has been converted and cannot be rejected.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (draft.status === 'rejected' || draft.rejectedAt) {
        txError = { errors: { _form: ['This draft is already rejected.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (!draft.sellerSubmissionId) {
        txError = { errors: { _form: ['This intake draft is not linked to a seller submission.'] } }
        throw new Error('TX_VALIDATION')
      }

      submissionId = draft.sellerSubmissionId

      await tx.intakeDraft.update({
        where: { id: intakeDraftId },
        data: {
          status: 'rejected',
          rejectedAt: new Date(),
          rejectionReason,
          sellerRejectionReason,
        },
      })

      // Retry safety — never create a duplicate intake_rejection case for this draft.
      const existingCase = await tx.sellerLifecycleCase.findFirst({
        where: { intakeDraftId, caseType: 'intake_rejection' },
        select: { id: true },
      })
      if (existingCase) {
        caseId = existingCase.id
      } else {
        // Intake rejection leaves operational next steps (communicate result, determine
        // return, record return shipment, confirm physical return, and possibly cancel the
        // agreement). The case must stay open for explicit admin resolution — NOT resolved.
        const lifecycleCase = await tx.sellerLifecycleCase.create({
          data: {
            sellerSubmissionId: draft.sellerSubmissionId,
            caseType: 'intake_rejection',
            status: 'action_required',
            intakeDraftId,
            sellerVisible: true,
            sellerMessage: sellerRejectionReason,
            adminNotes: rejectionReason,
          },
        })
        caseId = lifecycleCase.id
      }

      await ensureSellerLifecycleEvent({
        eventKey: `intake-rejected:${intakeDraftId}`,
        sellerSubmissionId: draft.sellerSubmissionId,
        eventType: 'intake_rejected',
        sourceEntityType: 'intake_draft',
        sourceEntityId: intakeDraftId,
        sellerVisible: true,
        sellerTitle: 'Intake review completed',
        sellerDescription: sellerRejectionReason,
        adminDescription: rejectionReason,
        occurredAt: new Date(),
        tx,
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  if (submissionId) {
    revalidateLifecyclePaths(submissionId)
    revalidatePath(`/admin/intake/${intakeDraftId}/edit`)
    if (caseId) revalidatePath(`/admin/seller-cases/${caseId}`)
  }
  return { success: true }
}

// ─── Open post-sale seller case ─────────────────────────────────────────────────

const POST_SALE_CASE_TYPES = ['buyer_return', 'buyer_dispute', 'lost_or_damaged', 'other']

export async function openPostSaleSellerCase(
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const sellerSubmissionId = trimOrNull(formData.get('sellerSubmissionId'))
  const orderItemId = trimOrNull(formData.get('orderItemId'))
  const caseType = trimOrNull(formData.get('caseType'))
  const sellerMessage = trimOrNull(formData.get('sellerMessage'))
  const adminNotesInput = trimOrNull(formData.get('adminNotes'))
  const sellerVisible = formData.get('sellerVisible') === 'on'
  const confirm = formData.get('confirm') === 'on'

  if (!sellerSubmissionId) return { errors: { _form: ['Seller submission is required.'] } }
  if (!orderItemId) return { errors: { orderItemId: ['Order item is required.'] } }
  if (!caseType || !POST_SALE_CASE_TYPES.includes(caseType)) {
    return { errors: { caseType: ['A valid case type is required.'] } }
  }
  if (!confirm) return { errors: { _form: ['You must confirm opening this case.'] } }

  let txError: { errors: Record<string, string[]> } | null = null
  let caseId: string | null = null
  let orderId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const orderItem = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        select: {
          id: true,
          orderId: true,
          item: {
            select: {
              id: true,
              sourceType: true,
              sellerAgreementId: true,
              listing: { select: { id: true } },
              sellerAgreement: { select: { id: true, submissionId: true } },
            },
          },
          sellerPayoutLine: {
            select: { id: true, status: true, payoutId: true, payout: { select: { status: true } } },
          },
        },
      })
      if (!orderItem) {
        txError = { errors: { _form: ['Order item not found.'] } }
        throw new Error('TX_VALIDATION')
      }

      const item = orderItem.item
      if (!item.sourceType || item.sourceType === 'company_owned') {
        txError = { errors: { _form: ['This order item is not a seller-sourced item.'] } }
        throw new Error('TX_VALIDATION')
      }
      const agreement = item.sellerAgreement
      if (!agreement || agreement.submissionId !== sellerSubmissionId) {
        txError = { errors: { _form: ['Order item does not belong to the given seller submission.'] } }
        throw new Error('TX_VALIDATION')
      }

      orderId = orderItem.orderId

      // Determine case status and admin annotations based on payout state.
      let caseStatus = 'open'
      let adminNotes = adminNotesInput
      const line = orderItem.sellerPayoutLine

      if (line) {
        if (line.status === 'eligible' && !line.payoutId) {
          // Hold the line.
          await tx.sellerPayoutLine.update({
            where: { id: line.id },
            data: { status: 'held', heldAt: new Date(), holdReason: `Post-sale case (${caseType}) opened.` },
          })
        } else if (line.status === 'held') {
          // Leave existing hold in place.
        } else if (line.payoutId) {
          const payoutStatus = line.payout?.status
          if (payoutStatus === 'draft') {
            caseStatus = 'action_required'
            adminNotes = [adminNotes, 'Related payout line is in a DRAFT payout. Remove it from the batch before approval.']
              .filter(Boolean)
              .join('\n')
          } else if (payoutStatus === 'approved') {
            caseStatus = 'action_required'
            adminNotes = [adminNotes, 'CRITICAL: related payout is already APPROVED. Manual review required before payment.']
              .filter(Boolean)
              .join('\n')
          } else if (payoutStatus === 'paid') {
            caseStatus = 'action_required'
            adminNotes = [adminNotes, 'CRITICAL: related payout is already PAID. Manual review and possible recovery required.']
              .filter(Boolean)
              .join('\n')
          }
        }
      }

      const lifecycleCase = await tx.sellerLifecycleCase.create({
        data: {
          sellerSubmissionId,
          caseType,
          status: caseStatus,
          agreementId: agreement.id,
          itemInstanceId: item.id,
          listingId: item.listing?.id ?? null,
          orderId: orderItem.orderId,
          orderItemId,
          sellerPayoutLineId: line?.id ?? null,
          sellerVisible,
          sellerMessage,
          adminNotes,
        },
      })
      caseId = lifecycleCase.id

      await ensureSellerLifecycleEvent({
        eventKey: `case-opened:${lifecycleCase.id}`,
        sellerSubmissionId,
        eventType: 'case_opened',
        sourceEntityType: 'lifecycle_case',
        sourceEntityId: lifecycleCase.id,
        sellerVisible,
        sellerTitle: sellerVisible ? 'Issue opened' : undefined,
        sellerDescription: sellerVisible ? sellerMessage ?? undefined : undefined,
        adminDescription: `Post-sale case opened (${caseType}).`,
        occurredAt: new Date(),
        tx,
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidateLifecyclePaths(sellerSubmissionId)
  if (orderId) revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/seller-payouts')
  if (caseId) revalidatePath(`/admin/seller-cases/${caseId}`)
  return { success: true }
}

// ─── Record return shipment ─────────────────────────────────────────────────────

export async function recordSellerReturnShipment(
  caseId: string,
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const carrier = trimOrNull(formData.get('carrier'))
  const trackingNumber = trimOrNull(formData.get('trackingNumber'))
  const shippedAt = parseDate(formData.get('shippedAt'))
  const sellerMessage = trimOrNull(formData.get('sellerMessage'))
  const confirm = formData.get('confirm') === 'on'

  if (!carrier) return { errors: { carrier: ['Carrier is required.'] } }
  if (!trackingNumber) return { errors: { trackingNumber: ['Tracking number is required.'] } }
  if (!shippedAt) return { errors: { shippedAt: ['A valid shipped date is required.'] } }
  if (!confirm) return { errors: { _form: ['You must confirm the return shipment.'] } }

  const existing = await prisma.sellerLifecycleCase.findUnique({
    where: { id: caseId },
    select: { id: true, sellerSubmissionId: true },
  })
  if (!existing) return { errors: { _form: ['Case not found.'] } }

  await prisma.sellerLifecycleCase.update({
    where: { id: caseId },
    data: {
      returnCarrier: carrier,
      returnTrackingNumber: trackingNumber,
      returnShippedAt: shippedAt,
      ...(sellerMessage ? { sellerMessage } : {}),
    },
  })

  await ensureSellerLifecycleEvent({
    eventKey: `return-shipped:${caseId}:${shippedAt.toISOString()}`,
    sellerSubmissionId: existing.sellerSubmissionId,
    eventType: 'return_shipped',
    sourceEntityType: 'lifecycle_case',
    sourceEntityId: caseId,
    sellerVisible: true,
    sellerTitle: 'Return shipped',
    sellerDescription: `Your item is being returned via ${carrier}.`,
    adminDescription: `Return shipment recorded (${carrier} ${trackingNumber}).`,
    occurredAt: shippedAt,
  }).catch(() => {})

  revalidateLifecyclePaths(existing.sellerSubmissionId)
  revalidatePath(`/admin/seller-cases/${caseId}`)
  return { success: true }
}

// ─── Mark seller item returned ──────────────────────────────────────────────────

export async function markSellerItemReturned(
  caseId: string,
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const returnedAt = parseDate(formData.get('returnedAt'))
  const resolutionSummary = trimOrNull(formData.get('resolutionSummary'))
  const confirm = formData.get('confirm') === 'on'

  if (!returnedAt) return { errors: { returnedAt: ['A valid returned date is required.'] } }
  if (!resolutionSummary) return { errors: { resolutionSummary: ['A resolution summary is required.'] } }
  if (!confirm) return { errors: { _form: ['You must confirm the item was returned.'] } }

  let txError: { errors: Record<string, string[]> } | null = null
  let submissionId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const lifecycleCase = await tx.sellerLifecycleCase.findUnique({
        where: { id: caseId },
        select: {
          id: true,
          sellerSubmissionId: true,
          returnedAt: true,
          itemInstanceId: true,
          listingId: true,
        },
      })
      if (!lifecycleCase) {
        txError = { errors: { _form: ['Case not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (lifecycleCase.returnedAt) {
        txError = { errors: { _form: ['This item is already marked as returned.'] } }
        throw new Error('TX_VALIDATION')
      }
      submissionId = lifecycleCase.sellerSubmissionId

      await tx.sellerLifecycleCase.update({
        where: { id: caseId },
        data: {
          returnedAt,
          resolvedAt: new Date(),
          status: 'resolved',
          resolutionSummary,
        },
      })

      if (lifecycleCase.itemInstanceId) {
        await tx.itemInstance.update({
          where: { id: lifecycleCase.itemInstanceId },
          data: { status: 'not_for_sale' },
        })
      }
      if (lifecycleCase.listingId) {
        await tx.listing.updateMany({
          where: { id: lifecycleCase.listingId, status: { not: 'archived' } },
          data: { status: 'archived' },
        })
      }

      await ensureSellerLifecycleEvent({
        eventKey: `case-resolved:${caseId}`,
        sellerSubmissionId: lifecycleCase.sellerSubmissionId,
        eventType: 'case_resolved',
        sourceEntityType: 'lifecycle_case',
        sourceEntityId: caseId,
        sellerVisible: true,
        sellerTitle: 'Return completed',
        sellerDescription: 'Your item has been returned.',
        adminDescription: resolutionSummary,
        occurredAt: returnedAt,
        tx,
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  if (submissionId) {
    revalidateLifecyclePaths(submissionId)
    revalidatePath(`/admin/seller-cases/${caseId}`)
    revalidatePath('/admin/items')
    revalidatePath('/admin/listings')
  }
  return { success: true }
}

// ─── Resolve case ───────────────────────────────────────────────────────────────

export async function resolveSellerLifecycleCase(
  caseId: string,
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const resolutionSummary = trimOrNull(formData.get('resolutionSummary'))
  const sellerMessage = trimOrNull(formData.get('sellerMessage'))
  const confirm = formData.get('confirm') === 'on'

  if (!resolutionSummary) return { errors: { resolutionSummary: ['A resolution summary is required.'] } }
  if (!confirm) return { errors: { _form: ['You must confirm resolving this case.'] } }

  const existing = await prisma.sellerLifecycleCase.findUnique({
    where: { id: caseId },
    select: { id: true, sellerSubmissionId: true, sellerVisible: true },
  })
  if (!existing) return { errors: { _form: ['Case not found.'] } }

  const updated = await prisma.sellerLifecycleCase.updateMany({
    where: { id: caseId, status: { in: ['open', 'action_required'] } },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      resolutionSummary,
      ...(existing.sellerVisible && sellerMessage ? { sellerMessage } : {}),
    },
  })
  if (updated.count !== 1) {
    return { errors: { _form: ['Case is not open or was already resolved. Refresh and try again.'] } }
  }

  await ensureSellerLifecycleEvent({
    eventKey: `case-resolved:${caseId}`,
    sellerSubmissionId: existing.sellerSubmissionId,
    eventType: 'case_resolved',
    sourceEntityType: 'lifecycle_case',
    sourceEntityId: caseId,
    sellerVisible: existing.sellerVisible,
    sellerTitle: existing.sellerVisible ? 'Issue resolved' : undefined,
    sellerDescription: existing.sellerVisible ? sellerMessage ?? undefined : undefined,
    adminDescription: resolutionSummary,
    occurredAt: new Date(),
  }).catch(() => {})

  revalidateLifecyclePaths(existing.sellerSubmissionId)
  revalidatePath(`/admin/seller-cases/${caseId}`)
  return { success: true }
}

// ─── Cancel case ────────────────────────────────────────────────────────────────

export async function cancelSellerLifecycleCase(
  caseId: string,
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const cancelReason = trimOrNull(formData.get('cancelReason'))
  const confirm = formData.get('confirm') === 'on'

  if (!cancelReason) return { errors: { cancelReason: ['A cancel reason is required.'] } }
  if (!confirm) return { errors: { _form: ['You must confirm cancelling this case.'] } }

  const existing = await prisma.sellerLifecycleCase.findUnique({
    where: { id: caseId },
    select: { id: true, sellerSubmissionId: true },
  })
  if (!existing) return { errors: { _form: ['Case not found.'] } }

  const updated = await prisma.sellerLifecycleCase.updateMany({
    where: { id: caseId, status: { in: ['open', 'action_required'] } },
    data: { status: 'cancelled', cancelledAt: new Date(), adminNotes: cancelReason },
  })
  if (updated.count !== 1) {
    return { errors: { _form: ['Case is not open or was already closed. Refresh and try again.'] } }
  }

  await ensureSellerLifecycleEvent({
    eventKey: `case-cancelled:${caseId}`,
    sellerSubmissionId: existing.sellerSubmissionId,
    eventType: 'case_cancelled',
    sourceEntityType: 'lifecycle_case',
    sourceEntityId: caseId,
    sellerVisible: false,
    adminDescription: `Case cancelled: ${cancelReason}`,
    occurredAt: new Date(),
  }).catch(() => {})

  revalidateLifecyclePaths(existing.sellerSubmissionId)
  revalidatePath(`/admin/seller-cases/${caseId}`)
  return { success: true }
}

// ─── Record seller withdrawal ───────────────────────────────────────────────────

export async function recordSellerWithdrawal(
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const sellerSubmissionId = trimOrNull(formData.get('sellerSubmissionId'))
  const itemInstanceId = trimOrNull(formData.get('itemInstanceId'))
  const adminNotes = trimOrNull(formData.get('adminNotes'))
  const sellerSummary = trimOrNull(formData.get('sellerSummary'))
  const confirm = formData.get('confirm') === 'on'

  if (!sellerSubmissionId) return { errors: { _form: ['Seller submission is required.'] } }
  if (!adminNotes) return { errors: { adminNotes: ['Admin notes are required.'] } }
  if (!sellerSummary) return { errors: { sellerSummary: ['A seller-facing summary is required.'] } }
  if (!confirm) return { errors: { _form: ['You must confirm the withdrawal.'] } }

  let txError: { errors: Record<string, string[]> } | null = null
  let caseId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const submission = await tx.sellerSubmission.findUnique({
        where: { id: sellerSubmissionId },
        select: { id: true },
      })
      if (!submission) {
        txError = { errors: { _form: ['Seller submission not found.'] } }
        throw new Error('TX_VALIDATION')
      }

      if (!itemInstanceId) {
        // Pre-conversion withdrawal — resolved immediately.
        const lifecycleCase = await tx.sellerLifecycleCase.create({
          data: {
            sellerSubmissionId,
            caseType: 'seller_withdrawal',
            status: 'resolved',
            sellerVisible: true,
            sellerMessage: sellerSummary,
            adminNotes,
            resolutionSummary: 'Withdrawal recorded before inventory conversion.',
            resolvedAt: new Date(),
          },
        })
        caseId = lifecycleCase.id

        await ensureSellerLifecycleEvent({
          eventKey: `case-opened:${lifecycleCase.id}`,
          sellerSubmissionId,
          eventType: 'seller_withdrawal',
          sourceEntityType: 'lifecycle_case',
          sourceEntityId: lifecycleCase.id,
          sellerVisible: true,
          sellerTitle: 'Withdrawal recorded',
          sellerDescription: sellerSummary,
          adminDescription: adminNotes,
          occurredAt: new Date(),
          tx,
        })
        return
      }

      // Item-specific withdrawal — validate item state.
      const item = await tx.itemInstance.findUnique({
        where: { id: itemInstanceId },
        select: { id: true, status: true, sourceType: true, listing: { select: { id: true } } },
      })
      if (!item) {
        txError = { errors: { _form: ['Item not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (item.status === 'reserved') {
        txError = { errors: { _form: ['This item is in an active buyer order and cannot be withdrawn.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (item.status === 'sold') {
        txError = { errors: { _form: ['This item has already been sold and cannot be withdrawn.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (item.sourceType === 'buyout') {
        txError = {
          errors: {
            _form: [
              'This is a buyout item that CollectNTrades already purchased. Withdrawal requires a separate financial resolution.',
            ],
          },
        }
        throw new Error('TX_VALIDATION')
      }

      if (item.listing?.id) {
        await tx.listing.updateMany({
          where: { id: item.listing.id, status: { not: 'archived' } },
          data: { status: 'archived' },
        })
      }

      const lifecycleCase = await tx.sellerLifecycleCase.create({
        data: {
          sellerSubmissionId,
          caseType: 'return_to_seller',
          status: 'open',
          itemInstanceId: item.id,
          listingId: item.listing?.id ?? null,
          sellerVisible: true,
          sellerMessage: sellerSummary,
          adminNotes,
        },
      })
      caseId = lifecycleCase.id

      await ensureSellerLifecycleEvent({
        eventKey: `case-opened:${lifecycleCase.id}`,
        sellerSubmissionId,
        eventType: 'seller_withdrawal',
        sourceEntityType: 'lifecycle_case',
        sourceEntityId: lifecycleCase.id,
        sellerVisible: true,
        sellerTitle: 'Withdrawal recorded',
        sellerDescription: sellerSummary,
        adminDescription: adminNotes,
        occurredAt: new Date(),
        tx,
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidateLifecyclePaths(sellerSubmissionId)
  revalidatePath('/admin/items')
  revalidatePath('/admin/listings')
  if (caseId) revalidatePath(`/admin/seller-cases/${caseId}`)
  return { success: true }
}

// ─── Expire consignment ─────────────────────────────────────────────────────────

const EXPIRE_NEXT_ACTIONS = ['renew', 'return', 'manual']

export async function expireConsignment(
  _prev: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  const itemInstanceId = trimOrNull(formData.get('itemInstanceId'))
  const expirationReason = trimOrNull(formData.get('expirationReason'))
  const nextAction = trimOrNull(formData.get('nextAction'))
  const confirm = formData.get('confirm') === 'on'

  if (!itemInstanceId) return { errors: { _form: ['Item is required.'] } }
  if (!expirationReason) return { errors: { expirationReason: ['An expiration reason is required.'] } }
  if (!nextAction || !EXPIRE_NEXT_ACTIONS.includes(nextAction)) {
    return { errors: { nextAction: ['A valid next action is required.'] } }
  }
  if (!confirm) return { errors: { _form: ['You must confirm the expiration.'] } }

  let txError: { errors: Record<string, string[]> } | null = null
  let submissionId: string | null = null
  let caseId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const item = await tx.itemInstance.findUnique({
        where: { id: itemInstanceId },
        select: {
          id: true,
          status: true,
          sourceType: true,
          listing: { select: { id: true } },
          sellerAgreement: { select: { id: true, submissionId: true } },
        },
      })
      if (!item) {
        txError = { errors: { _form: ['Item not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (item.sourceType !== 'consignment') {
        txError = { errors: { _form: ['Only consignment items can be expired.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (item.status === 'reserved' || item.status === 'sold') {
        txError = { errors: { _form: ['This item is in an active order or sold and cannot be expired.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (!item.sellerAgreement?.submissionId) {
        txError = { errors: { _form: ['Could not resolve the seller submission for this item.'] } }
        throw new Error('TX_VALIDATION')
      }
      submissionId = item.sellerAgreement.submissionId

      if (nextAction === 'renew') {
        await ensureSellerLifecycleEvent({
          eventKey: `consignment-renewed:${itemInstanceId}:${Date.now()}`,
          sellerSubmissionId: submissionId,
          eventType: 'consignment_renewed',
          sourceEntityType: 'item_instance',
          sourceEntityId: itemInstanceId,
          sellerVisible: false,
          adminDescription: `Consignment renewed: ${expirationReason}`,
          occurredAt: new Date(),
          tx,
        })
        return
      }

      if (nextAction === 'return') {
        if (item.listing?.id) {
          await tx.listing.updateMany({
            where: { id: item.listing.id, status: { not: 'archived' } },
            data: { status: 'archived' },
          })
        }
        const lifecycleCase = await tx.sellerLifecycleCase.create({
          data: {
            sellerSubmissionId: submissionId,
            caseType: 'consignment_expiration',
            status: 'action_required',
            agreementId: item.sellerAgreement.id,
            itemInstanceId: item.id,
            listingId: item.listing?.id ?? null,
            sellerVisible: true,
            sellerMessage: 'Your consignment period has ended and your item will be returned.',
            adminNotes: expirationReason,
          },
        })
        caseId = lifecycleCase.id
        await ensureSellerLifecycleEvent({
          eventKey: `case-opened:${lifecycleCase.id}`,
          sellerSubmissionId: submissionId,
          eventType: 'consignment_expired',
          sourceEntityType: 'lifecycle_case',
          sourceEntityId: lifecycleCase.id,
          sellerVisible: true,
          sellerTitle: 'Consignment ended',
          sellerDescription: 'Your consignment period has ended.',
          adminDescription: expirationReason,
          occurredAt: new Date(),
          tx,
        })
        return
      }

      // manual
      const lifecycleCase = await tx.sellerLifecycleCase.create({
        data: {
          sellerSubmissionId: submissionId,
          caseType: 'consignment_expiration',
          status: 'open',
          agreementId: item.sellerAgreement.id,
          itemInstanceId: item.id,
          listingId: item.listing?.id ?? null,
          sellerVisible: false,
          adminNotes: expirationReason,
        },
      })
      caseId = lifecycleCase.id
      await ensureSellerLifecycleEvent({
        eventKey: `case-opened:${lifecycleCase.id}`,
        sellerSubmissionId: submissionId,
        eventType: 'consignment_expired',
        sourceEntityType: 'lifecycle_case',
        sourceEntityId: lifecycleCase.id,
        sellerVisible: false,
        adminDescription: `Consignment expiration flagged for manual handling: ${expirationReason}`,
        occurredAt: new Date(),
        tx,
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  if (submissionId) {
    revalidateLifecyclePaths(submissionId)
    revalidatePath('/admin/items')
    revalidatePath('/admin/listings')
    if (caseId) revalidatePath(`/admin/seller-cases/${caseId}`)
  }
  return { success: true }
}
