import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'
import { parseCustomerModelIntent, buildAccountIntentHref, isSafeCatalogModelId } from '@/lib/customerModelIntent'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { AccountIntentActions } from '@/components/store/AccountIntentActions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Continue | CollectNTrades',
  robots: { index: false, follow: false },
}

const INTENT_DESCRIPTION: Record<'want' | 'own' | 'sell', string> = {
  want: 'Add this model to Wanted',
  own: 'Add this model to your Collection',
  sell: 'List this model to sell',
}

// 16M: the one canonical destination anonymous model actions (Capture/Catalog hub/
// Browse) point to, and the one destination the buyer magic-link flow can carry a
// customer back to. Read-only on every GET — opening this page (or the magic link
// itself) never adds to Wanted/Collection or creates a SellerSubmission; only an
// explicit click on AccountIntentActions' button does that (Part F/G).
export default async function AccountContinuePage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; catalogId?: string }>
}) {
  const { action: rawAction, catalogId: rawCatalogId } = await searchParams
  const action = parseCustomerModelIntent(rawAction)

  // Malformed intent (bad/missing action, missing/malformed catalogId) is a
  // "this link isn't valid" case, not a "resource doesn't exist" case — a soft
  // inline message, not notFound(), per Part AF.
  if (!action || !isSafeCatalogModelId(rawCatalogId)) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">This link isn&apos;t valid</h1>
        <p className="text-sm text-gray-600 mb-6">
          The continuation link is missing some information. You can search the catalog
          or go to your account directly.
        </p>
        <div className="flex flex-wrap gap-4">
          <Link href="/catalog" className="text-sm font-medium text-gray-900 hover:underline underline-offset-2">
            ← Search Models
          </Link>
          <Link href="/account" className="text-sm font-medium text-gray-900 hover:underline underline-offset-2">
            Go to Account
          </Link>
        </div>
      </div>
    )
  }

  const catalogModelId = rawCatalogId

  // 16M Part E: catalogId is untrusted URL input — re-fetch identity server-side,
  // never trust brand/name/year/etc. carried in the query string. Same public
  // identity shape as /catalog/[id]. One query, no Listing/valuation lookup —
  // marketplace availability is irrelevant to a Want/Own/Sell intent (Part V).
  const model = await prisma.catalogModel.findUnique({
    where: { id: catalogModelId },
    select: {
      id: true, brand: true, name: true, year: true, series: true, color: true, scale: true,
      photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
    },
  })
  if (!model) notFound()

  const modelName = `${model.brand} ${model.name}`

  // 16M Part K: relationship state is fetched ONLY when a session already exists —
  // never before authentication (Part J). One bounded call, scoped to this one id.
  const session = await getBuyerSession()
  const relationshipMap = session ? await getCatalogRelationshipState(session.profileId, [catalogModelId]) : null
  const relationship = relationshipMap?.get(catalogModelId) ?? null

  const header = (
    <div className="flex items-center gap-4 mb-6">
      <div className="w-16 h-16 shrink-0 rounded-md overflow-hidden border border-gray-200 bg-gray-50 relative">
        <PhotoThumbnail photoUrl={model.photos[0]?.url ?? null} alt={modelName} size="fill" />
      </div>
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-gray-900 leading-snug truncate">
          {modelName}
          {model.year && <span className="font-normal text-gray-500"> ({model.year})</span>}
        </h1>
        {(model.series || model.color || model.scale) && (
          <p className="text-sm text-gray-500 truncate">
            {[model.series, model.color, model.scale].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
    </div>
  )

  if (!session) {
    return (
      <div className="max-w-md">
        <p className="text-sm font-medium text-gray-500 mb-2">Continue after signing in</p>
        {header}
        <p className="text-sm text-gray-700 mb-6">
          You&apos;re signing in to: <span className="font-medium">{INTENT_DESCRIPTION[action]}</span>
        </p>
        <BuyerOrderAccessForm returnTo={buildAccountIntentHref({ action, catalogModelId })} />
      </div>
    )
  }

  return (
    <div className="max-w-md">
      <p className="text-sm font-medium text-gray-500 mb-2">{INTENT_DESCRIPTION[action]}</p>
      {header}
      <AccountIntentActions
        action={action}
        catalogModelId={catalogModelId}
        modelName={modelName}
        relationship={relationship!}
      />
    </div>
  )
}
