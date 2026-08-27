'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { addToWantedList, removeFromWantedList } from '@/lib/actions/wantedList'
import { createCollectionItem } from '@/lib/actions/collectionItems'

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
export async function wantAction(catalogModelId: string, formData: FormData): Promise<void> {
  formData.set('catalogModelId', catalogModelId)
  await addToWantedList(null, formData)
  revalidatePath('/browse')
  revalidatePath(`/catalog/${catalogModelId}`)
}

export async function unwantAction(catalogModelId: string, wantedId: string): Promise<void> {
  await removeFromWantedList(wantedId)
  revalidatePath('/browse')
  revalidatePath(`/catalog/${catalogModelId}`)
}

export async function addToCollectionAction(catalogModelId: string, formData: FormData): Promise<void> {
  formData.set('catalogId', catalogModelId)
  await createCollectionItem(null, formData)
}

// 16M: used only by the /account/continue Want continuation — reuses wantAction
// verbatim (same mutation, same /browse + /catalog/[id] revalidation), then
// leaves the continuation page (Part Y) so the customer lands somewhere showing
// authoritative post-mutation state, rather than a stale query-param screen.
export async function continueWantAction(catalogModelId: string, formData: FormData): Promise<void> {
  await wantAction(catalogModelId, formData)
  redirect(`/catalog/${catalogModelId}`)
}
