import { type ReactNode } from 'react'
import Link from 'next/link'

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

type ReviewPhoto = { id: string; url: string; sortOrder: number; createdAt: Date }

export type SubmissionContext = {
  id: string
  status: string
  brand: string | null
  name: string | null
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
  cardedOrLoose: string | null
  condition: string | null
  conditionNotes: string | null
  quantity: number
  saleTypePreference: string | null
  expectedPrice: number | null
  userNotes: string | null
  userMessage: string | null
  adminNotes: string | null
  createdAt: Date
  profile: { id: string; name: string | null; email: string }
  photos: ReviewPhoto[]
  collectionItem: { id: string; photos: ReviewPhoto[] } | null
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="text-gray-500 w-36 shrink-0 text-sm">{label}</dt>
      <dd className="text-gray-900 text-sm">{children}</dd>
    </div>
  )
}

export function SellerSubmissionIntakeContext({ submission }: { submission: SubmissionContext }) {
  const itemTitle =
    [submission.brand, submission.name].filter(Boolean).join(' ') || 'Untitled item'
  const customerLabel = submission.profile.name ?? submission.profile.email
  const collectionPhotos = submission.collectionItem?.photos ?? []

  return (
    <div className="mb-8 rounded-md border border-gray-200 bg-white">
      {/* Panel header + navigation */}
      <div className="px-5 pt-4 pb-3 border-b border-gray-200 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-gray-900">Seller submission context</h2>
        <Link
          href={`/admin/seller-submissions/${submission.id}`}
          className="text-xs text-gray-500 hover:text-gray-900 hover:underline whitespace-nowrap"
        >
          View seller submission →
        </Link>
      </div>

      <div className="p-5 space-y-6">
        {/* Primary unverified warning */}
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
          Seller-provided information and photos are unverified. Confirm all item details and upload
          new physical intake photos before review or conversion.
        </p>

        {/* Submission summary */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
            Submission summary
          </p>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-4">
            <dl className="space-y-2">
              <InfoRow label="Status">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    STATUS_COLORS[submission.status] ?? 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {STATUS_LABELS[submission.status] ?? submission.status}
                </span>
              </InfoRow>

              <InfoRow label="Seller">
                <Link
                  href={`/admin/customers/${submission.profile.id}`}
                  className="hover:underline"
                >
                  {customerLabel}
                </Link>
                {submission.profile.name && (
                  <span className="ml-1 text-gray-500">({submission.profile.email})</span>
                )}
              </InfoRow>

              <InfoRow label="Submitted">
                {submission.createdAt.toLocaleDateString()}
              </InfoRow>

              <InfoRow label="Item">{itemTitle}</InfoRow>

              {submission.series && <InfoRow label="Series">{submission.series}</InfoRow>}
              {submission.year && <InfoRow label="Year">{submission.year}</InfoRow>}
              {submission.color && <InfoRow label="Color">{submission.color}</InfoRow>}
              {submission.scale && <InfoRow label="Scale">{submission.scale}</InfoRow>}

              {submission.cardedOrLoose && (
                <InfoRow label="Type">
                  {CARDED_LOOSE_LABELS[submission.cardedOrLoose] ?? submission.cardedOrLoose}
                </InfoRow>
              )}

              {submission.condition && (
                <InfoRow label="Condition">
                  {CONDITION_LABELS[submission.condition] ?? submission.condition}
                </InfoRow>
              )}

              {submission.conditionNotes && (
                <InfoRow label="Condition notes">{submission.conditionNotes}</InfoRow>
              )}

              <InfoRow label="Quantity">{submission.quantity}</InfoRow>

              {submission.saleTypePreference && (
                <InfoRow label="Sale preference">
                  {SALE_TYPE_LABELS[submission.saleTypePreference] ??
                    submission.saleTypePreference}
                </InfoRow>
              )}

              {submission.expectedPrice != null && (
                <InfoRow label="Expected price">
                  <span>${submission.expectedPrice.toFixed(2)}</span>
                  <span className="ml-2 text-xs text-amber-700">
                    Seller expectation only. This is not the inventory cost or public listing
                    price.
                  </span>
                </InfoRow>
              )}

              {submission.userNotes && (
                <InfoRow label="Seller notes">
                  <span className="whitespace-pre-wrap">{submission.userNotes}</span>
                </InfoRow>
              )}

              {submission.userMessage && (
                <InfoRow label="Message to seller">
                  <span className="whitespace-pre-wrap">{submission.userMessage}</span>
                </InfoRow>
              )}

              {submission.adminNotes && (
                <InfoRow label="Internal admin notes">
                  <span className="whitespace-pre-wrap">{submission.adminNotes}</span>
                </InfoRow>
              )}
            </dl>
          </div>
        </div>

        {/* Submission photos — private review only */}
        {submission.photos.length > 0 && (
          <div>
            <p className="text-sm font-semibold text-gray-900 mb-1">
              Submission photos — private review only
            </p>
            <p className="text-xs text-gray-500 mb-3">
              These photos were uploaded for the sell request. They are not verified intake or
              inventory photos.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {submission.photos.map((photo) => (
                <div
                  key={photo.id}
                  className="rounded-md border border-gray-200 bg-gray-50 overflow-hidden"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.url}
                    alt="Submission photo"
                    loading="lazy"
                    className="w-full aspect-square object-cover"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Collection photos — private review only */}
        {collectionPhotos.length > 0 && (
          <div>
            <p className="text-sm font-semibold text-gray-900 mb-1">
              Collection photos — private review only
            </p>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
              These are private collection photos and must not be used as intake, inventory,
              listing, or catalog photos automatically.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {collectionPhotos.map((photo) => (
                <div
                  key={photo.id}
                  className="rounded-md border border-gray-200 bg-gray-50 overflow-hidden"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.url}
                    alt="Collection photo"
                    loading="lazy"
                    className="w-full aspect-square object-cover"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Verified intake photo boundary note */}
        <p className="text-xs text-gray-400 italic">
          To create verified inventory photos, upload new front and back photos through the intake
          photo section below.
        </p>
      </div>
    </div>
  )
}
