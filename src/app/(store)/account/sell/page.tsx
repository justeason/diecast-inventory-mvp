import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sell Requests | CollectNTrades',
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

function submissionTitle(s: { brand: string | null; name: string | null }): string {
  const parts = [s.brand, s.name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Untitled item'
}

export default async function SellRequestsPage() {
  const session = await getBuyerSession()
  if (!session) notFound()

  const submissions = await prisma.sellerSubmission.findMany({
    where: { profileId: session.profileId },
    orderBy: { createdAt: 'desc' },
    select: {
      id:                 true,
      brand:              true,
      name:               true,
      status:             true,
      saleTypePreference: true,
      expectedPrice:      true,
      quantity:           true,
      userNotes:          true,
      createdAt:          true,
    },
  })

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sell Requests</h1>
          <p className="text-sm text-gray-500 mt-1">
            {submissions.length} request{submissions.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          href="/account/collection"
          className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          My Collection
        </Link>
      </div>

      {submissions.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 px-6 py-10 text-center">
          <p className="text-sm text-gray-500 mb-4">
            You have not submitted any sell requests yet.
          </p>
          <Link
            href="/account/collection"
            className="text-sm font-medium text-gray-900 hover:underline underline-offset-2"
          >
            Go to My Collection →
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {submissions.map((sub) => (
            <Link
              key={sub.id}
              href={`/account/sell/${sub.id}`}
              className="block rounded-md border border-gray-200 bg-white px-4 py-4 hover:border-gray-300 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900 truncate">
                    {submissionTitle(sub)}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 mt-1.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[sub.status] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {STATUS_LABELS[sub.status] ?? sub.status}
                    </span>
                    {sub.saleTypePreference && (
                      <span className="text-xs text-gray-500">
                        {SALE_TYPE_LABELS[sub.saleTypePreference] ?? sub.saleTypePreference}
                      </span>
                    )}
                    {sub.expectedPrice != null && (
                      <span className="text-xs text-gray-500">
                        ${sub.expectedPrice.toFixed(2)}
                      </span>
                    )}
                    {sub.quantity > 1 && (
                      <span className="text-xs text-gray-400">×{sub.quantity}</span>
                    )}
                  </div>
                  {sub.userNotes && (
                    <p className="text-xs text-gray-400 mt-1.5 truncate">{sub.userNotes}</p>
                  )}
                </div>
                <p className="text-xs text-gray-400 shrink-0 mt-0.5">
                  {sub.createdAt.toLocaleDateString()}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
