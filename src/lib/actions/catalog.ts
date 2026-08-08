'use server'

import { z } from 'zod'

import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { searchCatalogModels } from '@/lib/catalogSearch'
import { DUPLICATE_SCORE_THRESHOLD } from '@/lib/catalogMatching'
import { computeImpactCounts, type MergeImpactSummary } from '@/lib/catalogDataQualityQuery'

export type MergeActionState = { errors: Record<string, string[]> } | null

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

        // Stale-preview + direction check after acquiring locks.
        // Verifies canonical/source IDs match submitted direction, then recalculates all 9 counts.
        if (expectedPayload) {
          if (expectedPayload.canonicalModelId !== canonicalId || expectedPayload.sourceModelId !== dupeId) {
            mergeError = { errors: { form: ['Merge direction was changed since the preview. Refresh and confirm again.'] } }
            throw new Error('TX_VALIDATION')
          }
          const current = await computeImpactCounts(dupeId, tx)
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

        const [items, collItems, suggestions, submissions, photos] = await Promise.all([
          tx.itemInstance.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
          tx.collectionItem.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
          tx.catalogSuggestion.updateMany({ where: { approvedCatalogId: dupeId }, data: { approvedCatalogId: canonicalId } }),
          tx.sellerSubmission.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
          tx.catalogModelPhoto.updateMany({ where: { catalogId: dupeId }, data: { catalogId: canonicalId } }),
        ])

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
          },
        })

        // Pre-delete integrity check: all FK references to dupeId must have been moved.
        // The FOR UPDATE lock on this CatalogModel row blocks concurrent FK inserts/updates
        // (Postgres acquires FOR KEY SHARE on the referenced row for any FK write, which
        // conflicts with FOR UPDATE). So remaining should always be 0. If non-zero, roll back.
        const [ri, rc, rs, rsub, rp] = await Promise.all([
          tx.itemInstance.count({ where: { catalogId: dupeId } }),
          tx.collectionItem.count({ where: { catalogId: dupeId } }),
          tx.catalogSuggestion.count({ where: { approvedCatalogId: dupeId } }),
          tx.sellerSubmission.count({ where: { catalogId: dupeId } }),
          tx.catalogModelPhoto.count({ where: { catalogId: dupeId } }),
        ])
        const remaining = ri + rc + rs + rsub + rp
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
      }
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return mergeError
    return { errors: { form: ['Merge failed. Please try again.'] } }
  }

  // Photos are re-assigned to canonical via updateMany — blobs remain valid and are preserved.

  redirect('/admin/catalog/duplicates')
}
