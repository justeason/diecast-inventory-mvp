'use server'

// 15E: Intake Exception Queue resolution. Owns NO conversion logic of its own — every
// successful resolution goes through the single authoritative `convertIntakeDraft`
// primitive (src/lib/intakeConversion.ts), the SAME one used by manual intake
// (actions/intake.ts) and the bulk workbench (actions/intakeWorkbench.ts). This file
// only re-validates the draft's current (possibly admin-corrected) fields using the
// SAME classification chain confirmWorkbenchItem uses, then hands off.

import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { convertIntakeDraft } from '@/lib/intakeConversion'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import { existingExceptionStillOverage } from '@/lib/intakeWorkbench'
import { openIntakeExceptionWhere } from '@/lib/intakeExceptions'

type TxClient = Prisma.TransactionClient

export type ResolveIntakeExceptionInput = {
  draftId: string
  // Section 10: one exception may reveal more than one unresolved issue — only the
  // fields the admin actually supplies are changed; omitted (undefined) fields keep
  // whatever is already on the draft. Passing null explicitly clears a field.
  catalogModelId?: string | null
  storageLocationId?: string | null
  condition?: string | null
  cardedOrLoose?: string | null
}

export type ResolveIntakeExceptionResult =
  | { ok: true; alreadyResolved: boolean; itemId: string; sku: string }
  | { ok: false; stillOpen: true; code: string; note: string }
  | { ok: false; stillOpen: false; error: string }

async function reclassify(
  tx: TxClient,
  draft: { id: string; sellerInboundShipmentId: string | null; brand: string | null; name: string | null },
  catalogModelId: string | null,
  storageLocationId: string | null,
  condition: string | null,
  cardedOrLoose: string | null,
): Promise<{ code: string; note: string } | null> {
  // Same order as confirmWorkbenchItem's classification (section 16/17): catalog ->
  // storage -> condition -> overage. A retry that fixes one issue but exposes a
  // DIFFERENT one is reported as that new issue, never silently converted anyway.
  let catalog: { id: string } | null = null
  if (catalogModelId) catalog = await tx.catalogModel.findUnique({ where: { id: catalogModelId }, select: { id: true } })
  if (!catalog && !(draft.brand && draft.name)) {
    return { code: 'unknown_model', note: 'No catalog model was resolved for this item.' }
  }

  let location: { id: string } | null = null
  if (storageLocationId) location = await tx.storageLocation.findUnique({ where: { id: storageLocationId }, select: { id: true } })
  if (!location) {
    return { code: 'invalid_storage', note: 'Storage location is missing or no longer exists.' }
  }

  if (!condition || !cardedOrLoose) {
    return { code: 'missing_condition', note: 'Condition and carded/loose are required.' }
  }

  if (draft.sellerInboundShipmentId) {
    // 15E-review section 3/5: caller must already hold `SellerInboundShipment FOR
    // UPDATE` before invoking reclassify — this read (and the counts below) are only
    // race-free because of that lock, which serializes against confirmWorkbenchItem's
    // concurrent NEW-unit overage check on the same shipment.
    const shipment = await tx.sellerInboundShipment.findUnique({
      where: { id: draft.sellerInboundShipmentId },
      select: { receivedQuantity: true },
    })
    if (shipment?.receivedQuantity != null) {
      const [processedCount, exceptionCount] = await Promise.all([
        tx.itemInstance.count({ where: { sellerInboundShipmentId: draft.sellerInboundShipmentId } }),
        tx.intakeDraft.count({ where: { sellerInboundShipmentId: draft.sellerInboundShipmentId, ...openIntakeExceptionWhere() } }),
      ])
      // This draft is the EXISTING exception unit being resolved, not a new physical
      // observation — it is already counted once inside exceptionCount, and resolving
      // it only moves it from the exception bucket to the processed bucket. Using
      // existingExceptionStillOverage (rather than wouldExceedReceived, which is for
      // genuinely NEW units) makes that distinction explicit rather than relying on
      // opaque "-1 then +1" cancellation arithmetic.
      if (existingExceptionStillOverage(shipment.receivedQuantity, processedCount, exceptionCount)) {
        return {
          code: 'unexpected_overage',
          note: `Processing this would exceed the ${shipment.receivedQuantity} physical unit(s) recorded as received.`,
        }
      }
    }
  }

  return null
}

type TxOutcome = {
  result: ResolveIntakeExceptionResult
  sellerSubmissionId: string | null
  // 15E-review section 2: carried through purely for post-transaction audit
  // enrichment — never used to decide anything, and never itself written back to the
  // draft (that would violate the immutability of initialException* on this file).
  initialCode: string | null
  initialNote: string | null
  priorCode: string | null
}

export async function resolveIntakeException(input: ResolveIntakeExceptionInput): Promise<ResolveIntakeExceptionResult> {
  if (!(await isAdminAuthenticated())) return { ok: false, stillOpen: false, error: 'Admin authentication required.' }
  if (!input.draftId) return { ok: false, stillOpen: false, error: 'Draft is required.' }

  // 15E-review section 3: non-authoritative "lock-order hint" (same pattern as
  // sellerAgreements.ts) — sellerInboundShipmentId is set once at draft creation and
  // never changed afterward, so this pre-transaction read is safe to use only to
  // decide which row to lock FIRST; every value actually acted upon below is re-read
  // under the lock.
  const lockOrderHint = await prisma.intakeDraft.findUnique({
    where: { id: input.draftId },
    select: { sellerInboundShipmentId: true },
  })

  let txError: string | null = null
  let outcome: TxOutcome

  try {
    outcome = await prisma.$transaction(async (tx): Promise<TxOutcome> => {
      // 15E-review section 3/4: lock order must match confirmWorkbenchItem's
      // (SellerInboundShipment -> IntakeDraft) so the two workflows serialize instead
      // of deadlocking when they touch the same shipment. This is NOT the 15D
      // workbench lease — intentionally, an active 15D lease must never block 15E from
      // resolving an old exception. No lease-ownership guard is called here; this is
      // purely the DB row lock, which is sufficient for correctness and independent of
      // lease ownership. Different shipments never contend with each other.
      if (lockOrderHint?.sellerInboundShipmentId) {
        await tx.$queryRaw`SELECT id FROM "SellerInboundShipment" WHERE id = ${lockOrderHint.sellerInboundShipmentId} FOR UPDATE`
      }
      await tx.$queryRaw`SELECT id FROM "IntakeDraft" WHERE id = ${input.draftId} FOR UPDATE`

      const draft = await tx.intakeDraft.findUnique({
        where: { id: input.draftId },
        select: {
          id: true, status: true, convertedItemId: true, workbenchExceptionCode: true, workbenchExceptionNote: true,
          initialExceptionCode: true, initialExceptionNote: true,
          catalogModelId: true, storageLocationId: true, condition: true, cardedOrLoose: true,
          sellerInboundShipmentId: true, sellerSubmissionId: true, brand: true, name: true,
        },
      })
      if (!draft) { txError = 'Draft not found.'; throw new Error('TX_VALIDATION') }
      const sellerSubmissionId = draft.sellerSubmissionId
      const initialCode = draft.initialExceptionCode
      const initialNote = draft.initialExceptionNote
      const priorCode = draft.workbenchExceptionCode

      // Idempotent replay: already converted (by this call, a concurrent resolver, or
      // a browser retry). Never a second ItemInstance.
      if (draft.convertedItemId) {
        const item = await tx.itemInstance.findUnique({ where: { id: draft.convertedItemId }, select: { id: true, sku: true } })
        if (item) return { sellerSubmissionId, initialCode, initialNote, priorCode, result: { ok: true, alreadyResolved: true, itemId: item.id, sku: item.sku } }
      }
      if (draft.workbenchExceptionCode === null) {
        txError = 'This draft is not an open exception.'
        throw new Error('TX_VALIDATION')
      }
      if (draft.status === 'rejected') {
        txError = 'This draft has been rejected and is no longer part of the exception queue.'
        throw new Error('TX_VALIDATION')
      }

      const catalogModelId = input.catalogModelId !== undefined ? input.catalogModelId : draft.catalogModelId
      const storageLocationId = input.storageLocationId !== undefined ? input.storageLocationId : draft.storageLocationId
      const condition = input.condition !== undefined ? input.condition : draft.condition
      const cardedOrLoose = input.cardedOrLoose !== undefined ? input.cardedOrLoose : draft.cardedOrLoose

      const block = await reclassify(tx, draft, catalogModelId, storageLocationId, condition, cardedOrLoose)

      if (block) {
        await tx.intakeDraft.update({
          where: { id: draft.id },
          data: {
            catalogModelId: catalogModelId ?? undefined,
            storageLocationId: storageLocationId ?? undefined,
            condition, cardedOrLoose,
            workbenchExceptionCode: block.code,
            workbenchExceptionNote: block.note,
          },
        })
        return { sellerSubmissionId, initialCode, initialNote, priorCode, result: { ok: false, stillOpen: true, code: block.code, note: block.note } }
      }

      await tx.intakeDraft.update({
        where: { id: draft.id },
        data: {
          catalogModelId: catalogModelId ?? undefined,
          storageLocationId: storageLocationId ?? undefined,
          condition, cardedOrLoose,
          status: 'reviewed',
        },
      })

      const conversion = await convertIntakeDraft(tx, { draftId: draft.id, locationId: storageLocationId!, catalogModelId })

      if (!conversion.ok) {
        // Never leave the draft stuck in 'reviewed' limbo — route back to an open
        // exception rather than losing the physical item or the original evidence.
        await tx.intakeDraft.update({
          where: { id: draft.id },
          data: { status: 'draft', workbenchExceptionCode: 'conversion_failed', workbenchExceptionNote: conversion.message },
        })
        return { sellerSubmissionId, initialCode, initialNote, priorCode, result: { ok: false, stillOpen: true, code: 'conversion_failed', note: conversion.message } }
      }

      // 15E-review section 3: workbenchExceptionCode/Note are intentionally NOT
      // cleared on success — they remain permanent evidence of what was originally
      // wrong with this now-converted item, alongside convertedItemId. The open-
      // exception predicate (openIntakeExceptionWhere) already excludes this row via
      // convertedItemId being set, so it correctly disappears from the live queue.
      return { sellerSubmissionId, initialCode, initialNote, priorCode, result: { ok: true, alreadyResolved: false, itemId: conversion.itemId, sku: conversion.sku } }
    }, { timeout: 20_000 })
  } catch (e) {
    if (txError) return { ok: false, stillOpen: false, error: txError }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: false, stillOpen: false, error: 'This action conflicted with a concurrent request. Please retry.' }
    }
    throw e
  }

  const { result, sellerSubmissionId, initialCode, initialNote, priorCode } = outcome

  // Audit (section 2/3/31): one event per distinct outcome for this draft — idempotent
  // for a repeated identical outcome (double-click/retry), a fresh event for a
  // genuinely different one (e.g. a later, different blocking issue, or eventual
  // success). Actor is the codebase's sole authenticated-actor convention (see
  // actions/intakeWorkbench.ts RECONCILED_BY_ACTOR) — no per-admin identity exists.
  //
  // 15E-review section 2: this makes the original cause permanently recoverable even
  // though workbenchExceptionCode itself may have moved on — original failure
  // (initialCode/initialNote, never overwritten), the final blocking failure when it
  // differs from the original (evolution, e.g. unknown_model -> missing_condition),
  // and — on success — the resulting ItemInstance.
  if (sellerSubmissionId) {
    const outcomeSignature = result.ok ? `converted:${result.itemId}` : result.stillOpen ? `stillopen:${result.code}` : null
    if (outcomeSignature) {
      const finalCode = result.ok ? null : result.stillOpen ? result.code : null
      const evolved = finalCode !== null && initialCode !== null && finalCode !== initialCode
      const evolutionNote = evolved ? ` Original issue was "${initialCode}"; current blocking issue is "${finalCode}".` : ''
      try {
        await ensureSellerLifecycleEvent({
          eventKey: `intake-exception-resolved:${input.draftId}:${outcomeSignature}`,
          sellerSubmissionId,
          eventType: 'intake_exception_resolved',
          sourceEntityType: 'intake_draft',
          sourceEntityId: input.draftId,
          sellerVisible: false,
          adminDescription: result.ok
            ? `Intake exception resolved${result.alreadyResolved ? ' (idempotent replay)' : ''}: created item ${result.itemId} (SKU ${result.sku}). Original issue was "${initialCode ?? priorCode}".`
            : `Intake exception resolution attempt: still open (${(result as { code: string }).code}).${evolutionNote}`,
          metadata: {
            actor: 'admin',
            outcome: outcomeSignature,
            initialExceptionCode: initialCode,
            initialExceptionNote: initialNote,
            priorExceptionCode: priorCode,
            finalExceptionCode: finalCode,
          },
          occurredAt: new Date(),
        })
      } catch (err) {
        console.error('[resolveIntakeException] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
      }
    }
  }

  revalidatePath('/admin/intake/exceptions')
  revalidatePath(`/admin/intake/exceptions/${input.draftId}`)
  revalidatePath('/admin/items')
  if (sellerSubmissionId) revalidatePath(`/admin/seller-submissions/${sellerSubmissionId}`)

  return result
}

// ── Bulk resolution (section 20/21/22) ──────────────────────────────────────────────

const MAX_BULK_BATCH = 50

export type BulkResolveIntakeExceptionsInput = {
  draftIds: string[]
  catalogModelId?: string | null
  storageLocationId?: string | null
  condition?: string | null
  cardedOrLoose?: string | null
}

export type BulkResolveRowResult =
  | { draftId: string; outcome: 'converted' | 'already_resolved'; itemId: string; sku: string }
  | { draftId: string; outcome: 'still_open'; code: string; note: string }
  | { draftId: string; outcome: 'error'; message: string }

export type BulkResolveIntakeExceptionsResult =
  | { ok: true; results: BulkResolveRowResult[]; convertedCount: number; stillOpenCount: number }
  | { ok: false; error: string }

// Bounded, per-draft-atomic, partial-success-aware (section 21): one bad row never
// rolls back unrelated ones — each draft is its own independent call/transaction via
// resolveIntakeException, so a failure on draft #7 has zero effect on #1-6 or #8-50.
export async function bulkResolveIntakeExceptions(input: BulkResolveIntakeExceptionsInput): Promise<BulkResolveIntakeExceptionsResult> {
  if (!(await isAdminAuthenticated())) return { ok: false, error: 'Admin authentication required.' }
  const ids = [...new Set(input.draftIds)].slice(0, MAX_BULK_BATCH)
  if (ids.length === 0) return { ok: false, error: 'No drafts selected.' }

  const results: BulkResolveRowResult[] = []
  for (const draftId of ids) {
    const r = await resolveIntakeException({
      draftId,
      catalogModelId: input.catalogModelId,
      storageLocationId: input.storageLocationId,
      condition: input.condition,
      cardedOrLoose: input.cardedOrLoose,
    })
    if (r.ok) results.push({ draftId, outcome: r.alreadyResolved ? 'already_resolved' : 'converted', itemId: r.itemId, sku: r.sku })
    else if (r.stillOpen) results.push({ draftId, outcome: 'still_open', code: r.code, note: r.note })
    else results.push({ draftId, outcome: 'error', message: r.error })
  }

  const convertedCount = results.filter((r) => r.outcome === 'converted' || r.outcome === 'already_resolved').length
  return { ok: true, results, convertedCount, stillOpenCount: results.length - convertedCount }
}
