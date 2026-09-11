import Link from 'next/link'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { PendingActionButton } from './PendingActionButton'
import { wantAction, unwantAction, addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'
import { buildAccountIntentHref } from '@/lib/customerModelIntent'
import type { CatalogDiscoveryModel, CatalogModelAvailability } from '@/lib/catalogDiscoveryQuery'
import type { CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'

type Props = {
  model: CatalogDiscoveryModel
  availability: CatalogModelAvailability
  // null = anonymous visitor (no private query was issued); a real entry = the
  // authenticated customer's actual Want/Collection relationship for this model.
  relationship: CatalogRelationshipEntry | null
}

// 20A: one CatalogModel = one unified Market discovery result — identity,
// availability, and quick actions (Want/Own/Sell) all in one card, in the
// catalog/encyclopedia grid (not a store SKU grid). Card link, availability
// link, and action controls are DELIBERATELY SIBLINGS, never nested inside one
// another — <a><button></a> would be invalid and would make an action click
// accidentally also fire card navigation.
export function CatalogModelCard({ model, availability, relationship }: Props) {
  const modelName = `${model.brand} ${model.name}`
  const isAuthenticated = relationship !== null
  const wanted = relationship?.wanted ?? false
  const wantedId = relationship?.wantedId ?? null
  const collectionItemId = relationship?.collectionItemId ?? null
  const ownedQuantity = relationship?.ownedQuantity ?? null

  const hasAvailability = availability.count > 0
  const availabilityText = hasAvailability
    ? `${availability.count} available${availability.lowestPrice !== null ? ` · from $${availability.lowestPrice.toFixed(2)}` : ''}`
    : 'Currently unavailable'

  const sellHref = collectionItemId
    ? `/account/collection/${collectionItemId}/sell`
    : `/sell?catalogId=${encodeURIComponent(model.id)}`
  const wantHref = buildAccountIntentHref({ action: 'want', catalogModelId: model.id })
  const ownHref = buildAccountIntentHref({ action: 'own', catalogModelId: model.id })

  // Mobile (<md): always visible, no hover/long-press/extra-tap dependency.
  // md+: visually revealed on hover OR keyboard focus-within — never mouse-only,
  // never removed from the DOM/tab order, so a keyboard user can always Tab to
  // these controls even before the row visually reveals.
  const actionRowCls =
    'mt-2 grid grid-cols-3 gap-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity'
  const actionBtnCls =
    'flex min-h-11 items-center justify-center rounded-md border border-gray-300 bg-white px-1 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'
  const actionBtnActiveCls =
    'flex min-h-11 items-center justify-center rounded-md border border-red-200 bg-red-50 px-1 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'
  const actionBtnOwnedCls =
    'flex min-h-11 items-center justify-center rounded-md border border-green-200 bg-green-50 px-1 text-xs font-medium text-green-700 hover:bg-green-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'

  return (
    <article className="group rounded-lg border border-gray-200 bg-white hover:border-gray-400 transition-colors">
      <Link href={`/catalog/${model.id}`} aria-label={`${modelName}${model.year ? ` (${model.year})` : ''}`} className="block">
        <div className="aspect-square overflow-hidden rounded-t-lg relative">
          <PhotoThumbnail photoUrl={model.photoUrl} alt={modelName} size="fill" />
        </div>
        <div className="px-4 pt-4">
          <h3 className="font-medium text-gray-900 leading-snug line-clamp-2">
            {modelName}
            {model.year && <span className="text-gray-500 font-normal"> ({model.year})</span>}
          </h3>
          {model.series && <p className="mt-0.5 text-xs text-gray-500 truncate">{model.series}</p>}
        </div>
      </Link>

      <div className="px-4 pt-3 pb-4">
        {/* 20B §25/§27: a consistent min-height on mobile (where availability
            may render as two stacked lines) keeps available/unavailable cards
            reasonably aligned in the dense grid — never achieved by
            truncating/clamping away the price text. */}
        {hasAvailability ? (
          <Link
            href={`/catalog/${model.id}#available-listings`}
            aria-label={`View ${availability.count} available ${availability.count === 1 ? 'copy' : 'copies'} of ${modelName}`}
            className="flex min-h-10 md:min-h-0 items-center border-t border-gray-100 pt-3 text-sm text-gray-700 underline md:no-underline underline-offset-2 hover:text-gray-900 md:hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
          >
            {/* 20B §25: mobile renders two compact lines ("N available" /
                "from $X.XX") rather than wrapping the combined sentence;
                desktop keeps the single-line "N available · from $X.XX". Same
                underlying data, no semantic change — price is never hidden. */}
            <span className="md:hidden">
              {availability.count} available <span aria-hidden="true">→</span>
              {availability.lowestPrice !== null && (
                <>
                  <br />
                  from ${availability.lowestPrice.toFixed(2)}
                </>
              )}
            </span>
            <span className="hidden md:inline">
              {availabilityText} <span aria-hidden="true">→</span>
            </span>
          </Link>
        ) : (
          <p className="flex min-h-10 md:min-h-0 items-center border-t border-gray-100 pt-3 text-sm text-gray-400">
            {availabilityText}
          </p>
        )}

        <div className={actionRowCls}>
          {!isAuthenticated ? (
            <Link href={wantHref} aria-label={`Sign in to want ${modelName}`} className={actionBtnCls}>
              Want
            </Link>
          ) : wanted ? (
            <form action={unwantAction.bind(null, model.id, wantedId!)}>
              <PendingActionButton label="Wanted" pendingLabel="…" ariaLabel={`Remove ${modelName} from Wanted`} className={`w-full ${actionBtnActiveCls}`} />
            </form>
          ) : (
            <form action={wantAction.bind(null, model.id)}>
              <PendingActionButton label="Want" pendingLabel="…" ariaLabel={`Want this — ${modelName}`} className={`w-full ${actionBtnCls}`} />
            </form>
          )}

          {!isAuthenticated ? (
            <Link href={ownHref} aria-label={`Sign in to add ${modelName} to your collection`} className={actionBtnCls}>
              Own
            </Link>
          ) : collectionItemId ? (
            // 20B §27: mobile shows the bare "Owned" state (no quantity digits
            // crammed into the narrow 3-column cell); the accessible name
            // always retains the quantity regardless of what's visually
            // shown. Desktop keeps "Owned N" exactly as before.
            <Link
              href={`/account/collection/${collectionItemId}`}
              aria-label={ownedQuantity !== null ? `Owned, quantity ${ownedQuantity} — ${modelName}` : `View owned ${modelName}`}
              className={actionBtnOwnedCls}
            >
              <span className="md:hidden">Owned</span>
              <span className="hidden md:inline">Owned{ownedQuantity !== null ? ` ${ownedQuantity}` : ''}</span>
            </Link>
          ) : (
            <form action={addToCollectionAction.bind(null, model.id)}>
              <PendingActionButton label="Own" pendingLabel="…" ariaLabel={`I Own It — ${modelName}`} className={`w-full ${actionBtnCls}`} />
            </form>
          )}

          <Link href={sellHref} aria-label={`Sell this item — ${modelName}`} className={actionBtnCls}>
            Sell
          </Link>
        </div>
      </div>
    </article>
  )
}
