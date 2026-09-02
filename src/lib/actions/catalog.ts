'use server'

import { z } from 'zod'

import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { redirect } from 'next/navigation'
import { searchCatalogModels } from '@/lib/catalogSearch'
import { DUPLICATE_SCORE_THRESHOLD } from '@/lib/catalogMatching'
import { computeImpactCounts, type MergeImpactSummary } from '@/lib/catalogDataQualityQuery'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'
import type { CatalogModelMergeContext } from '@/lib/riskPolicy'

// 18A: WantedCatalogModel.catalogModel uses onDelete: Cascade — without this
// reconciliation, a customer's Want on the duplicate model would be silently
// destroyed the moment the duplicate CatalogModel row is deleted at the end of the
// merge transaction below. No other table references WantedCatalogModel.id (verified
// against the full schema), so rows can be freely reassigned/collapsed here without
// orphaning any history.
//
// Row-survivor rule (overlap only — customer already wants both models): the row
// with the EARLIER createdAt physically survives — that timestamp is the honest
// answer to "since when has this customer wanted this product," regardless of which
// duplicate DB row happened to record it first; we never rewrite createdAt on any
// row. Field values (maxDesiredPrice/notes/availabilityAlertEnabled/priceAlertEnabled)
// are taken from whichever row was more recently updated — the customer's freshest
// expressed preference — never a blind OR of two rows (a boolean OR could silently
// override an explicit customer opt-out with a stale default; an OR has no coherent
// meaning at all for a price cap). These are independent axes: which row survives
// (history) vs. which values it carries (current preference).
async function reconcileWantedCatalogModelMerge(
  tx: Prisma.TransactionClient,
  dupeId: string,
  canonicalId: string,
): Promise<{ migrated: number; reconciledOverlap: number }> {
  const [dupeWants, canonicalWants] = await Promise.all([
    tx.wantedCatalogModel.findMany({ where: { catalogModelId: dupeId } }),
    tx.wantedCatalogModel.findMany({ where: { catalogModelId: canonicalId } }),
  ])
  const canonicalByProfile = new Map(canonicalWants.map(w => [w.customerProfileId, w]))

  const overlappingProfileIds: string[] = []
  let reconciledOverlap = 0
  for (const dupeWant of dupeWants) {
    const canonicalWant = canonicalByProfile.get(dupeWant.customerProfileId)
    if (!canonicalWant) continue // no conflict — handled by the bulk updateMany below
    overlappingProfileIds.push(dupeWant.customerProfileId)

    const survivor = dupeWant.createdAt <= canonicalWant.createdAt ? dupeWant : canonicalWant
    const loser = survivor.id === dupeWant.id ? canonicalWant : dupeWant
    const freshest = dupeWant.updatedAt >= canonicalWant.updatedAt ? dupeWant : canonicalWant

    await tx.wantedCatalogModel.update({
      where: { id: survivor.id },
      data: {
        catalogModelId: canonicalId,
        maxDesiredPrice: freshest.maxDesiredPrice,
        notes: freshest.notes,
        availabilityAlertEnabled: freshest.availabilityAlertEnabled,
        priceAlertEnabled: freshest.priceAlertEnabled,
      },
    })
    await tx.wantedCatalogModel.delete({ where: { id: loser.id } })
    reconciledOverlap++
  }

  // Non-conflicting duplicate-only Wants: retarget in place (never delete+recreate),
  // preserving row identity, createdAt/updatedAt, and every preference field exactly.
  const migrated = await tx.wantedCatalogModel.updateMany({
    where: { catalogModelId: dupeId, customerProfileId: { notIn: overlappingProfileIds } },
    data: { catalogModelId: canonicalId },
  })

  return { migrated: migrated.count, reconciledOverlap }
}

// 18C: ExternalMarketObservation.catalogModelId is a live, admin-correctable
// normalized match pointer (proven by matchObservationToCatalog/unmatchObservation,
// which exist specifically to change it after creation) — a CatalogModel merge is
// semantically the same kind of correction, so it must go through the SAME audit
// convention those actions already established: every catalogModelId change gets an
// ExternalMarketObservationAudit row (observationId, action, beforeSnapshot,
// afterSnapshot). No schema change needed — `action` is a free-form string (not an
// enum) and `adminInfo` is optional and left null by every existing action too, so
// nothing here is fabricated. Only catalogModelId is touched — matchStatus/
// matchMethod/rejectionReason/all source fields are untouched, so the snapshot
// records only what actually changed, matching restoreObservation's own minimal-
// snapshot convention. No uniqueness collision possible: [provider, externalId] and
// fingerprint both exclude catalogModelId.
//
// 18C final reconciliation: the CatalogModel FOR UPDATE lock (held on dupeId since
// the top of the merge transaction) does NOT protect these rows. Postgres only
// requires a lock on the FK target being newly referenced, never on the one being
// vacated — so matchObservationToCatalog/unmatchObservation/rejectObservation can
// move an observation's catalogModelId away from dupeId (to null or a different
// model) without ever touching dupeId's row lock. Without an explicit lock here, a
// concurrent unmatch/rematch could commit between our read and our update, leaving
// a phantom 'merged' audit row for a transition the merge never actually performed.
// Fix: SELECT ... FOR UPDATE the affected observation rows FIRST — any concurrent
// match/unmatch/reject/restore touching one of them then blocks on ITS OWN write
// until this transaction commits or rolls back, so nothing can change out from
// under the locked set between this read and the update below. The locked id set
// is the single source of truth for both the audit rows and the update's affected
// count; a mismatch (defensively checked, not expected to ever fire under this
// locking) aborts the whole merge rather than leave an untrustworthy audit trail.
async function reconcileExternalMarketObservationMerge(
  tx: Prisma.TransactionClient,
  dupeId: string,
  canonicalId: string,
): Promise<{ migrated: number }> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ExternalMarketObservation" WHERE "catalogModelId" = ${dupeId} FOR UPDATE
  `
  if (locked.length === 0) return { migrated: 0 }
  const lockedIds = locked.map(r => r.id)

  await tx.externalMarketObservationAudit.createMany({
    data: lockedIds.map(id => ({
      observationId: id,
      action: 'merged',
      beforeSnapshot: { catalogModelId: dupeId },
      afterSnapshot: { catalogModelId: canonicalId },
    })),
  })

  const migrated = await tx.externalMarketObservation.updateMany({
    where: { id: { in: lockedIds }, catalogModelId: dupeId },
    data: { catalogModelId: canonicalId },
  })

  // Defensive invariant, not expected to trip: the locked set is held continuously
  // from the SELECT above through this update, so nothing else could have moved
  // these rows away from dupeId in between. If it ever does mismatch, the audit
  // rows just written would describe a transition that didn't fully happen — abort
  // rather than leave that untrustworthy.
  if (migrated.count !== lockedIds.length) {
    throw new Error('OBSERVATION_RECONCILE_MISMATCH')
  }

  return { migrated: migrated.count }
}

// 15F-review (catalog-merge pass): approvalRequestId is set only when a risk gate
// routed this action to the approval queue instead of performing the mutation.
export type MergeActionState = { errors: Record<string, string[]>; approvalRequestId?: string } | null

function toMergeRiskContext(sourceCatalogModelId: string, canonicalCatalogModelId: string, impact: MergeImpactSummary): CatalogModelMergeContext {
  return {
    sourceCatalogModelId,
    canonicalCatalogModelId,
    affectedItemCount: impact.itemInstances,
    soldItemCount: impact.soldItems,
    activeListingCount: impact.activeListings,
    affectedCollectionCount: impact.collectionItems,
    affectedWantedCount: impact.wantedBy,
    affectedSellerSubmissionCount: impact.sellerSubmissions,
    affectedPhotoCount: impact.photos,
    affectedFingerprintCount: impact.fingerprints,
    affectedExternalObservationCount: impact.externalObs,
  }
}

const CatalogSchema = z.object({
  brand: z.string().min(1, 'Brand is required'),
  name: z.string().min(1, 'Name is required'),
  series: z.string().optional(),
  year: z.string().optional(),
  color: z.string().optional(),
  scale: z.string().optional(),
  notes: z.string().optional(),
})

export type CatalogActionState = { errors: Record<string, string[]> } | null

function toDbData(d: z.infer<typeof CatalogSchema>) {
  return {
    brand: d.brand,
    name: d.name,
    series: d.series || undefined,
    year: d.year ? parseInt(d.year) : undefined,
    color: d.color || undefined,
    scale: d.scale || undefined,
    notes: d.notes || undefined,
  }
}

export async function createCatalogModel(
  _prev: CatalogActionState,
  formData: FormData
): Promise<CatalogActionState> {
  const result = CatalogSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const createAnyway = formData.get('createAnyway') === 'true'

  if (!createAnyway) {
    const q = [result.data.brand, result.data.name].filter(Boolean).join(' ')
    const dupes = await searchCatalogModels(q)
    const top = dupes[0]
    if (top && top.score >= DUPLICATE_SCORE_THRESHOLD) {
      return {
        errors: {
          _duplicate: [
            `Potential duplicate: ${top.brand} ${top.name} (score ${top.score}/100). ` +
            `Check the catalog before saving. Check "Create anyway" only if this is a genuinely distinct model.`,
          ],
        },
      }
    }
  }

  await prisma.catalogModel.create({ data: toDbData(result.data) })
  redirect('/admin/catalog')
}

export async function updateCatalogModel(
  id: string,
  _prev: CatalogActionState,
  formData: FormData
): Promise<CatalogActionState> {
  const result = CatalogSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  await prisma.catalogModel.update({ where: { id }, data: toDbData(result.data) })
  redirect('/admin/catalog')
}

export async function mergeCatalogModels(
  _prev: MergeActionState,
  formData: FormData
): Promise<MergeActionState> {
  const canonicalId   = (formData.get('canonicalId') as string)?.trim() || ''
  const duplicateIds  = formData.getAll('duplicateId')
    .map((v) => (v as string).trim())
    .filter(Boolean)

  if (!canonicalId)         return { errors: { form: ['No canonical model selected.'] } }
  if (duplicateIds.length === 0) return { errors: { form: ['No duplicate models selected.'] } }
  if (duplicateIds.includes(canonicalId))
    return { errors: { form: ['The canonical model cannot also be in the merge list.'] } }

  // Parse explicit merge-direction snapshot: { canonicalModelId, sourceModelId, sourceImpact }.
  // Verified inside TX — direction mismatch or stale counts both abort the merge.
  type ExpectedPayload = { canonicalModelId: string; sourceModelId: string; sourceImpact: MergeImpactSummary }
  let expectedPayload: ExpectedPayload | null = null
  const expectedRaw = (formData.get('expectedImpactSnapshot') as string | null) ?? null
  if (expectedRaw) {
    try { expectedPayload = JSON.parse(expectedRaw) } catch { /* malformed JSON — skip stale check */ }
  }

  // Optimistic pre-flight existence check — re-verified inside TX after acquiring locks.
  const allIds = [canonicalId, ...duplicateIds]
  const existCount = await prisma.catalogModel.count({ where: { id: { in: allIds } } })
  if (existCount !== allIds.length)
    return { errors: { form: ['One or more selected models no longer exist. Please refresh and try again.'] } }

  // 15F-review (catalog-merge pass) section 7: "on initial request" steps 1-6 —
  // server computes fresh impact per duplicate (never trusting the client-supplied
  // expectedImpactSnapshot, which is only used later for the existing staleness
  // check), builds the risk context, and evaluates policy BEFORE any mutation. One
  // administrative action per duplicate model (never per ItemInstance). If ANY
  // duplicate in this batch requires approval or is denied, the WHOLE batch is
  // aborted — never a partial merge of only the low-risk pairs.
  const gateByDupeId = new Map<string, Awaited<ReturnType<typeof checkRiskGate>>>()
  for (const dupeId of duplicateIds) {
    const impact = await computeImpactCounts(dupeId)
    const riskContext = toMergeRiskContext(dupeId, canonicalId, impact)
    const gate = await checkRiskGate({ action: 'catalog_model_merge', context: riskContext, targetType: 'CatalogModelMerge', targetId: dupeId, requestedBy: 'admin' })
    if (gate.decision === 'deny') return { errors: { form: [gate.reasons.join(' ')] } }
    if (gate.decision === 'pending') {
      return { errors: { form: ['This merge requires approval before it can be applied.'] }, approvalRequestId: gate.approvalRequestId }
    }
    gateByDupeId.set(dupeId, gate)
  }

  let mergeError: MergeActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      // Acquire row locks on both canonical and each duplicate in deterministic ID order
      // so concurrent merges targeting the same models always lock in the same order.
      const lockIds = [...new Set([canonicalId, ...duplicateIds])].sort()
      for (const id of lockIds) {
        await tx.$queryRaw`SELECT id FROM "CatalogModel" WHERE id = ${id} FOR UPDATE`
      }

      // Capture snapshots INSIDE the transaction after acquiring locks.
      // This guarantees the snapshot reflects the true committed state at merge time.
      const [canonicalSnapshot, ...dupeSnapshotsOrNull] = await Promise.all([
        tx.catalogModel.findUnique({ where: { id: canonicalId } }),
        ...duplicateIds.map((id) => tx.catalogModel.findUnique({ where: { id } })),
      ])

      if (!canonicalSnapshot) {
        mergeError = { errors: { form: ['Canonical model was deleted. Please refresh and try again.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (dupeSnapshotsOrNull.some((s) => s === null)) {
        mergeError = { errors: { form: ['One or more duplicate models were deleted. Please refresh and try again.'] } }
        throw new Error('TX_VALIDATION')
      }

      for (let i = 0; i < duplicateIds.length; i++) {
        const dupeId = duplicateIds[i]
        const dupSnap = dupeSnapshotsOrNull[i]!

        // 15F-review section 7: "after approval, when merge is explicitly retried"
        // steps 2-6 — impact is recomputed HERE, fresh, inside the lock (the same
        // read the pre-existing stale-preview check already needs), and the risk
        // context is reconstructed from THAT fresh read, never the pre-transaction
        // snapshot. If this duplicate's gate required approval, the freshly-rebuilt
        // fingerprint must still match what was actually approved — a changed
        // affectedItemCount/soldItemCount (or any other bound field) invalidates it,
        // exactly like every other 15F-gated action.
        const current = await computeImpactCounts(dupeId, tx)

        // Stale-preview + direction check after acquiring locks (pre-existing
        // control, unmodified — this is the UI's own staleness UX, independent of
        // and in addition to the risk gate; approval never substitutes for it).
        if (expectedPayload) {
          if (expectedPayload.canonicalModelId !== canonicalId || expectedPayload.sourceModelId !== dupeId) {
            mergeError = { errors: { form: ['Merge direction was changed since the preview. Refresh and confirm again.'] } }
            throw new Error('TX_VALIDATION')
          }
          const exp = expectedPayload.sourceImpact
          if (
            exp.itemInstances    !== current.itemInstances    || exp.collectionItems  !== current.collectionItems  ||
            exp.wantedBy         !== current.wantedBy         || exp.sellerSubmissions !== current.sellerSubmissions ||
            exp.photos           !== current.photos           || exp.fingerprints      !== current.fingerprints      ||
            exp.activeListings   !== current.activeListings   || exp.soldItems         !== current.soldItems         ||
            exp.externalObs      !== current.externalObs
          ) {
            mergeError = { errors: { form: ['Impact changed since the preview was shown. Refresh and review before merging.'] } }
            throw new Error('TX_VALIDATION')
          }
        }

        const gate = gateByDupeId.get(dupeId)
        if (gate?.decision === 'consume_approved') {
          const freshContext = toMergeRiskContext(dupeId, canonicalId, current)
          const consumed = await consumeApprovedRiskGate(tx, { approvalRequestId: gate.approvalRequestId, action: 'catalog_model_merge', targetId: dupeId, context: freshContext })
          if (!consumed.ok) { mergeError = { errors: { form: [consumed.error] } }; throw new Error('TX_VALIDATION') }
        }

        // 18B: hard integrity precondition, not an overrideable risk gate. A
        // pending/processing BuyerAlertFanout job pages WantedCatalogModel via a
        // keyset cursor scoped to the PRE-merge population (see
        // buyerAlertsFanoutProcessor.ts). If duplicate Wants are migrated to
        // canonical while such a job is live, its cursor's semantics become invalid
        // for the new combined population and recipients could be silently skipped —
        // no safe cursor-repair/restart/reset exists, so the merge blocks instead.
        // Deliberately does NOT distinguish a live lease from a stale one (no
        // FANOUT_LEASE_MS import, no staleness check) — every nonterminal status
        // blocks, conservatively; a stale job is already reclaimable by the existing
        // processor on its own schedule, unrelated to this merge.
        const nonterminalFanoutCount = await tx.buyerAlertFanout.count({
          where: { catalogModelId: dupeId, status: { in: ['pending', 'processing'] } },
        })
        if (nonterminalFanoutCount > 0) {
          mergeError = {
            errors: { form: ['An alert fanout is pending or processing for this model. Retry the merge after alert processing completes.'] },
          }
          throw new Error('TX_VALIDATION')
        }

        // 18B final reconciliation: a SEPARATE hard precondition from the fanout one
        // above — this closes a delivery-concurrency race, not a fanout-cursor one.
        // buyerAlertsDelivery.ts's deliverOne() is not itself transactional: it reads
        // the event row (capturing catalogModelId into a plain JS variable) via one
        // standalone `prisma.buyerAlertEvent.findUnique`, then LATER — as a separate,
        // unrelated query — re-checks WantedCatalogModel using that already-captured,
        // now-possibly-stale catalogModelId value. If this merge's WantedCatalogModel
        // migration commits in between those two reads, the worker's stale value finds
        // no matching Wanted row (it was moved to canonicalId) and falsely suppresses
        // a legitimate alert as 'wanted_removed' — even though the customer's want was
        // only migrated, never removed. Blocking while any BuyerAlertEvent for this
        // model is 'pending' or 'sending' closes that window entirely: 'sending' rows
        // are actively/recently claimed for exactly this delivery sequence, and a
        // stale 'sending' lease is already safely reclaimable by the existing
        // DELIVERY_LEASE_MS mechanism in buyerAlertsDelivery.ts — no repair needed
        // here. 'sent'/'failed'/'suppressed'/'delivery_unknown' are all terminal:
        // processPendingBuyerAlerts's own candidate query never selects them again, so
        // they carry no delivery-concurrency risk and are retargeted normally below.
        const nonterminalEventCount = await tx.buyerAlertEvent.count({
          where: { catalogModelId: dupeId, status: { in: ['pending', 'sending'] } },
        })
        if (nonterminalEventCount > 0) {
          mergeError = {
            errors: { form: ['An alert is pending delivery for this model. Retry the merge after delivery completes.'] },
          }
          throw new Error('TX_VALIDATION')
        }

        const [items, collItems, suggestions, submissions, photos, wanted] = await Promise.all([
          tx.itemInstance.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
          tx.collectionItem.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
          tx.catalogSuggestion.updateMany({ where: { approvedCatalogId: dupeId }, data: { approvedCatalogId: canonicalId } }),
          tx.sellerSubmission.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
          tx.catalogModelPhoto.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
          reconcileWantedCatalogModelMerge(tx, dupeId, canonicalId),
          // 18B: navigational/current-identity retarget only — no historical payload
          // field changes. All BuyerAlertEvent statuses survive (not filtered); only
          // 'complete'/'failed' BuyerAlertFanout rows are retargeted here — 'pending'/
          // 'processing' cannot exist at this point (blocked above), so this filter is
          // a defensive belt-and-suspenders against a row that raced into a nonterminal
          // status between the check above and here (caught by the integrity check below
          // regardless). Fingerprint retarget mirrors the existing photo migration —
          // uniqueness is [catalogPhotoId, algorithmVersion], catalogModelId excluded,
          // so no conflict handling is needed.
          tx.buyerAlertEvent.updateMany({ where: { catalogModelId: dupeId }, data: { catalogModelId: canonicalId } }),
          tx.buyerAlertFanout.updateMany({ where: { catalogModelId: dupeId, status: { in: ['complete', 'failed'] } }, data: { catalogModelId: canonicalId } }),
          tx.catalogPhotoFingerprint.updateMany({ where: { catalogModelId: dupeId }, data: { catalogModelId: canonicalId } }),
          // 18C: normalized-identity retarget only. ExternalMarketObservation goes
          // through reconcileExternalMarketObservationMerge (audit-preserving, see
          // above); IntakeDraft is a plain updateMany — the existing onDelete:SetNull
          // is no longer relied upon during merge, since the correct canonical
          // identity is already known (SetNull would only degrade the draft to its
          // slower fuzzy-matching fallback for no reason). MobileCaptureItem is
          // intentionally NOT included — @@unique([sessionId, catalogModelId]) needs
          // overlap reconciliation like Wanted's, deferred to its own milestone.
          reconcileExternalMarketObservationMerge(tx, dupeId, canonicalId),
          tx.intakeDraft.updateMany({ where: { catalogModelId: dupeId }, data: { catalogModelId: canonicalId } }),
        ])

        // No CatalogModelMergeAudit column exists for Wanted counts (no schema change
        // in 18A) — recorded in adminNote instead, the field this table already
        // provides for free-text merge context.
        const wantedNote = wanted.migrated > 0 || wanted.reconciledOverlap > 0
          ? `Wanted: ${wanted.migrated} migrated, ${wanted.reconciledOverlap} reconciled (customer wanted both models)`
          : null

        await tx.catalogModelMergeAudit.create({
          data: {
            canonicalCatalogModelId: canonicalId,
            duplicateCatalogModelId: dupeId,
            canonicalSnapshot: canonicalSnapshot as object,
            duplicateSnapshot: dupSnap as object,
            movedItemInstances:      items.count,
            movedCollectionItems:    collItems.count,
            movedCatalogSuggestions: suggestions.count,
            movedSellerSubmissions:  submissions.count,
            movedPhotos:             photos.count,
            adminNote:               wantedNote,
          },
        })

        // Pre-delete integrity check: all FK references to dupeId must have been moved.
        // The FOR UPDATE lock on this CatalogModel row blocks concurrent FK inserts/updates
        // (Postgres acquires FOR KEY SHARE on the referenced row for any FK write, which
        // conflicts with FOR UPDATE). So remaining should always be 0. If non-zero, roll back.
        // Includes wantedCatalogModel — 18A: never rely on onDelete:Cascade to decide
        // customer intent; verify zero Wants still point at the duplicate before it's deleted.
        // 18B: also buyerAlertEvent/buyerAlertFanout/catalogPhotoFingerprint — the
        // fanout count here is intentionally UNFILTERED by status (unlike the retarget
        // above), so a row that raced into pending/processing after the precondition
        // check is still caught here and aborts the whole merge rather than being
        // silently cascade-deleted.
        // 18C: also externalMarketObservation/intakeDraft — neither should silently
        // FK-block (observation) or SetNull (draft) once explicitly reconciled above;
        // a nonzero count here means the reconciliation itself is incomplete, and the
        // whole merge must abort rather than let IntakeDraft's SetNull quietly fire.
        const [ri, rc, rs, rsub, rp, rw, rae, raf, rfp, reo, rid] = await Promise.all([
          tx.itemInstance.count({ where: { catalogId: dupeId } }),
          tx.collectionItem.count({ where: { catalogId: dupeId } }),
          tx.catalogSuggestion.count({ where: { approvedCatalogId: dupeId } }),
          tx.sellerSubmission.count({ where: { catalogId: dupeId } }),
          tx.catalogModelPhoto.count({ where: { catalogId: dupeId } }),
          tx.wantedCatalogModel.count({ where: { catalogModelId: dupeId } }),
          tx.buyerAlertEvent.count({ where: { catalogModelId: dupeId } }),
          tx.buyerAlertFanout.count({ where: { catalogModelId: dupeId } }),
          tx.catalogPhotoFingerprint.count({ where: { catalogModelId: dupeId } }),
          tx.externalMarketObservation.count({ where: { catalogModelId: dupeId } }),
          tx.intakeDraft.count({ where: { catalogModelId: dupeId } }),
        ])
        const remaining = ri + rc + rs + rsub + rp + rw + rae + raf + rfp + reo + rid
        if (remaining > 0) {
          mergeError = {
            errors: {
              form: [
                `Merge aborted: ${remaining} reference(s) still point to the duplicate after reassignment. Please retry.`,
              ],
            },
          }
          throw new Error('TX_VALIDATION')
        }

        await tx.catalogModel.delete({ where: { id: dupeId } })

        // Consumed only after the merge for this duplicate has fully succeeded
        // (moves + integrity check + delete), atomically with it, in the same
        // transaction — approval itself never performs the merge; this call only
        // ever flips a status flag once the mutation it authorized has committed.
        if (gate?.decision === 'consume_approved') await markApprovalConsumed(tx, gate.approvalRequestId)
      }
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return mergeError
    return { errors: { form: ['Merge failed. Please try again.'] } }
  }

  // Photos are re-assigned to canonical via updateMany — blobs remain valid and are preserved.

  redirect('/admin/catalog/duplicates')
}
