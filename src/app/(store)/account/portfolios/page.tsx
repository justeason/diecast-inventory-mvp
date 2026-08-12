import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { listMySellerPortfolios } from '@/lib/sellerPortfolioQuery'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My Portfolios | CollectNTrades',
  robots: { index: false, follow: false },
}

const STAGE_LABELS: Record<string, string> = {
  awaiting_agreement: 'Awaiting agreement',
  awaiting_shipment: 'Awaiting shipment',
  inbound: 'Inbound',
  intake: 'Intake',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export default async function MyPortfoliosPage() {
  const session = await getBuyerSession()
  if (!session) {
    return (
      <div className="max-w-lg">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">My Portfolios</h1>
        <p className="text-sm text-gray-500">Sign in to view your consignment portfolios.</p>
      </div>
    )
  }

  const portfolios = await listMySellerPortfolios(session.profileId)

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">My Portfolios</h1>
      {portfolios.length === 0 ? (
        <p className="text-sm text-gray-500">You don&apos;t have any consignment portfolios yet.</p>
      ) : (
        <div className="space-y-3">
          {portfolios.map((p) => (
            <Link
              key={p.id}
              href={`/account/portfolios/${p.id}`}
              className="block rounded-md border border-gray-200 bg-white p-4 hover:border-gray-300"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-gray-900">{p.name ?? `Portfolio ${p.id.slice(0, 8)}`}</span>
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                  {STAGE_LABELS[p.stage] ?? p.stage}
                </span>
              </div>
              <p className="text-xs text-gray-500">
                Submitted {p.submitted}{p.accepted !== null ? ` · Accepted ${p.accepted}` : ''}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
