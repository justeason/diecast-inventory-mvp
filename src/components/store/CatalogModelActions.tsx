import Link from 'next/link'
import { wantAction, unwantAction, addToCollectionAction } from './CatalogActions'
import { PendingActionButton } from './PendingActionButton'
import type { CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'
import { buildAccountIntentHref } from '@/lib/customerModelIntent'

// 16H: the CatalogModel hub's own action row — reuses the EXACT SAME authoritative
// wrapper actions as 16F/16G's CatalogActions (Want/Unwant/Add to Collection), but
// with a different, simpler layout: always visible, no hover reveal, no mobile
// popup. A full detail page has room to just show every action directly (16G's
// responsive tray/popup was built for a dense Listing grid, not a single-model
// page — Part AN). Domain behavior is shared; only presentation differs.
export function CatalogModelActions({
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

  const btnCls = 'rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'
  const wantedBtnCls = 'rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'
  const ownedCls = 'rounded-md border border-green-200 bg-green-50 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'

  const sellHref = collectionItemId
    ? `/account/collection/${collectionItemId}/sell`
    : `/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}`

  // 16M: anonymous model actions now preserve intent through sign-in instead of
  // dead-ending at plain /account.
  const wantHref = buildAccountIntentHref({ action: 'want', catalogModelId })
  const ownHref = buildAccountIntentHref({ action: 'own', catalogModelId })
  const sellIntentHref = buildAccountIntentHref({ action: 'sell', catalogModelId })

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Want */}
      {!isAuthenticated ? (
        <Link href={wantHref} aria-label={`Sign in to want ${modelName}`} className={btnCls}>
          ♡ Want
        </Link>
      ) : wanted ? (
        <form action={unwantAction.bind(null, catalogModelId, wantedId!)}>
          <PendingActionButton label="♥ Wanted" pendingLabel="Removing…" ariaLabel={`Remove ${modelName} from Wanted`} className={wantedBtnCls} />
        </form>
      ) : (
        <form action={wantAction.bind(null, catalogModelId)}>
          <PendingActionButton label="♡ Want" pendingLabel="Wanting…" ariaLabel={`Want ${modelName}`} className={btnCls} />
        </form>
      )}

      {/* Collection */}
      {!isAuthenticated ? (
        <Link href={ownHref} aria-label={`Sign in to add ${modelName} to your collection`} className={btnCls}>
          + Add to Collection
        </Link>
      ) : collectionItemId ? (
        <Link href={`/account/collection/${collectionItemId}`} aria-label={`View owned ${modelName}`} className={ownedCls}>
          ✓ Own{ownedQuantity !== null ? ` ${ownedQuantity}` : ''}
        </Link>
      ) : (
        <form action={addToCollectionAction.bind(null, catalogModelId)}>
          <PendingActionButton label="+ Add to Collection" pendingLabel="Adding…" ariaLabel={`Add ${modelName} to Collection`} className={btnCls} />
        </form>
      )}

      {/* Sell One */}
      {!isAuthenticated ? (
        <Link href={sellIntentHref} aria-label={`Sign in to sell ${modelName}`} className={btnCls}>
          Sell One
        </Link>
      ) : (
        <Link href={sellHref} aria-label={`Sell one ${modelName}`} className={btnCls}>
          Sell One
        </Link>
      )}
    </div>
  )
}
