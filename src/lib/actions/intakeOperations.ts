'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'

export type IntakeOpsActionState = { errors: Record<string, string[]> } | null

export type BulkAssignResult = {
  assigned: number
  skipped: number
  errors: { intakeId: string; reason: string }[]
}

export async function recordIntakeReceipt(
  _prev: IntakeOpsActionState,
  formData: FormData
): Promise<IntakeOpsActionState> {
  const intakeId = (formData.get('intakeId') as string)?.trim() || ''
  const rawQty = (formData.get('receivedQuantity') as string)?.trim() || ''
  const rawDate = (formData.get('receivedAt') as string)?.trim() || ''
  const receivedBy = (formData.get('receivedBy') as string)?.trim() || null
  const receivingNotes = (formData.get('receivingNotes') as string)?.trim() || null

  if (!intakeId) return { errors: { form: ['Intake ID required.'] } }

  const qty = parseInt(rawQty, 10)
  if (isNaN(qty) || qty < 1) return { errors: { receivedQuantity: ['Received quantity must be at least 1.'] } }

  const receivedAt = rawDate ? new Date(rawDate) : new Date()
  if (isNaN(receivedAt.getTime())) return { errors: { receivedAt: ['Invalid date.'] } }

  // Pre-read to get submissionId for canonical lock ordering (SellerSubmission → IntakeDraft)
  const preRead = await prisma.intakeDraft.findUnique({
    where: { id: intakeId },
    select: { sellerSubmissionId: true },
  })
  const submissionIdForLock = preRead?.sellerSubmissionId ?? null

  let txError: IntakeOpsActionState = null
  let submissionId: string | null = null

  try {
    await prisma.$transaction(async (tx) => {
      // Lock SellerSubmission first (canonical order: submission → draft)
      if (submissionIdForLock) {
        await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionIdForLock} FOR UPDATE`
      }
      // Then lock IntakeDraft
      await tx.$queryRaw`SELECT id FROM "IntakeDraft" WHERE id = ${intakeId} FOR UPDATE`

      const draft = await tx.intakeDraft.findUnique({
        where: { id: intakeId },
        select: { id: true, status: true, sellerSubmissionId: true, receivedAt: true },
      })

      if (!draft) {
        txError = { errors: { form: ['Intake draft not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (draft.status === 'converted' || draft.status === 'rejected') {
        txError = { errors: { form: [`Cannot record receipt: draft is already ${draft.status}.`] } }
        throw new Error('TX_VALIDATION')
      }
      if (draft.receivedAt != null) {
        txError = { errors: { form: ['Receipt already recorded. Edit the draft directly to correct fields.'] } }
        throw new Error('TX_VALIDATION')
      }

      submissionId = draft.sellerSubmissionId

      if (submissionId) {
        const submission = await tx.sellerSubmission.findUnique({
          where: { id: submissionId },
          select: { id: true, status: true },
        })
        if (!submission) {
          txError = { errors: { form: ['Linked seller submission not found.'] } }
          throw new Error('TX_VALIDATION')
        }
        if (submission.status !== 'approved_for_intake') {
          txError = {
            errors: {
              form: [
                `Submission must be approved for intake (currently: ${submission.status}).`,
              ],
            },
          }
          throw new Error('TX_VALIDATION')
        }
      }

      await tx.intakeDraft.update({
        where: { id: intakeId },
        data: { receivedAt, receivedQuantity: qty, receivedBy, receivingNotes },
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  if (submissionId) {
    await ensureSellerLifecycleEvent({
      eventKey: `item_received:${intakeId}`,
      sellerSubmissionId: submissionId,
      eventType: 'item_received',
      sourceEntityType: 'IntakeDraft',
      sourceEntityId: intakeId,
      sellerVisible: true,
      sellerTitle: 'Item received',
      sellerDescription: 'Your item has been received by our team and is being reviewed.',
      adminDescription: `Item received: qty=${qty}${receivedBy ? `, by=${receivedBy}` : ''}`,
      occurredAt: receivedAt,
    })
  }

  revalidatePath('/admin/intake/operations')
  revalidatePath(`/admin/intake/${intakeId}/edit`)
  return null
}

export async function assignIntakeStorage(
  _prev: IntakeOpsActionState,
  formData: FormData
): Promise<IntakeOpsActionState> {
  const intakeId = (formData.get('intakeId') as string)?.trim() || ''
  const locationId = (formData.get('storageLocationId') as string)?.trim() || ''

  if (!intakeId) return { errors: { form: ['Intake ID required.'] } }
  if (!locationId) return { errors: { storageLocationId: ['Storage location required.'] } }

  // Pre-flight for quick UX feedback (non-authoritative)
  const [draft, location] = await Promise.all([
    prisma.intakeDraft.findUnique({ where: { id: intakeId }, select: { id: true, status: true } }),
    prisma.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } }),
  ])

  if (!draft) return { errors: { form: ['Intake draft not found.'] } }
  if (draft.status === 'converted') return { errors: { form: ['Cannot assign storage to a converted draft.'] } }
  if (!location) return { errors: { storageLocationId: ['Storage location not found.'] } }

  let txError: IntakeOpsActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Lock IntakeDraft to serialize against concurrent conversion
      await tx.$queryRaw`SELECT id FROM "IntakeDraft" WHERE id = ${intakeId} FOR UPDATE`

      const draftInTx = await tx.intakeDraft.findUnique({
        where: { id: intakeId },
        select: { id: true, status: true },
      })
      if (!draftInTx) {
        txError = { errors: { form: ['Intake draft not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (draftInTx.status === 'converted') {
        txError = { errors: { form: ['Cannot assign storage to a converted draft.'] } }
        throw new Error('TX_VALIDATION')
      }

      // Re-validate location inside TX
      const locInTx = await tx.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } })
      if (!locInTx) {
        txError = { errors: { storageLocationId: ['Storage location was deleted. Please select another.'] } }
        throw new Error('TX_VALIDATION')
      }

      await tx.intakeDraft.update({
        where: { id: intakeId },
        data: { storageLocationId: locationId },
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  revalidatePath('/admin/intake/operations')
  revalidatePath(`/admin/intake/${intakeId}/edit`)
  return null
}

export async function bulkAssignIntakeStorage(
  _prev: IntakeOpsActionState,
  formData: FormData
): Promise<IntakeOpsActionState> {
  const intakeIds = formData
    .getAll('intakeId')
    .map((v) => (v as string).trim())
    .filter(Boolean)
  const locationId = (formData.get('storageLocationId') as string)?.trim() || ''

  if (intakeIds.length === 0) return { errors: { form: ['No intakes selected.'] } }
  if (!locationId) return { errors: { storageLocationId: ['Storage location required.'] } }

  const location = await prisma.storageLocation.findUnique({
    where: { id: locationId },
    select: { id: true },
  })
  if (!location) return { errors: { storageLocationId: ['Storage location not found.'] } }

  const sortedIds = [...intakeIds].sort()
  let txError: IntakeOpsActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Blocking sorted locks — entire batch fails if any row cannot be acquired
      for (const id of sortedIds) {
        await tx.$queryRaw`SELECT id FROM "IntakeDraft" WHERE id = ${id} FOR UPDATE`
      }

      const drafts = await tx.intakeDraft.findMany({
        where: { id: { in: sortedIds } },
        select: { id: true, status: true },
      })

      const draftMap = new Map(drafts.map((d) => [d.id, d]))
      const missingIds = sortedIds.filter((id) => !draftMap.has(id))
      const convertedIds = drafts.filter((d) => d.status === 'converted').map((d) => d.id)

      if (missingIds.length > 0) {
        txError = { errors: { form: [`${missingIds.length} intake(s) not found.`] } }
        throw new Error('TX_VALIDATION')
      }
      if (convertedIds.length > 0) {
        txError = {
          errors: {
            form: [
              `${convertedIds.length} intake(s) already converted — cannot assign storage. Deselect converted intakes and retry.`,
            ],
          },
        }
        throw new Error('TX_VALIDATION')
      }

      await tx.intakeDraft.updateMany({
        where: { id: { in: sortedIds } },
        data: { storageLocationId: locationId },
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    return { errors: { form: ['Bulk assignment failed. Please retry.'] } }
  }

  revalidatePath('/admin/intake/operations')
  return null
}

const IMMOVABLE_STATUSES = ['sold', 'reserved', 'not_for_sale'] as const
const RETURN_PENDING_CASE_TYPES = ['return_to_seller', 'consignment_expiration', 'seller_withdrawal'] as const

export async function moveInventoryItem(
  _prev: IntakeOpsActionState,
  formData: FormData
): Promise<IntakeOpsActionState> {
  const itemId = (formData.get('itemId') as string)?.trim() || ''
  const locationId = (formData.get('storageLocationId') as string)?.trim() || ''

  if (!itemId) return { errors: { form: ['Item ID required.'] } }
  if (!locationId) return { errors: { storageLocationId: ['Storage location required.'] } }

  const location = await prisma.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } })
  if (!location) return { errors: { storageLocationId: ['Storage location not found.'] } }

  let txError: IntakeOpsActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ItemInstance" WHERE id = ${itemId} FOR UPDATE`

      const item = await tx.itemInstance.findUnique({ where: { id: itemId }, select: { id: true, status: true } })
      if (!item) {
        txError = { errors: { form: ['Item not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if ((IMMOVABLE_STATUSES as readonly string[]).includes(item.status)) {
        txError = {
          errors: { form: [`Cannot move item with status '${item.status}'.`] },
        }
        throw new Error('TX_VALIDATION')
      }

      // Block items with an open return-pending case
      const openReturnCase = await tx.sellerLifecycleCase.findFirst({
        where: {
          itemInstanceId: itemId,
          caseType: { in: [...RETURN_PENDING_CASE_TYPES] },
          status: { in: ['open', 'action_required'] },
        },
        select: { id: true, caseType: true },
      })
      if (openReturnCase) {
        txError = { errors: { form: [`Cannot move item: it has an open ${openReturnCase.caseType} case.`] } }
        throw new Error('TX_VALIDATION')
      }

      // Re-validate location inside TX
      const locInTx = await tx.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } })
      if (!locInTx) {
        txError = { errors: { storageLocationId: ['Storage location was deleted. Please select another.'] } }
        throw new Error('TX_VALIDATION')
      }

      await tx.itemInstance.update({ where: { id: itemId }, data: { locationId } })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  revalidatePath('/admin/items')
  return null
}

export async function bulkMoveInventoryItems(
  _prev: IntakeOpsActionState,
  formData: FormData
): Promise<IntakeOpsActionState> {
  const itemIds = formData
    .getAll('itemId')
    .map((v) => (v as string).trim())
    .filter(Boolean)
  const locationId = (formData.get('storageLocationId') as string)?.trim() || ''

  if (itemIds.length === 0) return { errors: { form: ['No items selected.'] } }
  if (!locationId) return { errors: { storageLocationId: ['Storage location required.'] } }

  const location = await prisma.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } })
  if (!location) return { errors: { storageLocationId: ['Storage location not found.'] } }

  const sortedIds = [...itemIds].sort()
  let txError: IntakeOpsActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Blocking sorted locks — entire batch fails atomically if any row is ineligible
      for (const id of sortedIds) {
        await tx.$queryRaw`SELECT id FROM "ItemInstance" WHERE id = ${id} FOR UPDATE`
      }

      const items = await tx.itemInstance.findMany({
        where: { id: { in: sortedIds } },
        select: { id: true, status: true },
      })

      const itemMap = new Map(items.map((i) => [i.id, i]))
      const missingIds = sortedIds.filter((id) => !itemMap.has(id))
      const immovable = items.filter((i) => (IMMOVABLE_STATUSES as readonly string[]).includes(i.status))

      if (missingIds.length > 0) {
        txError = { errors: { form: [`${missingIds.length} item(s) not found.`] } }
        throw new Error('TX_VALIDATION')
      }
      if (immovable.length > 0) {
        txError = {
          errors: {
            form: [
              `${immovable.length} item(s) cannot be moved (sold, reserved, or not for sale). Deselect them and retry.`,
            ],
          },
        }
        throw new Error('TX_VALIDATION')
      }

      // Block items with open return-pending cases
      const returnCases = await tx.sellerLifecycleCase.findMany({
        where: {
          itemInstanceId: { in: sortedIds },
          caseType: { in: [...RETURN_PENDING_CASE_TYPES] },
          status: { in: ['open', 'action_required'] },
        },
        select: { itemInstanceId: true },
      })
      if (returnCases.length > 0) {
        txError = {
          errors: {
            form: [`${returnCases.length} item(s) have open return cases and cannot be moved.`],
          },
        }
        throw new Error('TX_VALIDATION')
      }

      // Re-validate location inside TX
      const locInTx = await tx.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } })
      if (!locInTx) {
        txError = { errors: { storageLocationId: ['Storage location was deleted.'] } }
        throw new Error('TX_VALIDATION')
      }

      await tx.itemInstance.updateMany({
        where: { id: { in: sortedIds } },
        data: { locationId },
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    return { errors: { form: ['Bulk move failed. Please retry.'] } }
  }

  revalidatePath('/admin/items')
  return null
}
