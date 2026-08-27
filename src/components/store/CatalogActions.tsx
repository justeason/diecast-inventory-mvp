import Link from 'next/link'
import { CatalogActionsPopup } from './CatalogActionsPopup'
import { PendingActionButton } from './PendingActionButton'
import type { CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'
// 16L: wantAction/unwantAction/addToCollectionAction now live in
// catalogModelDomainActions.ts (a dedicated top-level "use server" file) — moved
// there, unchanged, because CaptureCandidateActions.tsx (16L, a Client Component)
// needs to invoke them directly, and Next.js forbids inline "use server" function
// bodies in a file that is also reachable from a Client Component's module graph.
// Re-exported below so every existing consumer of this module (CatalogModelActions.tsx)
// needs no changes at all.
import { wantAction, unwantAction, addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'

export { wantAction, unwantAction, addToCollectionAction }

// 16G Final: two presentations of the SAME underlying actions, chosen by
// responsive CSS only (no JS viewport detection) — never two different mutation
// paths, only two different className treatments for identical <form>/<Link>
// markup, per breakpoint.
//   - Desktop (md+): a plain hoverable/focusable row, no popup semantics, no
//     aria-expanded claim — items are ordinary controls in the card's natural tab
//     order, revealed visually via CSS on hover/focus-within (never a "closed
//     menu" state, so there's nothing for an ARIA attribute to disagree with).
//   - Mobile/tablet (<md): CatalogActionsPopup — a real disclosure with a
//     genuinely mounted/unmounted panel, so aria-expanded always matches whether
//     the controls actually exist/are reachable.
function SecondaryActions({
  isAuthenticated,
  collectionItemId,
  catalogModelId,
  sellHref,
  modelName,
  itemCls,
}: {
  isAuthenticated: boolean
  collectionItemId: string | null
  catalogModelId: string
  sellHref: string
  modelName: string
  itemCls: string
}) {
  if (!isAuthenticated) {
    return (
      <>
        <Link href="/account" aria-label={`Sign in to add ${modelName} to your collection`} className={itemCls}>
          + Add to Collection
        </Link>
        <Link href="/account" aria-label={`Sign in to sell ${modelName}`} className={itemCls}>
          Sell One
        </Link>
      </>
    )
  }
  return (
    <>
      {!collectionItemId && (
        <form action={addToCollectionAction.bind(null, catalogModelId)}>
          <PendingActionButton
            label="+ Add to Collection"
            pendingLabel="Adding…"
            ariaLabel={`Add ${modelName} to Collection`}
            className={itemCls}
          />
        </form>
      )}
      <Link href={sellHref} aria-label={`Sell one ${modelName}`} className={itemCls}>
        Sell One
      </Link>
    </>
  )
}

// 16G: shared customer interaction tray for a CatalogModel, rendered from any
// listing card that has a catalogModelId. Server component — every action here is
// a plain <form>/<Link> bound to an EXISTING authoritative mutation (addToWantedList/
// removeFromWantedList/createCollectionItem), never a new engine. `relationship` is
// null for anonymous visitors (no private query was ever issued for them — see
// browse/page.tsx) and a real (possibly all-empty) object for authenticated
// customers, so "not wanted" and "not signed in" are never conflated.
//
// Layout: Want and (when owned) the ownership badge are PERSISTENT/always visible
// on every breakpoint — common, reversible, and useful status respectively. "Add
// to Collection" (when not owned) and "Sell One" render via SecondaryActions,
// twice in the DOM (desktop tray + mobile popup), switched by `hidden md:flex` /
// `md:hidden` — never by JS.
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

  const persistentCls = 'text-xs text-gray-500 hover:text-gray-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 rounded'
  const wantedActiveCls = 'text-xs font-medium text-red-600 hover:text-red-700 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 rounded'
  // Desktop: ordinary small text links, revealed on hover/focus-within of the card
  // (`group` lives on ListingCard's outer wrapper). Not a popup — always present,
  // always in normal tab order, just visually de-emphasized until approached.
  const desktopItemCls = 'text-xs text-gray-500 hover:text-gray-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 rounded'
  // Mobile popup: block rows inside the genuinely-mounted disclosure panel.
  const mobileItemCls = 'block w-full text-left px-3 py-2 text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors'

  const sellHref = collectionItemId
    ? `/account/collection/${collectionItemId}/sell`
    : `/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}`

  return (
    <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
      {/* Persistent: Want (reversible, common) + owned status (useful, non-destructive) */}
      <div className="flex items-center gap-3">
        {!isAuthenticated ? (
          <Link href="/account" aria-label={`Sign in to want ${modelName}`} className={persistentCls}>
            ♡ Want
          </Link>
        ) : wanted ? (
          <form action={unwantAction.bind(null, catalogModelId, wantedId!)}>
            <PendingActionButton
              label="♥ Wanted"
              pendingLabel="Removing…"
              ariaLabel={`Remove ${modelName} from Wanted`}
              className={wantedActiveCls}
            />
          </form>
        ) : (
          <form action={wantAction.bind(null, catalogModelId)}>
            <PendingActionButton
              label="♡ Want"
              pendingLabel="Wanting…"
              ariaLabel={`Want ${modelName}`}
              className={persistentCls}
            />
          </form>
        )}

        {isAuthenticated && collectionItemId && (
          <Link
            href={`/account/collection/${collectionItemId}`}
            aria-label={`View owned ${modelName}`}
            className="text-xs font-medium text-green-700 hover:text-green-800 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 rounded"
          >
            ✓ Own{ownedQuantity !== null ? ` ${ownedQuantity}` : ''}
          </Link>
        )}
      </div>

      {/* Desktop (md+): plain reveal-on-hover/focus-within row, no popup semantics */}
      <div className="hidden md:flex items-center gap-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <SecondaryActions
          isAuthenticated={isAuthenticated}
          collectionItemId={collectionItemId}
          catalogModelId={catalogModelId}
          sellHref={sellHref}
          modelName={modelName}
          itemCls={desktopItemCls}
        />
      </div>

      {/* Mobile/tablet (<md): explicit tap-to-open disclosure, no hover dependency */}
      <div className="md:hidden">
        <CatalogActionsPopup triggerLabel={`More actions for ${modelName}`}>
          <SecondaryActions
            isAuthenticated={isAuthenticated}
            collectionItemId={collectionItemId}
            catalogModelId={catalogModelId}
            sellHref={sellHref}
            modelName={modelName}
            itemCls={mobileItemCls}
          />
        </CatalogActionsPopup>
      </div>
    </div>
  )
}
