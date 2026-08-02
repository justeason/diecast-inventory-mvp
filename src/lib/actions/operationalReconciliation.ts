'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import {
  buildBuyoutSourceKey,
  buildConsignmentSourceKey,
  calculateBuyoutPayoutSnapshot,
  calculateConsignmentPayoutSnapshot,
  isItemEligibleForConsignmentPayout,
  isOrderStatusEligibleForConsignmentPayout,
} from '@/lib/sellerPayoutCalculation'

export type RepairActionState =
  | { success: true; message: string }
  | { errors: Record<string, string[]> }
  | null

export async function repairReconciliationIssue(
  _prev: RepairActionState,
  formData: FormData,
): Promise<RepairActionState> {
  const authenticated = await isAdminAuthenticated()
  if (!authenticated) {
    return { errors: { _form: ['Unauthorized.'] } }
  }

  const repairType = (formData.get('repairType') as string)?.trim()
  const issueKey = (formData.get('issueKey') as string)?.trim()
  const entityType = (formData.get('entityType') as string)?.trim()
  const entityId = (formData.get('entityId') as string)?.trim()

  if (!repairType || !issueKey || !entityType || !entityId) {
    return { errors: { _form: ['Missing required repair fields.'] } }
  }

  switch (repairType) {
    case 'generate_buyout_payout_line':
      return repairGenerateBuyoutPayoutLine({ issueKey, entityType, entityId, formData })
    case 'generate_consignment_payout_line':
      return repairGenerateConsignmentPayoutLine({ issueKey, entityType, entityId, formData })
    case 'archive_active_listing':
      return repairArchiveActiveListing({ issueKey, entityType, entityId, formData })
    case 'recalculate_payout_total':
      return repairRecalculatePayoutTotal({ issueKey, entityType, entityId, formData })
    case 'open_lifecycle_case':
      return repairOpenLifecycleCase({ issueKey, entityType, entityId, formData })
    case 'hold_payout_line':
      return repairHoldPayoutLine({ issueKey, entityType, entityId, formData })
    default:
      return { errors: { _form: [`Unknown repair type: ${repairType}`] } }
  }
}

// ─── generate_buyout_payout_line ──────────────────────────────────────────────

async function repairGenerateBuyoutPayoutLine(ctx: {
  issueKey: string
  entityType: string
  entityId: string
  formData: FormData
}): Promise<RepairActionState> {
  const agreementId = (ctx.formData.get('agreementId') as string)?.trim()
  if (!agreementId) return { errors: { _form: ['agreementId is required.'] } }

  // Cross-entity validation: agreementId must match the issue entity
  if (agreementId !== ctx.entityId) {
    return { errors: { _form: ['Agreement ID does not match issue entity — cross-entity repair rejected.'] } }
  }

  let beforeSnapshot: object = {}
  let afterSnapshot: object = {}
  let txError: RepairActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Lock the agreement row
      await tx.$queryRaw`SELECT id FROM "SellerAgreement" WHERE id = ${agreementId} FOR UPDATE`

      const agreement = await tx.sellerAgreement.findUnique({
        where: { id: agreementId },
        select: {
          id: true,
          type: true,
          status: true,
          agreedBuyoutAmount: true,
          submissionId: true,
          submission: { select: { profileId: true } },
          items: { select: { id: true }, take: 1 },
          payoutLines: { select: { id: true }, take: 1 },
        },
      })

      if (!agreement) {
        txError = { errors: { _form: ['Agreement not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (agreement.type !== 'buyout') {
        txError = { errors: { _form: ['Agreement is not a buyout type — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (agreement.status !== 'accepted') {
        txError = { errors: { _form: ['Agreement is no longer accepted — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (agreement.items.length === 0) {
        txError = { errors: { _form: ['Agreement has no linked items — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (agreement.payoutLines.length > 0) {
        txError = { errors: { _form: ['Payout line already exists — issue is already resolved.'] } }
        throw new Error('TX_VALIDATION')
      }

      const customerProfileId = agreement.submission?.profileId
      if (!customerProfileId) {
        txError = { errors: { _form: ['Cannot resolve seller profile.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (!agreement.agreedBuyoutAmount || agreement.agreedBuyoutAmount.lessThanOrEqualTo(new Prisma.Decimal(0))) {
        txError = { errors: { _form: ['Agreed buyout amount must be greater than zero.'] } }
        throw new Error('TX_VALIDATION')
      }

      beforeSnapshot = { payoutLinesCount: 0, agreementStatus: agreement.status }

      const sourceKey = buildBuyoutSourceKey(agreementId)
      const existing = await tx.sellerPayoutLine.findUnique({ where: { sourceKey } })
      if (existing) {
        txError = { errors: { _form: ['Payout line already exists for this source key — issue is already resolved.'] } }
        throw new Error('TX_VALIDATION')
      }

      const snap = calculateBuyoutPayoutSnapshot(agreement.agreedBuyoutAmount)
      const line = await tx.sellerPayoutLine.create({
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

      afterSnapshot = { payoutLineId: line.id, netAmount: line.netAmount.toString(), sourceKey }

      await tx.operationalReconciliationAudit.create({
        data: {
          issueKey: ctx.issueKey,
          repairType: 'generate_buyout_payout_line',
          entityType: ctx.entityType,
          entityId: ctx.entityId,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
          result: 'success',
          adminInfo: 'admin',
        },
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath('/admin/seller-payouts')
  revalidatePath(`/admin/seller-submissions/${ctx.formData.get('submissionId') ?? ''}`)
  revalidatePath('/admin/reconciliation')
  return { success: true, message: 'Buyout payout line generated successfully.' }
}

// ─── generate_consignment_payout_line ─────────────────────────────────────────

async function repairGenerateConsignmentPayoutLine(ctx: {
  issueKey: string
  entityType: string
  entityId: string
  formData: FormData
}): Promise<RepairActionState> {
  const orderId = (ctx.formData.get('orderId') as string)?.trim()
  if (!orderId) return { errors: { _form: ['orderId is required.'] } }

  // orderItemId is the entityId when this repair is triggered
  const orderItemId = ctx.entityId
  let beforeSnapshot: object = {}
  let afterSnapshot: object = {}
  let txError: RepairActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Lock the order, then order item
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "OrderItem" WHERE id = ${orderItemId} FOR UPDATE`

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, completedAt: true },
      })
      if (!order) {
        txError = { errors: { _form: ['Order not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (!isOrderStatusEligibleForConsignmentPayout(order.status)) {
        txError = { errors: { _form: ['Order is not in eligible status — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }

      const oi = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        select: {
          id: true,
          orderId: true,
          price: true,
          sellerPayoutLine: { select: { id: true } },
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
                  submission: { select: { profileId: true } },
                },
              },
            },
          },
        },
      })

      if (!oi) {
        txError = { errors: { _form: ['Order item not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      // Cross-entity validation: order item must match the issue entity
      if (oi.id !== ctx.entityId) {
        txError = { errors: { _form: ['Order item ID does not match issue entity — cross-entity repair rejected.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (oi.orderId !== orderId) {
        txError = { errors: { _form: ['Order item does not belong to the given order.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (oi.sellerPayoutLine) {
        txError = { errors: { _form: ['Payout line already exists — issue is already resolved.'] } }
        throw new Error('TX_VALIDATION')
      }

      const item = oi.item
      const agreement = item.sellerAgreement
      if (
        !isItemEligibleForConsignmentPayout({
          sourceType: item.sourceType,
          agreementType: agreement?.type ?? null,
          agreementStatus: agreement?.status ?? null,
        })
      ) {
        txError = { errors: { _form: ['Item is no longer eligible for consignment payout — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }

      const customerProfileId = agreement!.submission?.profileId
      if (!customerProfileId) {
        txError = { errors: { _form: ['Cannot resolve seller profile.'] } }
        throw new Error('TX_VALIDATION')
      }

      const sourceKey = buildConsignmentSourceKey(orderItemId)
      const existing = await tx.sellerPayoutLine.findUnique({ where: { sourceKey } })
      if (existing) {
        txError = { errors: { _form: ['Payout line already exists for this source key — issue is already resolved.'] } }
        throw new Error('TX_VALIDATION')
      }

      beforeSnapshot = { payoutLine: null }

      const snapshot = calculateConsignmentPayoutSnapshot({
        grossSalePriceFloat: oi.price,
        commissionPercent: agreement!.commissionPercent,
        fixedFee: agreement!.fixedFee,
        minimumSellerPayout: agreement!.minimumSellerPayout,
      })
      const eligibleAt = order.completedAt ?? new Date()

      const line = await tx.sellerPayoutLine.create({
        data: {
          sourceKey,
          lineType: 'consignment',
          status: 'eligible',
          currency: 'USD',
          customerProfileId,
          agreementId: agreement!.id,
          orderItemId,
          grossSalePrice: snapshot.grossSalePrice,
          commissionPercent: snapshot.commissionPercent,
          commissionAmount: snapshot.commissionAmount,
          fixedFee: snapshot.fixedFee,
          minimumSellerPayout: snapshot.minimumSellerPayout,
          minimumAdjustment: snapshot.minimumAdjustment,
          netAmount: snapshot.netAmount,
          eligibleAt,
        },
      })

      afterSnapshot = { payoutLineId: line.id, netAmount: line.netAmount.toString(), sourceKey }

      await tx.operationalReconciliationAudit.create({
        data: {
          issueKey: ctx.issueKey,
          repairType: 'generate_consignment_payout_line',
          entityType: ctx.entityType,
          entityId: ctx.entityId,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
          result: 'success',
          adminInfo: 'admin',
        },
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/seller-payouts')
  revalidatePath('/admin/reconciliation')
  return { success: true, message: 'Consignment payout line generated successfully.' }
}

// ─── archive_active_listing ───────────────────────────────────────────────────

async function repairArchiveActiveListing(ctx: {
  issueKey: string
  entityType: string
  entityId: string
  formData: FormData
}): Promise<RepairActionState> {
  const listingId = (ctx.formData.get('listingId') as string)?.trim()
  if (!listingId) return { errors: { _form: ['listingId is required.'] } }

  let beforeSnapshot: object = {}
  let afterSnapshot: object = {}
  let txError: RepairActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Non-locking pre-read to obtain itemId (needed to acquire locks in canonical order)
      const preRead = await tx.listing.findUnique({
        where: { id: listingId },
        select: { id: true, itemId: true },
      })
      if (!preRead) {
        txError = { errors: { _form: ['Listing not found — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }

      // Canonical lock order: ItemInstance first, then Listing
      await tx.$queryRaw`SELECT id FROM "ItemInstance" WHERE id = ${preRead.itemId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "Listing" WHERE id = ${listingId} FOR UPDATE`

      // Re-read listing after locks (authoritative state — no TOCTOU)
      const listingRows = await tx.$queryRaw<Array<{ id: string; itemId: string; status: string }>>`
        SELECT id, "itemId", status FROM "Listing" WHERE id = ${listingId}`

      if (listingRows.length === 0 || listingRows[0].status !== 'active') {
        txError = { errors: { _form: ['Listing is not active — issue is already resolved.'] } }
        throw new Error('TX_VALIDATION')
      }

      const listingRow = listingRows[0]

      // Cross-entity validation: if entityType is ItemInstance, the listing must belong to that item
      if (ctx.entityType === 'ItemInstance' && listingRow.itemId !== ctx.entityId) {
        txError = { errors: { _form: ['Listing does not belong to the issue item — cross-entity repair rejected.'] } }
        throw new Error('TX_VALIDATION')
      }

      beforeSnapshot = { listingStatus: listingRow.status }

      await tx.listing.update({
        where: { id: listingId },
        data: { status: 'archived' },
      })

      afterSnapshot = { listingStatus: 'archived' }

      await tx.operationalReconciliationAudit.create({
        data: {
          issueKey: ctx.issueKey,
          repairType: 'archive_active_listing',
          entityType: ctx.entityType,
          entityId: ctx.entityId,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
          result: 'success',
          adminInfo: 'admin',
        },
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath('/admin/listings')
  revalidatePath(`/admin/listings/${listingId}/edit`)
  revalidatePath('/admin/reconciliation')
  return { success: true, message: 'Listing archived successfully.' }
}

// ─── recalculate_payout_total ─────────────────────────────────────────────────

async function repairRecalculatePayoutTotal(ctx: {
  issueKey: string
  entityType: string
  entityId: string
  formData: FormData
}): Promise<RepairActionState> {
  const payoutId = (ctx.formData.get('payoutId') as string)?.trim()
  if (!payoutId) return { errors: { _form: ['payoutId is required.'] } }

  // Cross-entity validation: payoutId must match the issue entity
  if (payoutId !== ctx.entityId) {
    return { errors: { _form: ['Payout ID does not match issue entity — cross-entity repair rejected.'] } }
  }

  const ZERO = new Prisma.Decimal(0)
  let beforeSnapshot: object = {}
  let afterSnapshot: object = {}
  let txError: RepairActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SellerPayout" WHERE id = ${payoutId} FOR UPDATE`

      const payout = await tx.sellerPayout.findUnique({
        where: { id: payoutId },
        select: {
          id: true,
          status: true,
          totalAmount: true,
          lines: { select: { netAmount: true } },
        },
      })

      if (!payout) {
        txError = { errors: { _form: ['Payout not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (payout.status !== 'draft') {
        txError = { errors: { _form: ['Payout is not in draft status — only draft payouts can be recalculated.'] } }
        throw new Error('TX_VALIDATION')
      }

      const newTotal = payout.lines
        .reduce((acc, l) => acc.plus(l.netAmount), ZERO)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

      if (newTotal.equals(payout.totalAmount)) {
        txError = { errors: { _form: ['Payout total is already correct — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }

      beforeSnapshot = { totalAmount: payout.totalAmount.toString() }

      const updated = await tx.sellerPayout.updateMany({
        where: { id: payoutId, status: 'draft' },
        data: { totalAmount: newTotal },
      })

      if (updated.count === 0) {
        txError = { errors: { _form: ['Payout was concurrently modified. Please refresh.'] } }
        throw new Error('TX_VALIDATION')
      }

      afterSnapshot = { totalAmount: newTotal.toString() }

      await tx.operationalReconciliationAudit.create({
        data: {
          issueKey: ctx.issueKey,
          repairType: 'recalculate_payout_total',
          entityType: ctx.entityType,
          entityId: ctx.entityId,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
          result: 'success',
          adminInfo: 'admin',
        },
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath('/admin/seller-payouts')
  revalidatePath(`/admin/seller-payouts/${payoutId}`)
  revalidatePath('/admin/reconciliation')
  return { success: true, message: 'Payout total recalculated successfully.' }
}

// ─── open_lifecycle_case ──────────────────────────────────────────────────────

async function repairOpenLifecycleCase(ctx: {
  issueKey: string
  entityType: string
  entityId: string
  formData: FormData
}): Promise<RepairActionState> {
  const submissionId = (ctx.formData.get('submissionId') as string)?.trim()
  const caseType = ((ctx.formData.get('caseType') as string)?.trim()) || 'other'

  if (!submissionId) return { errors: { _form: ['submissionId is required.'] } }

  let beforeSnapshot: object = {}
  let afterSnapshot: object = {}
  let txError: RepairActionState = null
  let caseId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionId} FOR UPDATE`

      // When entityType is SellerInboundShipment, verify submission matches the shipment
      if (ctx.entityType === 'SellerInboundShipment') {
        const shipment = await tx.sellerInboundShipment.findUnique({
          where: { id: ctx.entityId },
          select: { sellerSubmissionId: true },
        })
        if (!shipment || shipment.sellerSubmissionId !== submissionId) {
          txError = { errors: { _form: ['Submission ID does not match shipment — cross-entity repair rejected.'] } }
          throw new Error('TX_VALIDATION')
        }
      }

      const submission = await tx.sellerSubmission.findUnique({
        where: { id: submissionId },
        select: {
          id: true,
          lifecycleCases: {
            where: { caseType, status: { in: ['open', 'action_required'] } },
            select: { id: true },
            take: 1,
          },
        },
      })

      if (!submission) {
        txError = { errors: { _form: ['Seller submission not found.'] } }
        throw new Error('TX_VALIDATION')
      }

      if (submission.lifecycleCases.length > 0) {
        txError = { errors: { _form: [`An open case of type '${caseType}' already exists — issue may be stale.`] } }
        throw new Error('TX_VALIDATION')
      }

      beforeSnapshot = { openCasesOfType: 0 }

      const lifecycleCase = await tx.sellerLifecycleCase.create({
        data: {
          sellerSubmissionId: submissionId,
          caseType,
          status: 'open',
          sellerVisible: false,
          adminNotes: `Opened via operational reconciliation repair (issueKey: ${ctx.issueKey})`,
        },
      })
      caseId = lifecycleCase.id

      afterSnapshot = { caseId: lifecycleCase.id, caseType, status: 'open' }

      await tx.operationalReconciliationAudit.create({
        data: {
          issueKey: ctx.issueKey,
          repairType: 'open_lifecycle_case',
          entityType: ctx.entityType,
          entityId: ctx.entityId,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
          result: 'success',
          adminInfo: 'admin',
        },
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath('/admin/seller-lifecycle')
  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  if (caseId) revalidatePath(`/admin/seller-cases/${caseId}`)
  revalidatePath('/admin/reconciliation')
  return { success: true, message: 'Lifecycle case opened successfully.' }
}

// ─── hold_payout_line ─────────────────────────────────────────────────────────

async function repairHoldPayoutLine(ctx: {
  issueKey: string
  entityType: string
  entityId: string
  formData: FormData
}): Promise<RepairActionState> {
  const lineId = (ctx.formData.get('lineId') as string)?.trim()
  if (!lineId) return { errors: { _form: ['lineId is required.'] } }

  // Cross-entity validation: lineId must match the issue entity
  if (ctx.entityType === 'SellerPayoutLine' && lineId !== ctx.entityId) {
    return { errors: { _form: ['Payout line ID does not match issue entity — cross-entity repair rejected.'] } }
  }

  let beforeSnapshot: object = {}
  let afterSnapshot: object = {}
  let txError: RepairActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Lock the payout line BEFORE reading (prevents TOCTOU)
      await tx.$queryRaw`SELECT id FROM "SellerPayoutLine" WHERE id = ${lineId} FOR UPDATE`

      // Re-fetch AFTER acquiring lock
      const line = await tx.sellerPayoutLine.findUnique({
        where: { id: lineId },
        select: { id: true, status: true, payoutId: true },
      })

      if (!line) {
        txError = { errors: { _form: ['Payout line not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (line.status !== 'eligible') {
        txError = { errors: { _form: ['Payout line is not eligible — issue may be stale.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (line.payoutId !== null) {
        txError = { errors: { _form: ['Cannot hold a line already in a payout batch.'] } }
        throw new Error('TX_VALIDATION')
      }

      beforeSnapshot = { status: line.status }

      const updated = await tx.sellerPayoutLine.updateMany({
        where: { id: lineId, status: 'eligible', payoutId: null },
        data: {
          status: 'held',
          heldAt: new Date(),
          holdReason: `Held via operational reconciliation — open dispute case (issueKey: ${ctx.issueKey})`,
        },
      })

      if (updated.count !== 1) {
        txError = { errors: { _form: ['Payout line was concurrently modified. Please refresh.'] } }
        throw new Error('TX_VALIDATION')
      }

      afterSnapshot = { status: 'held' }

      await tx.operationalReconciliationAudit.create({
        data: {
          issueKey: ctx.issueKey,
          repairType: 'hold_payout_line',
          entityType: ctx.entityType,
          entityId: ctx.entityId,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
          result: 'success',
          adminInfo: 'admin',
        },
      })
    })
  } catch (err) {
    if (txError) return txError
    throw err
  }

  revalidatePath('/admin/seller-payouts')
  revalidatePath('/admin/reconciliation')
  return { success: true, message: 'Payout line held successfully.' }
}
