import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { getSellerPortfolioView } from '@/lib/sellerPortfolioQuery'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Portfolio | CollectNTrades',
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

function pctLabel(percent: string): string {
  const pct = parseFloat(percent) * 100
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`
}

export default async function MyPortfolioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getBuyerSession()
  if (!session) notFound()

  // Ownership enforced inside the query (WHERE sellerProfile.profile.id = profileId)
  // — a wrong/guessed id for another seller's portfolio returns null, never leaked.
  const view = await getSellerPortfolioView(id, session.profileId)
  if (!view) notFound()

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link href="/account/portfolios" className="text-sm text-gray-500 hover:text-gray-900">
          ← My Portfolios
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{view.name ?? `Portfolio ${view.id.slice(0, 8)}`}</h1>
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
          {STAGE_LABELS[view.stage] ?? view.stage}
        </span>
      </div>

      <div className="rounded-md border border-gray-200 bg-gray-50 p-4 mb-6">
        <dl className="space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Agreement</dt>
            <dd className="text-gray-900">{view.agreementStatus ?? 'Not yet created'}</dd>
          </div>
          {view.commissionPercent && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-40 shrink-0">Commission</dt>
              <dd className="text-gray-900">{pctLabel(view.commissionPercent)}</dd>
            </div>
          )}
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Items accepted</dt>
            <dd className="text-gray-900">{view.acceptedItemCount ?? '—'}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Items received</dt>
            <dd className="text-gray-900">{view.receivedCount}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Items listed</dt>
            <dd className="text-gray-900">{view.listedCount}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Items sold</dt>
            <dd className="text-gray-900">{view.soldCount}</dd>
          </div>
        </dl>
      </div>

      {view.shipments.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Shipment status</h2>
          <div className="space-y-2">
            {view.shipments.map((s, idx) => (
              <div key={idx} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
                <span className="font-medium text-gray-900">{s.status}</span>
                <span className="text-gray-500 ml-2">Expected {s.expectedQuantity}{s.receivedQuantity !== null ? ` · Received ${s.receivedQuantity}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Proceeds &amp; payout</h2>
        <dl className="space-y-2 text-sm rounded-md border border-gray-200 bg-gray-50 p-4">
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Seller proceeds</dt>
            <dd className="text-gray-900">${view.sellerProceeds.toFixed(2)}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Outstanding payout</dt>
            <dd className="text-gray-900">${view.outstandingPayout.toFixed(2)}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-40 shrink-0">Paid</dt>
            <dd className="text-gray-900">${view.paidPayout.toFixed(2)}</dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
