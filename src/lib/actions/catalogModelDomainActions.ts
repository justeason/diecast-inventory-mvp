'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { addToWantedList, removeFromWantedList } from '@/lib/actions/wantedList'
import { createCollectionItem } from '@/lib/actions/collectionItems'
import { getBuyerSession } from '@/lib/buyerSession'

// 37B: normalized error contract for wantAction/unwantAction/addToCollectionAction
// — always keyed `_form` so every caller reads one path, regardless of which
// underlying action's own error-key convention (`_form` vs `form` vs a specific
// field) actually fired. null means success. Never optimistic — every non-null
// result reflects a real rejection the mutation itself returned.
export type CatalogModelActionState = { errors: { _form: string[] } } | null

function firstErrorMessage(errors: Record<string, string[]>): string {
  for (const key of Object.keys(errors)) {
    const msg = errors[key]?.[0]
    if (msg) return msg
  }
  return 'Something went wrong. Please try again.'
}

// 16L: relocated here, verbatim, from CatalogActions.tsx (16F). Next.js forbids
// inline "use server" function bodies inside a file that is also reachable from a
// Client Component's module graph — and 16L's public capture result
// (CaptureCandidateActions.tsx, a Client Component) needs to invoke these same
// three actions directly, alongside CatalogActions.tsx's existing Server Component
// usage. A dedicated module-level "use server" file is the documented, correct
// fix (https://nextjs.org/docs/app/api-reference/directives/use-server) — it is
// safely importable from both server and client code, with no other change to
// behavior. CatalogActions.tsx now imports and re-exports these unchanged, so
// CatalogModelActions.tsx (16H) needs no changes at all.
//
// Thin void-returning wrappers around the existing authoritative mutations —
// <form action> requires void/Promise<void>, but addToWantedList/createCollectionItem
// return an ActionState (used elsewhere with useActionState for error display). No
// new mutation logic lives here; these only adapt the return type and inject the
// catalogModelId the caller already knows, exactly as a hidden form field would.
//
// Want/Unwant stay on their calling page (no redirect), so — rather than assume
// framework-implicit refresh behavior — these two wrappers explicitly revalidate
// both '/browse' (grid) and this specific model's hub path themselves, narrowly,
// without touching addToWantedList/removeFromWantedList (which stay unchanged and
// keep their own existing '/account/wanted' revalidation for every OTHER caller).
// createCollectionItem redirects away on success, so addToCollectionAction needs
// no revalidation of its own.
// 37B: return type widened from Promise<void> to Promise<CatalogModelActionState>
// — the underlying addToWantedList result was previously discarded entirely, so
// a real rejection (rate limit, duplicate) revalidated and rendered exactly as
// if nothing had gone wrong. A void-returning function type is assignable from
// any return type, so this is source-compatible with every existing plain
// `<form action={wantAction.bind(...)}>` caller (CatalogActions.tsx,
// CatalogModelActions.tsx, AccountIntentActions.tsx, captureRelationship.ts) —
// none of them need to change; only CatalogModelCard.tsx now reads the result.
export async function wantAction(catalogModelId: string, formData: FormData): Promise<CatalogModelActionState> {
  formData.set('catalogModelId', catalogModelId)
  const result = await addToWantedList(null, formData)
  if (result?.errors) return { errors: { _form: [firstErrorMessage(result.errors)] } }
  revalidatePath('/browse')
  revalidatePath(`/catalog/${catalogModelId}`)
  return null
}

// removeFromWantedList itself has no error signal (session-missing/already-gone
// both resolve silently, matching RemoveFromWantedButton's existing behavior) —
// the one real, user-meaningful failure this can surface is a lost session,
// checked here explicitly rather than duplicating removeFromWantedList's mutation.
export async function unwantAction(catalogModelId: string, wantedId: string): Promise<CatalogModelActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { _form: ['You must be signed in.'] } }
  await removeFromWantedList(wantedId)
  revalidatePath('/browse')
  revalidatePath(`/catalog/${catalogModelId}`)
  return null
}

export async function addToCollectionAction(catalogModelId: string, formData: FormData): Promise<CatalogModelActionState> {
  formData.set('catalogId', catalogModelId)
  // 26B: tags the founding AcquisitionLot's source as 'i_own_it' rather than
  // the generic 'manual' default — this is the bare one-click button, not the
  // full manual-add form.
  formData.set('source', 'i_own_it')
  // createCollectionItem redirects (throws) on success — reaching this line at
  // all means it returned instead, i.e. failed.
  const result = await createCollectionItem(null, formData)
  if (result?.errors) return { errors: { _form: [firstErrorMessage(result.errors)] } }
  return null
}

// 16M: used only by the /account/continue Want continuation — reuses wantAction
// verbatim (same mutation, same /browse + /catalog/[id] revalidation), then
// leaves the continuation page (Part Y) so the customer lands somewhere showing
// authoritative post-mutation state, rather than a stale query-param screen.
export async function continueWantAction(catalogModelId: string, formData: FormData): Promise<void> {
  await wantAction(catalogModelId, formData)
  redirect(`/catalog/${catalogModelId}`)
}
