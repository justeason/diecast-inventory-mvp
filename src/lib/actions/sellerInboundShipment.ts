'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import { CONDITION_STATUSES } from '@/lib/sellerInboundShipmentConstants'
import type { ShipmentActionState } from '@/lib/sellerInboundShipmentConstants'

const MAX_CARRIER_LEN = 100
const MAX_TRACKING_LEN = 100
const MAX_NOTES_LEN = 2000
const MAX_ISSUE_LEN = 1000

function trimOrNull(v: FormDataEntryValue | null, max = 2000): string | null {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : ''
  return s || null
}

function parseDate(v: FormDataEntryValue | null): Date | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function revalidateShipmentPaths(submissionId: string) {
  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath('/account/sell')
  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  revalidatePath('/admin/intake/operations')
}

// ─── Seller: create or update inbound shipment ──────────────────────────────────

export async function saveSellerInboundShipment(
  _prev: ShipmentActionState,
  formData: FormData,
): Promise<ShipmentActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { form: ['You must be signed in.'] } }

  const submissionId = trimOrNull(formData.get('submissionId'))
  const shipmentId   = trimOrNull(formData.get('shipmentId'))
  const carrier      = trimOrNull(formData.get('carrier'), MAX_CARRIER_LEN)
  const trackingNumber = trimOrNull(formData.get('trackingNumber'), MAX_TRACKING_LEN)
  const rawQty       = formData.get('expectedQuantity')
  const shippedAt    = parseDate(formData.get('shippedAt'))
  const sellerNotes  = trimOrNull(formData.get('sellerNotes'), MAX_NOTES_LEN)

  if (!submissionId) return { errors: { form: ['Submission ID required.'] } }
  if (!carrier) return { errors: { carrier: ['Carrier is required.'] } }
  if (!trackingNumber) return { errors: { trackingNumber: ['Tracking number is required.'] } }

  const expectedQuantity = parseInt(typeof rawQty === 'string' ? rawQty : '', 10)
  if (isNaN(expectedQuantity) || expectedQuantity < 1) {
    return { errors: { expectedQuantity: ['Expected quantity must be at least 1.'] } }
  }

  const newStatus = shippedAt ? 'shipped' : 'draft'
  let txError: ShipmentActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionId} FOR UPDATE`

      const submission = await tx.sellerSubmission.findFirst({
        where: { id: submissionId, profileId: session.profileId },
        select: {
          id: true,
          status: true,
          sellerPortfolioId: true,
          agreements: {
            where: { status: 'accepted' },
            select: { id: true },
            take: 1,
          },
          intakeDrafts: {
            where: { status: 'converted' },
            select: { id: true },
            take: 1,
          },
          inboundShipments: {
            where: {
              trackingNumber: { equals: trackingNumber, mode: 'insensitive' },
              status: { not: 'cancelled' },
              ...(shipmentId ? { id: { not: shipmentId } } : {}),
            },
            select: { id: true },
          },
        },
      })

      if (!submission) {
        txError = { errors: { form: ['Submission not found or access denied.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (submission.status === 'withdrawn' || submission.status === 'declined') {
        txError = { errors: { form: ['Cannot add shipment: submission is no longer active.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (submission.agreements.length === 0) {
        txError = { errors: { form: ['An accepted agreement is required before adding a shipment.'] } }
        throw new Error('TX_VALIDATION')
      }
      // Block new shipments once inventory has been created from this submission
      if (!shipmentId && submission.intakeDrafts.length > 0) {
        txError = { errors: { form: ['Cannot add new shipments: this submission has already been converted to inventory.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (submission.inboundShipments.length > 0) {
        txError = { errors: { trackingNumber: ['A shipment with this tracking number already exists for this submission.'] } }
        throw new Error('TX_VALIDATION')
      }

      if (shipmentId) {
        await tx.$queryRaw`SELECT id FROM "SellerInboundShipment" WHERE id = ${shipmentId} FOR UPDATE`

        const existing = await tx.sellerInboundShipment.findFirst({
          where: { id: shipmentId, sellerSubmissionId: submissionId },
          select: { id: true, status: true },
        })
        if (!existing) {
          txError = { errors: { form: ['Shipment not found.'] } }
          throw new Error('TX_VALIDATION')
        }
        if (existing.status === 'received' || existing.status === 'issue') {
          txError = { errors: { form: ['Cannot edit a shipment that has already been received.'] } }
          throw new Error('TX_VALIDATION')
        }
        if (existing.status === 'cancelled') {
          txError = { errors: { form: ['Cannot edit a cancelled shipment.'] } }
          throw new Error('TX_VALIDATION')
        }

        await tx.sellerInboundShipment.update({
          where: { id: shipmentId },
          data: { carrier, trackingNumber, expectedQuantity, shippedAt: shippedAt ?? null, sellerNotes, status: newStatus },
        })
      } else {
        await tx.sellerInboundShipment.create({
          data: {
            sellerSubmissionId: submissionId,
            // 15B: denormalized once at creation from the (locked, freshly-read)
            // submission — never re-derived afterward, so this shipment can never
            // end up linked to a different portfolio than it started with.
            sellerPortfolioId: submission.sellerPortfolioId,
            carrier,
            trackingNumber,
            expectedQuantity,
            shippedAt: shippedAt ?? null,
            sellerNotes,
            status: newStatus,
          },
        })
      }
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  revalidateShipmentPaths(submissionId)
  return null
}

// ─── Admin: receive shipment ────────────────────────────────────────────────────

export async function receiveSellerInboundShipment(
  _prev: ShipmentActionState,
  formData: FormData,
): Promise<ShipmentActionState> {
  if (!await isAdminAuthenticated()) return { errors: { form: ['Admin authentication required.'] } }

  const shipmentId     = trimOrNull(formData.get('shipmentId'))
  const rawQty         = formData.get('receivedQuantity')
  const receivedAt     = parseDate(formData.get('receivedAt'))
  const receivedBy     = trimOrNull(formData.get('receivedBy'))
  const conditionRaw   = formData.get('conditionStatus')
  const issueSummary   = trimOrNull(formData.get('issueSummary'), MAX_ISSUE_LEN)
  const intakeDraftId  = trimOrNull(formData.get('intakeDraftId'))
  const adminNotes     = trimOrNull(formData.get('adminNotes'), MAX_NOTES_LEN)
  const confirm        = formData.get('confirm') === 'on'

  if (!shipmentId) return { errors: { form: ['Shipment ID required.'] } }
  if (!confirm) return { errors: { form: ['You must confirm receipt.'] } }

  const receivedQuantity = parseInt(typeof rawQty === 'string' ? rawQty : '', 10)
  if (isNaN(receivedQuantity) || receivedQuantity < 1) {
    return { errors: { receivedQuantity: ['Received quantity must be at least 1.'] } }
  }
  if (!receivedAt) return { errors: { receivedAt: ['A valid received date is required.'] } }

  const conditionStatus = typeof conditionRaw === 'string' ? conditionRaw.trim() : ''
  if (!(CONDITION_STATUSES as readonly string[]).includes(conditionStatus)) {
    return { errors: { conditionStatus: ['A valid condition status is required.'] } }
  }

  const isIssue = conditionStatus !== 'good'
  if (isIssue && !issueSummary) {
    return { errors: { issueSummary: ['Issue summary is required when condition is not good.'] } }
  }

  const newStatus = isIssue ? 'issue' : 'received'
  let txError: ShipmentActionState = null
  let submissionId: string | null = null
  let caseId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      // Pre-read for canonical lock ordering
      const preRead = await tx.sellerInboundShipment.findUnique({
        where: { id: shipmentId },
        select: { sellerSubmissionId: true },
      })
      if (!preRead) {
        txError = { errors: { form: ['Shipment not found.'] } }
        throw new Error('TX_VALIDATION')
      }

      // Lock in canonical order: SellerSubmission → SellerInboundShipment → IntakeDraft
      await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${preRead.sellerSubmissionId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "SellerInboundShipment" WHERE id = ${shipmentId} FOR UPDATE`

      // Authoritative re-read
      const shipment = await tx.sellerInboundShipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, status: true, sellerSubmissionId: true, expectedQuantity: true },
      })
      if (!shipment) {
        txError = { errors: { form: ['Shipment not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (shipment.status === 'received' || shipment.status === 'issue') {
        txError = { errors: { form: ['This shipment has already been received.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (shipment.status !== 'shipped') {
        txError = { errors: { form: ['Only shipped packages can be received. Mark the package as shipped first.'] } }
        throw new Error('TX_VALIDATION')
      }

      submissionId = shipment.sellerSubmissionId

      if (intakeDraftId) {
        await tx.$queryRaw`SELECT id FROM "IntakeDraft" WHERE id = ${intakeDraftId} FOR UPDATE`

        const draft = await tx.intakeDraft.findUnique({
          where: { id: intakeDraftId },
          select: { id: true, status: true, sellerSubmissionId: true, receivedAt: true },
        })
        if (!draft) {
          txError = { errors: { intakeDraftId: ['Intake draft not found.'] } }
          throw new Error('TX_VALIDATION')
        }
        if (draft.sellerSubmissionId !== submissionId) {
          txError = { errors: { intakeDraftId: ['Intake draft does not belong to this submission.'] } }
          throw new Error('TX_VALIDATION')
        }
        if (draft.status === 'rejected' || draft.status === 'converted') {
          txError = { errors: { intakeDraftId: [`Cannot link to a ${draft.status} intake draft.`] } }
          throw new Error('TX_VALIDATION')
        }

        if (draft.receivedAt) {
          // Intake already has a receipt — linking would leave conflicting totals.
          // Admin must explicitly resolve the discrepancy (unlink, or choose a different draft).
          const existingDate = draft.receivedAt.toISOString().split('T')[0]
          txError = {
            errors: {
              intakeDraftId: [
                `This intake draft was already received on ${existingDate}. ` +
                `Linking this shipment would not update the intake receipt and may create a quantity mismatch. ` +
                `Choose a different intake draft or leave the intake link empty.`,
              ],
            },
          }
          throw new Error('TX_VALIDATION')
        }

        await tx.intakeDraft.update({
          where: { id: intakeDraftId },
          data: {
            receivedAt,
            receivedQuantity,
            receivedBy: receivedBy ?? null,
            receivingNotes: adminNotes ?? null,
          },
        })
      }

      await tx.sellerInboundShipment.update({
        where: { id: shipmentId },
        data: {
          status: newStatus,
          receivedQuantity,
          receivedAt,
          receivedBy: receivedBy ?? null,
          conditionStatus,
          issueSummary: issueSummary ?? null,
          adminNotes: adminNotes ?? null,
          ...(intakeDraftId ? { intakeDraftId } : {}),
        },
      })

      // Create or reuse lifecycle case for non-good condition
      if (isIssue) {
        const issueCaseType = conditionStatus === 'damaged' ? 'lost_or_damaged' : 'other'
        const existingCase = await tx.sellerLifecycleCase.findFirst({
          where: {
            sellerSubmissionId: submissionId,
            caseType: issueCaseType,
            status: { in: ['open', 'action_required'] },
          },
          select: { id: true },
        })
        if (existingCase) {
          caseId = existingCase.id
          await tx.sellerLifecycleCase.update({
            where: { id: existingCase.id },
            data: {
              status: 'action_required',
              sellerMessage: issueSummary ?? 'There is an issue with your package.',
            },
          })
        } else {
          const created = await tx.sellerLifecycleCase.create({
            data: {
              sellerSubmissionId: submissionId,
              caseType: issueCaseType,
              status: 'action_required',
              sellerVisible: true,
              sellerMessage: issueSummary ?? 'There is an issue with your package.',
              adminNotes: `Shipment ${shipmentId} condition: ${conditionStatus}. ${issueSummary ?? ''}`.trim(),
            },
          })
          caseId = created.id
        }
      }

      // Idempotent seller-visible lifecycle event
      await ensureSellerLifecycleEvent({
        eventKey: `shipment-received:${shipmentId}`,
        sellerSubmissionId: submissionId,
        eventType: 'shipment_received',
        sourceEntityType: 'SellerInboundShipment',
        sourceEntityId: shipmentId,
        sellerVisible: true,
        sellerTitle: isIssue ? 'Package received — issue noted' : 'Package received',
        sellerDescription: isIssue
          ? 'Your package was received but there is an issue that needs attention.'
          : 'Your package has been received and is being processed.',
        adminDescription: `Shipment ${shipmentId} received (qty=${receivedQuantity}, condition=${conditionStatus}).`,
        occurredAt: receivedAt,
        tx,
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  if (submissionId) {
    revalidateShipmentPaths(submissionId)
    revalidatePath('/admin/intake/operations')
    if (caseId) revalidatePath(`/admin/seller-cases/${caseId}`)
  }
  return null
}

// ─── Seller: cancel shipment ────────────────────────────────────────────────────

export async function sellerCancelShipment(
  _prev: ShipmentActionState,
  formData: FormData,
): Promise<ShipmentActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { form: ['You must be signed in.'] } }

  const shipmentId = trimOrNull(formData.get('shipmentId'))
  if (!shipmentId) return { errors: { form: ['Shipment ID required.'] } }

  let txError: ShipmentActionState = null
  let submissionId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      // Pre-read for ownership check and canonical lock ordering
      const preRead = await tx.sellerInboundShipment.findUnique({
        where: { id: shipmentId },
        select: {
          sellerSubmissionId: true,
          sellerSubmission: { select: { profileId: true } },
        },
      })
      if (!preRead) {
        txError = { errors: { form: ['Shipment not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (preRead.sellerSubmission.profileId !== session.profileId) {
        txError = { errors: { form: ['Access denied.'] } }
        throw new Error('TX_VALIDATION')
      }

      await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${preRead.sellerSubmissionId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "SellerInboundShipment" WHERE id = ${shipmentId} FOR UPDATE`

      const reRead = await tx.sellerInboundShipment.findUnique({
        where: { id: shipmentId },
        select: { status: true },
      })
      if (!reRead) throw new Error('TX_VALIDATION')
      if (reRead.status === 'received' || reRead.status === 'issue') {
        txError = { errors: { form: ['Cannot cancel a shipment that has already been received.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (reRead.status === 'cancelled') {
        txError = { errors: { form: ['This shipment is already cancelled.'] } }
        throw new Error('TX_VALIDATION')
      }

      submissionId = preRead.sellerSubmissionId
      await tx.sellerInboundShipment.update({ where: { id: shipmentId }, data: { status: 'cancelled' } })

      await ensureSellerLifecycleEvent({
        eventKey: `shipment-cancelled:${shipmentId}`,
        sellerSubmissionId: submissionId,
        eventType: 'shipment_cancelled',
        sourceEntityType: 'SellerInboundShipment',
        sourceEntityId: shipmentId,
        sellerVisible: false,
        adminDescription: `Seller cancelled shipment ${shipmentId}.`,
        occurredAt: new Date(),
        tx,
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  if (submissionId) revalidateShipmentPaths(submissionId)
  return null
}

// ─── Admin: cancel shipment ─────────────────────────────────────────────────────

export async function adminCancelShipment(
  _prev: ShipmentActionState,
  formData: FormData,
): Promise<ShipmentActionState> {
  if (!await isAdminAuthenticated()) return { errors: { form: ['Admin authentication required.'] } }

  const shipmentId   = trimOrNull(formData.get('shipmentId'))
  const cancelReason = trimOrNull(formData.get('cancelReason'))

  if (!shipmentId) return { errors: { form: ['Shipment ID required.'] } }
  if (!cancelReason) return { errors: { cancelReason: ['A cancel reason is required.'] } }

  let txError: ShipmentActionState = null
  let submissionId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      const preRead = await tx.sellerInboundShipment.findUnique({
        where: { id: shipmentId },
        select: { sellerSubmissionId: true },
      })
      if (!preRead) {
        txError = { errors: { form: ['Shipment not found.'] } }
        throw new Error('TX_VALIDATION')
      }

      await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${preRead.sellerSubmissionId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "SellerInboundShipment" WHERE id = ${shipmentId} FOR UPDATE`

      const reRead = await tx.sellerInboundShipment.findUnique({
        where: { id: shipmentId },
        select: { status: true },
      })
      if (!reRead) throw new Error('TX_VALIDATION')
      if (reRead.status === 'received' || reRead.status === 'issue') {
        txError = { errors: { form: ['Cannot cancel a received shipment.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (reRead.status === 'cancelled') {
        txError = { errors: { form: ['Already cancelled.'] } }
        throw new Error('TX_VALIDATION')
      }

      submissionId = preRead.sellerSubmissionId
      await tx.sellerInboundShipment.update({
        where: { id: shipmentId },
        data: { status: 'cancelled', adminNotes: cancelReason },
      })

      await ensureSellerLifecycleEvent({
        eventKey: `shipment-cancelled:${shipmentId}`,
        sellerSubmissionId: submissionId,
        eventType: 'shipment_cancelled',
        sourceEntityType: 'SellerInboundShipment',
        sourceEntityId: shipmentId,
        sellerVisible: false,
        adminDescription: `Admin cancelled shipment ${shipmentId}: ${cancelReason}`,
        occurredAt: new Date(),
        tx,
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  if (submissionId) revalidateShipmentPaths(submissionId)
  return null
}
