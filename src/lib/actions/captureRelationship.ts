'use server'

import { wantAction, unwantAction } from '@/lib/actions/catalogModelDomainActions'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState, type CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'

// 16L: thin read-after-write wrappers used only by the public capture result
// (CaptureCandidateActions.tsx). /catalog/[id] reflects a fresh Want/Unwant via a
// full server-rendered re-visit after wantAction/unwantAction's own revalidatePath
// calls; /capture cannot rely on that, because its candidate list lives in
// client-held useActionState from a PRIOR, unrelated server action call — no
// route-level revalidation reaches it. This is not a second Want/Unwant
// implementation: wantAction/unwantAction (16F/16H, unmodified) still perform the
// entire mutation; this file only re-reads the exact existing batched relationship
// query (16F, unmodified) afterward so the result can be handed back through
// useActionState. No image recognition is rerun, nothing is persisted, and the
// re-read is bounded to the single model just acted on.
export async function wantFromCapture(
  catalogModelId: string,
  formData: FormData,
): Promise<CatalogRelationshipEntry | null> {
  await wantAction(catalogModelId, formData)
  const session = await getBuyerSession()
  if (!session) return null
  const map = await getCatalogRelationshipState(session.profileId, [catalogModelId])
  return map.get(catalogModelId) ?? null
}

export async function unwantFromCapture(
  catalogModelId: string,
  wantedId: string,
): Promise<CatalogRelationshipEntry | null> {
  await unwantAction(catalogModelId, wantedId)
  const session = await getBuyerSession()
  if (!session) return null
  const map = await getCatalogRelationshipState(session.profileId, [catalogModelId])
  return map.get(catalogModelId) ?? null
}
