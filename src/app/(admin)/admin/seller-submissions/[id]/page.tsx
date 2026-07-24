import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { SellerSubmissionStatusForm } from '@/components/admin/SellerSubmissionStatusForm'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  submitted:           'Submitted',
  under_review:        'Under review',
  needs_info:          'Needs info',
  approved_for_intake: 'Approved for intake',
  declined:            'Declined',
  withdrawn:           'Withdrawn',
}

const STATUS_COLORS: Record<string, string> = {
  submitted:           'bg-blue-100 text-blue-700',
  under_review:        'bg-purple-100 text-purple-700',
  needs_info:          'bg-yellow-100 text-yellow-700',
  approved_for_intake: 'bg-green-100 text-green-700',
  declined:            'bg-red-100 text-red-700',
  withdrawn:           'bg-gray-100 text-gray-500',
}

const SALE_TYPE_LABELS: Record<string, string> = {
  consignment: 'Consign with us',
  buyout:      'Sell outright',
  unsure:      'Not sure yet',
}

const CONDITION_LABELS: Record<string, string> = {
  mint:      'Mint',
  near_mint: 'Near Mint',
  good:      'Good',
  fair:      'Fair',
  poor:      'Poor',
  damaged:   'Damaged',
}

const CARDED_LOOSE_LABELS: Record<string, string> = {
  carded: 'Carded',
  loose:  'Loose',
}

const PHOTO_TYPE_LABELS: Record<string, string> = {
  front:  'Front',
  back:   'Back',
  detail: 'Detail',
  other:  'Other',
}

const TERMINAL_STATUSES = new Set(['withdrawn'])

export default async function AdminSellerSubmissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const submission = await prisma.sellerSubmission.findUnique({
    where: { id },
    select: {
      id:                 true,
      status:             true,
      brand:              true,
      name:               true,
      series:             true,
      year:               true,
      color:              true,
      scale:              true,
      cardedOrLoose:      true,
      condition:          true,
      conditionNotes:     true,
      quantity:           true,
      saleTypePreference: true,
      expectedPrice:      true,
      userNotes:          true,
      userMessage:        true,
      adminNotes:         true,
      reviewedAt:         true,
      createdAt:          true,
      updatedAt:          true,
      collectionItemId:   true,
      catalogId:          true,
      profile: { select: { id: true, name: true, email: true } },
      catalog: { select: { brand: true, name: true } },
      collectionItem: {
        select: {
          id: true,
          photos: {
            select: { id: true, url: true, type: true, sortOrder: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  })
  if (!submission) notFound()

  const itemTitle =
    [submission.brand, submission.name].filter(Boolean).join(' ') || 'Untitled item'
  const customerLabel = submission.profile.name ?? submission.profile.email
  const photos = submission.collectionItem?.photos ?? []
  const isTerminal = TERMINAL_STATUSES.has(submission.status)

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link
          href="/admin/seller-submissions"
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          ← Sell Requests
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Sell request</h1>
        <span
          className={`mt-1 shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
            STATUS_COLORS[submission.status] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {STATUS_LABELS[submission.status] ?? submission.status}
        </span>
      </div>
      <p className="text-base text-gray-600 mb-1">{itemTitle}</p>
      <p className="text-xs text-gray-400 mb-6">
        Submitted {submission.createdAt.toLocaleDateString()}
        {submission.updatedAt > submission.createdAt &&
          ` · Updated ${submission.updatedAt.toLocaleDateString()}`}
        {submission.reviewedAt &&
          ` · Reviewed ${submission.reviewedAt.toLocaleDateString()}`}
      </p>

      {/* Customer */}
      <div className="mb-6 rounded-md border border-gray-200 bg-gray-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Customer</p>
        <Link
          href={`/admin/customers/${submission.profile.id}`}
          className="text-sm font-medium text-gray-900 hover:underline"
        >
          {customerLabel}
        </Link>
        {submission.profile.name && (
          <p className="text-xs text-gray-500">{submission.profile.email}</p>
        )}
        {submission.collectionItemId ? (
          <p className="mt-2 text-xs text-gray-400">
            Collection item:{' '}
            <span className="font-mono text-gray-600">{submission.collectionItemId}</span>
          </p>
        ) : (
          <p className="mt-2 text-xs text-gray-500 italic">
            This request was submitted manually and is not linked to a collection item.
          </p>
        )}
        {submission.catalogId && submission.catalog && (
          <p className="mt-1 text-xs text-gray-400">
            Catalog match:{' '}
            <Link
              href={`/admin/catalog/${submission.catalogId}`}
              className="text-gray-600 hover:underline"
            >
              {submission.catalog.brand} {submission.catalog.name}
            </Link>
          </p>
        )}
      </div>

      {/* Item snapshot */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Item details (snapshot)</h2>
        <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
          <dl className="space-y-2 text-sm">
            {submission.brand && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Brand</dt>
                <dd className="text-gray-900">{submission.brand}</dd>
              </div>
            )}
            {submission.name && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Model</dt>
                <dd className="text-gray-900">{submission.name}</dd>
              </div>
            )}
            {submission.year && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Year</dt>
                <dd className="text-gray-900">{submission.year}</dd>
              </div>
            )}
            {submission.series && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Series</dt>
                <dd className="text-gray-900">{submission.series}</dd>
              </div>
            )}
            {submission.color && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Color</dt>
                <dd className="text-gray-900">{submission.color}</dd>
              </div>
            )}
            {submission.scale && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Scale</dt>
                <dd className="text-gray-900">{submission.scale}</dd>
              </div>
            )}
            {submission.cardedOrLoose && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Type</dt>
                <dd className="text-gray-900">
                  {CARDED_LOOSE_LABELS[submission.cardedOrLoose] ?? submission.cardedOrLoose}
                </dd>
              </div>
            )}
            {submission.condition && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Condition</dt>
                <dd className="text-gray-900">
                  {CONDITION_LABELS[submission.condition] ?? submission.condition}
                </dd>
              </div>
            )}
            {submission.conditionNotes && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Condition notes</dt>
                <dd className="text-gray-900">{submission.conditionNotes}</dd>
              </div>
            )}
            <div className="flex gap-3">
              <dt className="text-gray-500 w-32 shrink-0">Quantity</dt>
              <dd className="text-gray-900">{submission.quantity}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Sale preferences */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Sale preferences</h2>
        <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
          <dl className="space-y-2 text-sm">
            {submission.saleTypePreference && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Sale type</dt>
                <dd className="text-gray-900">
                  {SALE_TYPE_LABELS[submission.saleTypePreference] ?? submission.saleTypePreference}
                </dd>
              </div>
            )}
            {submission.expectedPrice != null && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Expected price</dt>
                <dd className="text-gray-900">${submission.expectedPrice.toFixed(2)}</dd>
              </div>
            )}
            {submission.userNotes && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-32 shrink-0">Seller notes</dt>
                <dd className="text-gray-900 whitespace-pre-wrap">{submission.userNotes}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Private collection photos — admin review only */}
      {photos.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Collection photos</h2>
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
            User&apos;s private collection photos — admin review only. Do not share or copy.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {photos.map((photo) => (
              <div
                key={photo.id}
                className="rounded-md border border-gray-200 bg-gray-50 overflow-hidden"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={PHOTO_TYPE_LABELS[photo.type] ?? photo.type}
                  className="w-full aspect-square object-cover"
                />
                <p className="px-2 py-1 text-xs text-gray-500">
                  {PHOTO_TYPE_LABELS[photo.type] ?? photo.type}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Admin review */}
      <div className="pt-6 border-t border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Admin review</h2>
        {isTerminal ? (
          <div className="space-y-4 text-sm">
            <p className="text-gray-500">
              This request has been withdrawn by the seller and cannot be updated.
            </p>
            {submission.adminNotes && (
              <div>
                <p className="font-medium text-gray-700 mb-1">Admin notes</p>
                <p className="text-gray-600 whitespace-pre-wrap">{submission.adminNotes}</p>
              </div>
            )}
            {submission.userMessage && (
              <div>
                <p className="font-medium text-gray-700 mb-1">Message to seller</p>
                <p className="text-gray-600 whitespace-pre-wrap">{submission.userMessage}</p>
              </div>
            )}
          </div>
        ) : (
          <SellerSubmissionStatusForm
            submissionId={submission.id}
            currentStatus={submission.status}
            currentAdminNotes={submission.adminNotes}
            currentUserMessage={submission.userMessage}
          />
        )}
      </div>
    </div>
  )
}
