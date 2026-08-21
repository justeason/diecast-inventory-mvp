import Link from 'next/link'
import { revalidatePath } from 'next/cache'
import { addToWantedList, removeFromWantedList } from '@/lib/actions/wantedList'
import { createCollectionItem } from '@/lib/actions/collectionItems'
import type { CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'

// Thin void-returning wrappers around the existing authoritative mutations —
// <form action> requires void/Promise<void>, but addToWantedList/createCollectionItem
// return an ActionState (used elsewhere with useActionState for error display). No
// new mutation logic lives here; these only adapt the return type and inject the
// catalogModelId the card already knows, exactly as a hidden form field would.
//
// 16F Final: Want/Unwant stay on /browse (no redirect), so — rather than assume
// framework-implicit refresh behavior — these two wrappers explicitly revalidate
// '/browse' themselves, narrowly, without touching addToWantedList/removeFromWantedList
// (which stay unchanged and keep their own existing '/account/wanted' revalidation for
// every OTHER caller). createCollectionItem redirects away from /browse on success, so
// addToCollectionAction needs no revalidation of its own.
async function wantAction(catalogModelId: string, formData: FormData): Promise<void> {
  'use server'
  formData.set('catalogModelId', catalogModelId)
  await addToWantedList(null, formData)
  revalidatePath('/browse')
}

async function unwantAction(wantedId: string): Promise<void> {
  'use server'
  await removeFromWantedList(wantedId)
  revalidatePath('/browse')
}

async function addToCollectionAction(catalogModelId: string, formData: FormData): Promise<void> {
  'use server'
  formData.set('catalogId', catalogModelId)
  await createCollectionItem(null, formData)
}

// 16F: shared customer interaction tray for a CatalogModel, rendered from any
// listing card that has a catalogModelId. Server component — every action here is
// a plain <form>/<Link> bound to an EXISTING authoritative mutation (addToWantedList/
// removeFromWantedList/createCollectionItem), never a new engine. `relationship` is
// null for anonymous visitors (no private query was ever issued for them — see
// browse/page.tsx) and a real (possibly all-empty) object for authenticated
// customers, so "not wanted" and "not signed in" are never conflated.
//
// Baseline (not the full 16G hover/bottom-sheet polish): actions are always
// visible at a small, secondary visual weight — never hidden behind hover-only,
// so mobile and keyboard users reach them exactly like desktop users.
export function CatalogActions({
  catalogModelId,
  modelName,
  relationship,
}: {
  catalogModelId: string
  modelName: string
  relationship: CatalogRelationshipEntry | null
}) {
  const isAuthenticated = relationship !== null
  const wanted = relationship?.wanted ?? false
  const wantedId = relationship?.wantedId ?? null
  const collectionItemId = relationship?.collectionItemId ?? null
  const ownedQuantity = relationship?.ownedQuantity ?? null

  const linkCls = 'text-gray-500 hover:text-gray-900 transition-colors'
  const activeCls = 'font-medium text-gray-900 hover:underline underline-offset-2'

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {/* Want */}
      {!isAuthenticated ? (
        <Link href="/account" aria-label={`Sign in to want ${modelName}`} className={linkCls}>
          ♡ Want
        </Link>
      ) : wanted ? (
        <form action={unwantAction.bind(null, wantedId!)}>
          <button type="submit" aria-label={`Remove ${modelName} from Wanted`} className={`${activeCls} text-red-600 hover:text-red-700`}>
            ♥ Wanted
          </button>
        </form>
      ) : (
        <form action={wantAction.bind(null, catalogModelId)}>
          <button type="submit" aria-label={`Want ${modelName}`} className={linkCls}>
            ♡ Want
          </button>
        </form>
      )}

      {/* Collection */}
      {!isAuthenticated ? (
        <Link href="/account" aria-label={`Sign in to add ${modelName} to your collection`} className={linkCls}>
          + Add to Collection
        </Link>
      ) : collectionItemId ? (
        <Link href={`/account/collection/${collectionItemId}`} aria-label={`View owned ${modelName}`} className={`${activeCls} text-green-700 hover:text-green-800`}>
          ✓ In Collection{ownedQuantity !== null ? ` · ${ownedQuantity}` : ''}
        </Link>
      ) : (
        <form action={addToCollectionAction.bind(null, catalogModelId)}>
          <button type="submit" aria-label={`Add ${modelName} to Collection`} className={linkCls}>
            + Add to Collection
          </button>
        </form>
      )}

      {/* Sell One */}
      {!isAuthenticated ? (
        <Link href="/account" aria-label={`Sign in to sell ${modelName}`} className={linkCls}>
          Sell One
        </Link>
      ) : collectionItemId ? (
        <Link href={`/account/collection/${collectionItemId}/sell`} aria-label={`Sell one ${modelName}`} className={linkCls}>
          Sell One
        </Link>
      ) : (
        <Link href={`/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}`} aria-label={`Sell one ${modelName}`} className={linkCls}>
          Sell One
        </Link>
      )}
    </div>
  )
}
