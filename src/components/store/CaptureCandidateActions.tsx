'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'
import { wantFromCapture, unwantFromCapture } from '@/lib/actions/captureRelationship'
import { PendingActionButton } from './PendingActionButton'
import type { CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'

type Props = {
  catalogModelId: string
  modelName: string
  initialRelationship: CatalogRelationshipEntry | null
}

// 16L: per-candidate action row for the public capture result. Domain behavior is
// the EXACT SAME as CatalogModelActions (16H) — reused, not duplicated: Want/Unwant
// go through the captureRelationship.ts wrappers (which call wantAction/unwantAction
// verbatim), Add to Collection reuses addToCollectionAction verbatim (redirect to
// Collection detail preserved, unmodified), Sell One is the same owned/unrecorded
// href ternary. CaptureCandidateActions itself cannot import CatalogModelActions
// directly — that component is a Server Component and CaptureIdentify (its only
// possible parent here) must remain a Client Component for its file-upload/preview
// state, so a client-compatible presentational twin is unavoidable; only the
// layout differs (compact, wraps for mobile), never the mutations.
export function CaptureCandidateActions({ catalogModelId, modelName, initialRelationship }: Props) {
  const [relationship, formAction] = useActionState<CatalogRelationshipEntry | null, FormData>(
    (prevState, formData) =>
      prevState?.wanted
        ? unwantFromCapture(catalogModelId, prevState.wantedId!)
        : wantFromCapture(catalogModelId, formData),
    initialRelationship,
  )

  const isAuthenticated = relationship !== null
  const wanted = relationship?.wanted ?? false
  const collectionItemId = relationship?.collectionItemId ?? null
  const ownedQuantity = relationship?.ownedQuantity ?? null

  const btnCls = 'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'
  const wantedBtnCls = 'rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'
  const ownedCls = 'rounded-md border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'

  const sellHref = collectionItemId
    ? `/account/collection/${collectionItemId}/sell`
    : `/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}`

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Want */}
      {!isAuthenticated ? (
        <Link href="/account" aria-label={`Sign in to want ${modelName}`} className={btnCls}>
          ♡ Want This
        </Link>
      ) : wanted ? (
        <form action={formAction}>
          <PendingActionButton label="♥ Wanted" pendingLabel="Removing…" ariaLabel={`Remove ${modelName} from Wanted`} className={wantedBtnCls} />
        </form>
      ) : (
        <form action={formAction}>
          <PendingActionButton label="♡ Want This" pendingLabel="Wanting…" ariaLabel={`Want ${modelName}`} className={btnCls} />
        </form>
      )}

      {/* Collection */}
      {!isAuthenticated ? (
        <Link href="/account" aria-label={`Sign in to add ${modelName} to your collection`} className={btnCls}>
          ＋ I Own This
        </Link>
      ) : collectionItemId ? (
        <Link href={`/account/collection/${collectionItemId}`} aria-label={`View owned ${modelName}`} className={ownedCls}>
          ✓ Own{ownedQuantity !== null ? ` ${ownedQuantity}` : ''}
        </Link>
      ) : (
        <form action={addToCollectionAction.bind(null, catalogModelId)}>
          <PendingActionButton label="＋ I Own This" pendingLabel="Adding…" ariaLabel={`Add ${modelName} to Collection`} className={btnCls} />
        </form>
      )}

      {/* Sell One */}
      {!isAuthenticated ? (
        <Link href="/account" aria-label={`Sign in to sell ${modelName}`} className={btnCls}>
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
