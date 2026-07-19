import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import {
  SuggestionApproveForm,
  SuggestionRejectForm,
  SuggestionDuplicateForm,
} from '@/components/admin/SuggestionReviewForms'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  pending:   'Pending',
  approved:  'Approved',
  rejected:  'Rejected',
  duplicate: 'Duplicate',
}

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  approved:  'bg-green-100 text-green-700',
  rejected:  'bg-red-100 text-red-700',
  duplicate: 'bg-blue-100 text-blue-700',
}

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint', near_mint: 'Near Mint', good: 'Good',
  fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
}

export default async function AdminCatalogSuggestionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const suggestion = await prisma.catalogSuggestion.findUnique({
    where: { id },
    select: {
      id:                    true,
      brand:                 true,
      name:                  true,
      series:                true,
      year:                  true,
      color:                 true,
      scale:                 true,
      userNotes:             true,
      adminNotes:            true,
      aiExtractionConfidence: true,
      status:                true,
      reviewedAt:            true,
      createdAt:             true,
      profile: { select: { id: true, name: true, email: true } },
      // Only safe catalog-level CollectionItem fields — no private data
      collectionItem: {
        select: {
          id:           true,
          brand:        true,
          name:         true,
          series:       true,
          year:         true,
          color:        true,
          scale:        true,
          condition:    true,
          cardedOrLoose: true,
          // NOT selected: notes, purchasePrice, purchaseDate, quantity, photos
        },
      },
      approvedCatalog: { select: { id: true, brand: true, name: true } },
    },
  })

  if (!suggestion) notFound()

  const isPending  = suggestion.status === 'pending'
  const hasItem    = !!suggestion.collectionItem
  const lowConf    =
    suggestion.aiExtractionConfidence != null && suggestion.aiExtractionConfidence < 0.5

  return (
    <>
      <div className="mb-6">
        <Link
          href="/admin/catalog-suggestions"
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          ← Back to Suggestions
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {suggestion.brand} · {suggestion.name}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Submitted {suggestion.createdAt.toLocaleDateString()} by{' '}
            <Link
              href={`/admin/customers/${suggestion.profile.id}`}
              className="text-blue-600 hover:underline"
            >
              {suggestion.profile.name ?? suggestion.profile.email}
            </Link>
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
            STATUS_COLORS[suggestion.status] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {STATUS_LABELS[suggestion.status] ?? suggestion.status}
        </span>
      </div>

      {/* Suggested snapshot */}
      <div className="rounded-md border border-gray-200 bg-gray-50 p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Suggested fields (snapshot)</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-gray-500 w-16 shrink-0">Brand</dt>
            <dd className="text-gray-900 font-medium">{suggestion.brand}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-500 w-16 shrink-0">Name</dt>
            <dd className="text-gray-900 font-medium">{suggestion.name}</dd>
          </div>
          {suggestion.year && (
            <div className="flex gap-2">
              <dt className="text-gray-500 w-16 shrink-0">Year</dt>
              <dd className="text-gray-900">{suggestion.year}</dd>
            </div>
          )}
          {suggestion.series && (
            <div className="flex gap-2">
              <dt className="text-gray-500 w-16 shrink-0">Series</dt>
              <dd className="text-gray-900">{suggestion.series}</dd>
            </div>
          )}
          {suggestion.color && (
            <div className="flex gap-2">
              <dt className="text-gray-500 w-16 shrink-0">Color</dt>
              <dd className="text-gray-900">{suggestion.color}</dd>
            </div>
          )}
          {suggestion.scale && (
            <div className="flex gap-2">
              <dt className="text-gray-500 w-16 shrink-0">Scale</dt>
              <dd className="text-gray-900">{suggestion.scale}</dd>
            </div>
          )}
        </dl>

        {suggestion.userNotes && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <p className="text-xs font-medium text-gray-500 mb-1">User notes</p>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{suggestion.userNotes}</p>
          </div>
        )}

        {suggestion.aiExtractionConfidence != null && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <p className="text-xs text-gray-500">
              AI extraction confidence:{' '}
              <span className={lowConf ? 'text-amber-600 font-medium' : 'text-gray-700'}>
                {Math.round(suggestion.aiExtractionConfidence * 100)}%
              </span>
            </p>
            {lowConf && (
              <p className="text-xs text-amber-600 font-medium mt-0.5">
                Low AI confidence — verify fields carefully before approving.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Linked CollectionItem context — catalog-safe fields only */}
      {hasItem && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">
            Submitter&apos;s collection item context
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Catalog-level fields only. Private data (notes, purchase info, photos) is not shown.
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {suggestion.collectionItem!.brand && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Brand</dt>
                <dd className="text-gray-700">{suggestion.collectionItem!.brand}</dd>
              </div>
            )}
            {suggestion.collectionItem!.name && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Name</dt>
                <dd className="text-gray-700">{suggestion.collectionItem!.name}</dd>
              </div>
            )}
            {suggestion.collectionItem!.year && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Year</dt>
                <dd className="text-gray-700">{suggestion.collectionItem!.year}</dd>
              </div>
            )}
            {suggestion.collectionItem!.series && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Series</dt>
                <dd className="text-gray-700">{suggestion.collectionItem!.series}</dd>
              </div>
            )}
            {suggestion.collectionItem!.color && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Color</dt>
                <dd className="text-gray-700">{suggestion.collectionItem!.color}</dd>
              </div>
            )}
            {suggestion.collectionItem!.scale && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Scale</dt>
                <dd className="text-gray-700">{suggestion.collectionItem!.scale}</dd>
              </div>
            )}
            {suggestion.collectionItem!.condition && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Condition</dt>
                <dd className="text-gray-700">
                  {CONDITION_LABELS[suggestion.collectionItem!.condition] ??
                    suggestion.collectionItem!.condition}
                </dd>
              </div>
            )}
            {suggestion.collectionItem!.cardedOrLoose && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Type</dt>
                <dd className="text-gray-700 capitalize">
                  {suggestion.collectionItem!.cardedOrLoose}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {/* Resolved state */}
      {!isPending && (
        <div className="rounded-md border border-gray-200 bg-white p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Resolution</h2>
          <p className="text-sm text-gray-700">
            Status:{' '}
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                STATUS_COLORS[suggestion.status] ?? 'bg-gray-100 text-gray-600'
              }`}
            >
              {STATUS_LABELS[suggestion.status]}
            </span>
          </p>
          {suggestion.reviewedAt && (
            <p className="text-xs text-gray-400 mt-1">
              Reviewed {suggestion.reviewedAt.toLocaleDateString()}
            </p>
          )}
          {suggestion.adminNotes && (
            <p className="text-sm text-gray-600 mt-2">{suggestion.adminNotes}</p>
          )}
          {suggestion.approvedCatalog && (
            <p className="text-sm text-gray-700 mt-2">
              Linked catalog model:{' '}
              <Link
                href={`/admin/catalog/${suggestion.approvedCatalog.id}/edit`}
                className="text-blue-600 hover:underline"
              >
                {suggestion.approvedCatalog.brand} {suggestion.approvedCatalog.name}
              </Link>
            </p>
          )}
        </div>
      )}

      {/* Action forms — only shown for pending suggestions */}
      {isPending && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Review actions</h2>

          <SuggestionApproveForm
            suggestionId={suggestion.id}
            hasCollectionItem={hasItem}
            brand={suggestion.brand}
            name={suggestion.name}
            series={suggestion.series}
            year={suggestion.year}
            color={suggestion.color}
            scale={suggestion.scale}
          />

          <SuggestionRejectForm suggestionId={suggestion.id} />

          <SuggestionDuplicateForm
            suggestionId={suggestion.id}
            hasCollectionItem={hasItem}
          />
        </div>
      )}
    </>
  )
}
