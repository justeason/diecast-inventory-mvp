import Link from 'next/link'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { PendingActionButton } from './PendingActionButton'
import { wantAction, unwantAction, addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'
import { buildAccountIntentHref } from '@/lib/customerModelIntent'
import { centsToDisplay } from '@/lib/marketModelPageDisplay'
import type { CatalogDiscoveryModel, CatalogModelAvailability } from '@/lib/catalogDiscoveryQuery'
import type { CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'
import type { ValuationResult } from '@/lib/marketValuation'

type Props = {
  model: CatalogDiscoveryModel
  availability: CatalogModelAvailability
  // null = anonymous visitor (no private query was issued); a real entry = the
  // authenticated customer's actual Want/Collection relationship for this model.
  relationship: CatalogRelationshipEntry | null
  // 29B: model-level batch valuation for this card's CatalogModel, at the
  // page's single shared asOf. null means no result is available — either the
  // batch valuation call failed technically (isolated in the page) or this
  // model had no entry in a successful batch — NEVER the same thing as the
  // 'insufficient_data' status, which is a real, disclosed evidence outcome.
  marketValuation: ValuationResult | null
}

// 20A: one CatalogModel = one unified Market discovery result — identity,
// availability, and quick actions (Want/Own/Sell) all in one card, in the
// catalog/encyclopedia grid (not a store SKU grid). Card link, availability
// link, and action controls are DELIBERATELY SIBLINGS, never nested inside one
// another — <a><button></a> would be invalid and would make an action click
// accidentally also fire card navigation.
export function CatalogModelCard({ model, availability, relationship, marketValuation }: Props) {
  const modelName = `${model.brand} ${model.name}`
  const isAuthenticated = relationship !== null
  const wanted = relationship?.wanted ?? false
  const wantedId = relationship?.wantedId ?? null
  const collectionItemId = relationship?.collectionItemId ?? null
  const ownedQuantity = relationship?.ownedQuantity ?? null

  const hasAvailability = availability.count > 0
  // 29B: single canonical current-supply line — replaces the old duplicated
  // "N available · from $X" copy. Never "$0"/"Lowest Ask —"; count>0 implies
  // lowestPrice is set (getCatalogDiscovery only increments count alongside
  // lowestPrice), the null branch below is defensive only.
  const supplyText = hasAvailability
    ? availability.lowestPrice !== null
      ? `Lowest Ask $${availability.lowestPrice.toFixed(2)} · ${availability.count} available`
      : `${availability.count} available`
    : 'Currently unavailable'

  // 29B: EMV is fully independent of supply — never derived from Lowest Ask,
  // never $0. 'insufficient_data' is a real, disclosed evidence outcome
  // ("Limited sales data"); a null marketValuation means the batch call
  // itself failed or produced no entry for this model, which is a distinct,
  // neutral technical-failure state ("Market estimate unavailable").
  const emvText =
    marketValuation?.status === 'valued'
      ? `Est. Market Value ${centsToDisplay(marketValuation.estimatedValueCents)}`
      : marketValuation?.status === 'insufficient_data'
        ? 'Limited sales data'
        : 'Market estimate unavailable'

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
        {/* 29B: at most two concise market lines — EMV, then current supply.
            Both always render (one of their fixed set of states each) so
            card height stays consistent across the grid without a min-height
            hack. */}
        <p className={`border-t border-gray-100 pt-3 text-sm ${marketValuation?.status === 'valued' ? 'text-gray-700' : 'text-gray-400'}`}>
          {emvText}
        </p>
        {hasAvailability ? (
          <Link
            href={`/catalog/${model.id}#available-listings`}
            aria-label={`View ${availability.count} available ${availability.count === 1 ? 'copy' : 'copies'} of ${modelName}`}
            className="mt-1 flex items-center text-sm text-gray-700 underline md:no-underline underline-offset-2 hover:text-gray-900 md:hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
          >
            {supplyText} <span aria-hidden="true">→</span>
          </Link>
        ) : (
          <p className="mt-1 text-sm text-gray-400">{supplyText}</p>
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
