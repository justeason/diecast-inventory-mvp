import Link from 'next/link'
import { addToCollectionAction, continueWantAction } from '@/lib/actions/catalogModelDomainActions'
import { PendingActionButton } from './PendingActionButton'
import type { CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'
import type { CustomerModelIntent } from '@/lib/customerModelIntent'

type Props = {
  action: CustomerModelIntent
  catalogModelId: string
  modelName: string
  relationship: CatalogRelationshipEntry
}

const btnCls = 'rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'
const secondaryCls = 'rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900'

// 16M: the authenticated half of /account/continue. This is a READ of already-
// fetched relationship state (Part K) rendered as one explicit action — it never
// mutates on its own; the customer must click. Reuses the exact same domain
// actions as CatalogModelActions (16H)/CaptureCandidateActions (16L):
// continueWantAction (== wantAction + redirect, 16M), addToCollectionAction
// unchanged. "Sell" is pure navigation, matching the existing sellHref ternary
// used everywhere else — never a SellerSubmission write here.
export function AccountIntentActions({ action, catalogModelId, modelName, relationship }: Props) {
  const sellHref = relationship.collectionItemId
    ? `/account/collection/${relationship.collectionItemId}/sell`
    : `/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}`

  if (action === 'want') {
    if (relationship.wanted) {
      return (
        <div className="space-y-3">
          <p className="text-sm font-medium text-red-600">♥ Already in Wanted</p>
          <div className="flex flex-wrap gap-3">
            <Link href={`/catalog/${catalogModelId}`} className={secondaryCls}>
              View Model
            </Link>
            <Link href="/account/wanted" className={secondaryCls}>
              Manage Wanted
            </Link>
          </div>
        </div>
      )
    }
    return (
      <form action={continueWantAction.bind(null, catalogModelId)}>
        <PendingActionButton
          label="Continue — Add to Wanted"
          pendingLabel="Adding…"
          ariaLabel={`Add ${modelName} to Wanted`}
          className={btnCls}
        />
      </form>
    )
  }

  if (action === 'own') {
    if (relationship.collectionItemId) {
      return (
        <div className="space-y-3">
          <p className="text-sm font-medium text-green-700">
            ✓ Own{relationship.ownedQuantity !== null ? ` ${relationship.ownedQuantity}` : ''}
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href={`/account/collection/${relationship.collectionItemId}`} className={secondaryCls}>
              View Collection Item
            </Link>
            <Link href={sellHref} className={secondaryCls}>
              Sell One
            </Link>
          </div>
        </div>
      )
    }
    return (
      <form action={addToCollectionAction.bind(null, catalogModelId)}>
        <PendingActionButton
          label="Continue — Add to Collection"
          pendingLabel="Adding…"
          ariaLabel={`Add ${modelName} to Collection`}
          className={btnCls}
        />
      </form>
    )
  }

  // action === 'sell' — navigation only, no mutation here.
  return (
    <Link href={sellHref} aria-label={`Continue to sell ${modelName}`} className={btnCls}>
      Continue to Sell
    </Link>
  )
}
