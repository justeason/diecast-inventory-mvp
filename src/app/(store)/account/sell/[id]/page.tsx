import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { WithdrawForm } from '@/components/store/WithdrawForm'
import { SellerSubmissionPhotoUpload } from '@/components/store/SellerSubmissionPhotoUpload'
import {
  AGREEMENT_TYPE_LABELS,
  AGREEMENT_STATUS_LABELS,
  AGREEMENT_STATUS_COLORS,
  formatAmount,
  formatCommissionDisplay,
} from '@/lib/sellerAgreementDisplay'
import { deriveSellerFacingPayoutStatus } from '@/lib/sellerPayoutCalculation'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sell Request | CollectNTrades',
  robots: { index: false, follow: false },
}

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

const WITHDRAWABLE_STATUSES = ['submitted', 'needs_info']

export default async function SellRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getBuyerSession()
  if (!session) notFound()

  const submission = await prisma.sellerSubmission.findFirst({
    where: { id, profileId: session.profileId },
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
      collectionItemId:   true,
      createdAt:          true,
      updatedAt:          true,
      photos: {
        select: { id: true, url: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
      agreements: {
        where: { status: { in: ['proposed', 'accepted', 'cancelled'] } },
        select: {
          id: true,
          type: true,
          status: true,
          agreedBuyoutAmount: true,
          commissionPercent: true,
          fixedFee: true,
          minimumSellerPayout: true,
          agreedListPrice: true,
          sellerTermsSummary: true,
          proposedAt: true,
          acceptedAt: true,
          cancelledAt: true,
          payoutLines: {
            select: {
              id: true,
              lineType: true,
              status: true,
              netAmount: true,
              eligibleAt: true,
              payout: { select: { status: true, approvedAt: true, paidAt: true } },
            },
            orderBy: { eligibleAt: 'asc' as const },
          },
        },
        orderBy: { createdAt: 'desc' as const },
      },
    },
  })
  if (!submission) notFound()

  const canWithdraw = WITHDRAWABLE_STATUSES.includes(submission.status)

  // Active agreement: most recent proposed or accepted (never draft).
  const activeAgreement =
    submission.agreements.find((a) => a.status === 'proposed' || a.status === 'accepted') ?? null

  // Fallback: most recent cancelled agreement that was previously presented
  // (proposedAt or acceptedAt set — i.e. not cancelled before the seller ever saw it).
  const cancelledAgreement =
    activeAgreement
      ? null
      : submission.agreements.find(
          (a) => a.status === 'cancelled' && (a.proposedAt !== null || a.acceptedAt !== null),
        ) ?? null

  const sellerAgreement = activeAgreement ?? cancelledAgreement
  const isUnderReview = submission.status === 'under_review'
  const canEditPhotos = ['submitted', 'needs_info'].includes(submission.status)
  const showUserMessage =
    !!submission.userMessage &&
    ['needs_info', 'declined'].includes(submission.status)

  const itemTitle =
    [submission.brand, submission.name].filter(Boolean).join(' ') || 'Untitled item'

  return (
    <div className="max-w-lg">
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Link href="/account/sell" className="text-sm text-gray-500 hover:text-gray-900">
          ← Sell Requests
        </Link>
        {submission.collectionItemId && (
          <Link
            href={`/account/collection/${submission.collectionItemId}`}
            className="text-sm text-gray-500 hover:text-gray-900"
          >
            View collection item →
          </Link>
        )}
      </div>

      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Sell request</h1>
        <span
          className={`mt-1 shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[submission.status] ?? 'bg-gray-100 text-gray-600'}`}
        >
          {STATUS_LABELS[submission.status] ?? submission.status}
        </span>
      </div>
      <p className="text-base text-gray-600 mb-1">{itemTitle}</p>
      <p className="text-xs text-gray-400 mb-6">
        Submitted {submission.createdAt.toLocaleDateString()}
        {submission.updatedAt > submission.createdAt &&
          ` · Updated ${submission.updatedAt.toLocaleDateString()}`}
      </p>

      {/* User-facing message (needs_info or declined only) */}
      {showUserMessage && (
        <div
          className={`mb-6 rounded-md border px-4 py-3 text-sm ${
            submission.status === 'needs_info'
              ? 'border-yellow-200 bg-yellow-50 text-yellow-900'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <p className="font-medium mb-1">
            {submission.status === 'needs_info'
              ? 'More information needed'
              : 'Request declined'}
          </p>
          <p>{submission.userMessage}</p>
        </div>
      )}

      {/* Item snapshot */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Item details</h2>
        <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
          <dl className="space-y-2 text-sm">
            {submission.brand && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Brand</dt>
                <dd className="text-gray-900">{submission.brand}</dd>
              </div>
            )}
            {submission.name && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Model</dt>
                <dd className="text-gray-900">{submission.name}</dd>
              </div>
            )}
            {submission.year && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Year</dt>
                <dd className="text-gray-900">{submission.year}</dd>
              </div>
            )}
            {submission.series && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Series</dt>
                <dd className="text-gray-900">{submission.series}</dd>
              </div>
            )}
            {submission.color && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Color</dt>
                <dd className="text-gray-900">{submission.color}</dd>
              </div>
            )}
            {submission.scale && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Scale</dt>
                <dd className="text-gray-900">{submission.scale}</dd>
              </div>
            )}
            {submission.cardedOrLoose && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Type</dt>
                <dd className="text-gray-900">
                  {CARDED_LOOSE_LABELS[submission.cardedOrLoose] ?? submission.cardedOrLoose}
                </dd>
              </div>
            )}
            {submission.condition && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Condition</dt>
                <dd className="text-gray-900">
                  {CONDITION_LABELS[submission.condition] ?? submission.condition}
                </dd>
              </div>
            )}
            {submission.conditionNotes && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Condition notes</dt>
                <dd className="text-gray-900">{submission.conditionNotes}</dd>
              </div>
            )}
            <div className="flex gap-3">
              <dt className="text-gray-500 w-28 shrink-0">Quantity</dt>
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
                <dt className="text-gray-500 w-28 shrink-0">Sale type</dt>
                <dd className="text-gray-900">
                  {SALE_TYPE_LABELS[submission.saleTypePreference] ?? submission.saleTypePreference}
                </dd>
              </div>
            )}
            {submission.expectedPrice != null && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Expected price</dt>
                <dd className="text-gray-900">${submission.expectedPrice.toFixed(2)}</dd>
              </div>
            )}
            {submission.userNotes && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-28 shrink-0">Notes</dt>
                <dd className="text-gray-900 whitespace-pre-wrap">{submission.userNotes}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Submission photos */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Submission photos</h2>
        <p className="text-xs text-gray-500 mb-3">
          These photos are private and used only for admin review.
        </p>
        <SellerSubmissionPhotoUpload
          submissionId={submission.id}
          photos={submission.photos}
          editable={canEditPhotos}
        />
      </div>

      {/* Agreement — visible when proposed, accepted, or previously-presented cancelled */}
      {sellerAgreement && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Agreement</h2>
          <div
            className={`rounded-md border px-4 py-4 text-sm ${
              sellerAgreement.status === 'accepted'
                ? 'border-green-200 bg-green-50'
                : sellerAgreement.status === 'cancelled'
                  ? 'border-gray-200 bg-gray-50'
                  : 'border-blue-200 bg-blue-50'
            }`}
          >
            <div className="flex items-center gap-2 mb-3">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  AGREEMENT_STATUS_COLORS[sellerAgreement.status] ?? 'bg-gray-100 text-gray-600'
                }`}
              >
                {AGREEMENT_STATUS_LABELS[sellerAgreement.status] ?? sellerAgreement.status}
              </span>
              <span className="text-gray-700 text-xs">
                {AGREEMENT_TYPE_LABELS[sellerAgreement.type] ?? sellerAgreement.type}
              </span>
            </div>
            <dl className="space-y-2 text-sm">
              {sellerAgreement.type === 'buyout' && sellerAgreement.agreedBuyoutAmount && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Buyout amount</dt>
                  <dd className="text-gray-900">
                    {formatAmount(sellerAgreement.agreedBuyoutAmount.toFixed(2))}
                  </dd>
                </div>
              )}
              {sellerAgreement.type === 'consignment' && sellerAgreement.commissionPercent && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Our commission</dt>
                  <dd className="text-gray-900">
                    {formatCommissionDisplay(sellerAgreement.commissionPercent.toString())}
                  </dd>
                </div>
              )}
              {sellerAgreement.type === 'consignment' && sellerAgreement.fixedFee && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Fixed fee</dt>
                  <dd className="text-gray-900">
                    {formatAmount(sellerAgreement.fixedFee.toFixed(2))}
                  </dd>
                </div>
              )}
              {sellerAgreement.type === 'consignment' && sellerAgreement.minimumSellerPayout && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Min. payout to you</dt>
                  <dd className="text-gray-900">
                    {formatAmount(sellerAgreement.minimumSellerPayout.toFixed(2))}
                  </dd>
                </div>
              )}
              {sellerAgreement.agreedListPrice && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Agreed list price</dt>
                  <dd className="text-gray-900">
                    {formatAmount(sellerAgreement.agreedListPrice.toFixed(2))}
                  </dd>
                </div>
              )}
              {sellerAgreement.sellerTermsSummary && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Terms</dt>
                  <dd className="text-gray-900 whitespace-pre-wrap">
                    {sellerAgreement.sellerTermsSummary}
                  </dd>
                </div>
              )}
              {sellerAgreement.proposedAt && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Proposed</dt>
                  <dd className="text-gray-900">
                    {sellerAgreement.proposedAt.toLocaleDateString()}
                  </dd>
                </div>
              )}
              {sellerAgreement.acceptedAt && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Accepted</dt>
                  <dd className="text-gray-900">
                    {sellerAgreement.acceptedAt.toLocaleDateString()}
                  </dd>
                </div>
              )}
              {sellerAgreement.cancelledAt && (
                <div className="flex gap-3">
                  <dt className="text-gray-600 w-32 shrink-0">Cancelled</dt>
                  <dd className="text-gray-900">
                    {sellerAgreement.cancelledAt.toLocaleDateString()}
                  </dd>
                </div>
              )}
            </dl>
            {sellerAgreement.status === 'cancelled' && (
              <p className="mt-3 text-xs text-gray-500 border-t border-gray-200 pt-3">
                This agreement is no longer active.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Payment status — shown only when payout lines exist for the accepted/accepted agreement */}
      {(() => {
        const acceptedAgreement = submission.agreements.find((a) => a.status === 'accepted') ?? null
        if (!acceptedAgreement || acceptedAgreement.payoutLines.length === 0) return null
        return (
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment status</h2>
            <div className="space-y-2">
              {acceptedAgreement.payoutLines.map((line) => {
                const { label, description } = deriveSellerFacingPayoutStatus(
                  line.status,
                  line.payout ?? null,
                )
                const isBuyout = line.lineType === 'buyout'
                return (
                  <div
                    key={line.id}
                    className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-medium text-gray-900">
                        {isBuyout ? 'Buyout payment' : 'Consignment proceeds'}
                      </p>
                      <p className="font-mono text-gray-900">
                        ${parseFloat(line.netAmount.toString()).toFixed(2)}
                      </p>
                    </div>
                    <p className="text-xs font-medium text-gray-700 mb-0.5">{label}</p>
                    <p className="text-xs text-gray-500">{description}</p>
                    <div className="mt-2 text-xs text-gray-400 space-y-0.5">
                      {line.eligibleAt && (
                        <p>Eligible since {line.eligibleAt.toLocaleDateString()}</p>
                      )}
                      {line.payout?.approvedAt && (
                        <p>Approved {line.payout.approvedAt.toLocaleDateString()}</p>
                      )}
                      {line.payout?.paidAt && (
                        <p>Paid {line.payout.paidAt.toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Actions */}
      {canWithdraw && (
        <div className="pt-6 border-t border-gray-200">
          <p className="text-sm font-medium text-gray-700 mb-3">Withdraw request</p>
          <WithdrawForm submissionId={submission.id} />
        </div>
      )}

      {isUnderReview && (
        <div className="pt-6 border-t border-gray-200">
          <p className="text-sm text-gray-500">
            This request is currently under review. Contact us if you need to make changes.
          </p>
        </div>
      )}
    </div>
  )
}
