'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import { setItemStorageInTx, type ItemMutationOutcome } from '@/lib/itemMutations'

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

// 15I (focused-review pass): delegates entirely to the shared authoritative storage
// primitive in itemMutations.ts (validateItemStorageMove/setItemStorageInTx) — the
// IMMOVABLE_STATUSES/return-pending-case rules are no longer duplicated here. This
// is the single-item "move" action; the bulk equivalent is 15I's own
// executeBulkItemAction({ action: 'set_storage' }), which opens one such transaction
// per selected item independently (partial success). There is no longer a separate
// all-or-nothing bulkMoveInventoryItems — it was unused by any UI and its
// all-or-nothing semantics duplicated (and diverged from) these same rules; removed
// rather than kept as a second implementation.
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

  let outcome: ItemMutationOutcome
  try {
    outcome = await prisma.$transaction((tx) => setItemStorageInTx(tx, { itemId, locationId }))
  } catch {
    return { errors: { form: ['Move failed. Please retry.'] } }
  }

  if (outcome.outcome === 'not_found') return { errors: { form: ['Item not found.'] } }
  if (outcome.outcome === 'validation_failed') return { errors: { form: [outcome.reason] } }

  revalidatePath('/admin/items')
  return null
}
