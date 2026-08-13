import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getPortfolioDetail, getPortfolioItemsPage, getPortfolioActivity } from '@/lib/sellerPortfolioQuery'
import {
  UpdateAcceptedCountForm,
  AddSubmissionForm,
  CancelPortfolioForm,
  CompletePortfolioForm,
} from '@/components/admin/PortfolioActionForms'

export const dynamic = 'force-dynamic'

const STAGE_LABELS: Record<string, string> = {
  awaiting_agreement: 'Awaiting agreement',
  awaiting_shipment: 'Awaiting shipment',
  inbound: 'Inbound',
  intake: 'Intake',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

function pctLabel(bps: number): string {
  const pct = bps / 100
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`
}

export default async function SellerPortfolioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const detail = await getPortfolioDetail(id)
  if (!detail) notFound()

  const [candidateSubmissions, itemsPage, activity] = await Promise.all([
    prisma.sellerSubmission.findMany({
      where: { sellerPortfolioId: null, profile: { sellerProfile: { id: detail.sellerProfileId } } },
      select: { id: true, brand: true, name: true, quantity: true },
      take: 20,
    }),
    getPortfolioItemsPage(id, null),
    getPortfolioActivity(id),
  ])

  const candidates = candidateSubmissions.map((s) => ({
    id: s.id,
    label: `${[s.brand, s.name].filter(Boolean).join(' ') || 'Untitled'} (qty ${s.quantity})`,
  }))

  const commissionBps = detail.currentAgreement?.commissionPercent
    ? Math.round(parseFloat(detail.currentAgreement.commissionPercent) * 10_000)
    : null

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <Link href="/admin/seller-portfolios" className="text-sm text-gray-500 hover:text-gray-900">
          ← Seller Portfolios
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-2xl font-bold text-gray-900">{detail.name ?? `Portfolio ${detail.id.slice(0, 8)}`}</h1>
        <span className="mt-1 shrink-0 inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
          {STAGE_LABELS[detail.stage] ?? detail.stage}
        </span>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Seller: <Link href={`/admin/seller-profiles/${detail.sellerProfileId}`} className="hover:underline text-gray-700">{detail.sellerLabel}</Link>
      </p>

      {detail.statusMismatch && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This portfolio is marked completed, but current data no longer supports that — shown stage reflects actual state.
        </div>
      )}

      {detail.attentionSignals.length > 0 && (
        <div className="mb-6 space-y-2">
          {detail.attentionSignals.map((s) => (
            <div
              key={s.code}
              className={`rounded-md border px-3 py-2 text-xs ${s.severity === 'critical' ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
            >
              {s.severity === 'critical' && <span className="font-semibold">Critical: </span>}
              {s.message}
            </div>
          ))}
        </div>
      )}

      {/* Overview counts */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ['Submitted', detail.counts.submitted],
            [detail.currentAgreement?.status === 'accepted' ? 'Agreed quantity' : 'Accepted (pre-agreement)', detail.counts.accepted ?? '—'],
            ['Expected inbound', detail.counts.expectedInbound],
            ['Received', detail.counts.received],
            ['Intake complete', detail.counts.intakeComplete],
            ['Available', detail.counts.available],
            ['Listed', detail.counts.listed],
            ['Reserved', detail.counts.reserved],
            ['Sold', detail.counts.sold],
            ['Exceptions', detail.counts.exceptions],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-md border border-gray-200 bg-white p-3">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="text-lg font-semibold text-gray-900 tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-400">
          &quot;Listed&quot; is a subset of &quot;Available&quot; (items with an active listing). Counts are not summed into a combined total.
        </p>
      </section>

      {/* Agreement */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Agreement</h2>
        {detail.currentAgreement ? (
          <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm space-y-1">
            <p><span className="text-gray-500">Status:</span> <span className="font-medium text-gray-900">{detail.currentAgreement.status}</span></p>
            {commissionBps !== null && <p><span className="text-gray-500">Commission:</span> {pctLabel(commissionBps)}</p>}
            {detail.currentAgreement.commissionMinimumFee && (
              <p><span className="text-gray-500">Minimum fee:</span> ${parseFloat(detail.currentAgreement.commissionMinimumFee).toFixed(2)}/item</p>
            )}
            {detail.currentAgreement.status === 'accepted' ? (
              <>
                <p><span className="text-gray-500">Agreed quantity (signed, immutable):</span> <span className="font-medium text-gray-900">{detail.currentAgreement.acceptedItemCount ?? '—'}</span></p>
                {detail.currentAgreement.acceptedItemCount !== null && (
                  <p>
                    <span className="text-gray-500">Received:</span> {detail.counts.received}
                    {' · '}
                    <span className="text-gray-500">Variance:</span>{' '}
                    <span className={detail.counts.received !== detail.currentAgreement.acceptedItemCount ? 'font-medium text-amber-700' : 'text-gray-700'}>
                      {detail.counts.received - detail.currentAgreement.acceptedItemCount >= 0 ? '+' : ''}
                      {detail.counts.received - detail.currentAgreement.acceptedItemCount}
                    </span>
                  </p>
                )}
                <p className="text-xs text-gray-400">
                  Physical variance from the signed quantity is operational only — it never changes the commission tier already locked in at acceptance.
                </p>
              </>
            ) : (
              <p><span className="text-gray-500">Accepted items (pre-agreement, editable below):</span> {detail.currentAgreement.acceptedItemCount ?? '—'}</p>
            )}
            {detail.currentAgreement.commissionExplanation && (
              <p className="text-xs text-gray-500 mt-1">{detail.currentAgreement.commissionExplanation}</p>
            )}
            <Link
              href={`/admin/seller-submissions/${detail.currentAgreement.submissionId}/agreement`}
              className="inline-block mt-2 text-xs text-blue-600 hover:underline"
            >
              Manage agreement →
            </Link>
          </div>
        ) : (
          <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
            No commercial agreement yet.
            {detail.submissions[0] && (
              <Link
                href={`/admin/seller-submissions/${detail.submissions[0].id}/agreement`}
                className="ml-1 text-blue-600 hover:underline"
              >
                Create one →
              </Link>
            )}
          </div>
        )}

        {detail.currentAgreement?.status === 'accepted' ? (
          <p className="mt-3 text-xs text-gray-400">
            The accepted quantity is locked now that the agreement is signed — this can no longer be edited here.
            Use the &quot;Received&quot; / &quot;Variance&quot; figures above to track physical discrepancies instead.
          </p>
        ) : (
          <div className="mt-3">
            <p className="text-xs text-gray-500 mb-1">
              Portfolio accepted quantity — the volume-tier denominator used by the agreement preview before acceptance.
            </p>
            <UpdateAcceptedCountForm portfolioId={detail.id} defaultValue={detail.portfolioAcceptedItemCount} />
          </div>
        )}
      </section>

      {/* Submissions */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Submissions ({detail.submissions.length})</h2>
        <div className="space-y-2 mb-3">
          {detail.submissions.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
              <Link href={`/admin/seller-submissions/${s.id}`} className="text-gray-900 hover:underline">
                {[s.brand, s.name].filter(Boolean).join(' ') || 'Untitled'}
              </Link>
              <span className="text-gray-500">qty {s.quantity} · {s.status}</span>
            </div>
          ))}
        </div>
        <AddSubmissionForm portfolioId={detail.id} candidates={candidates} />
      </section>

      {/* Shipments */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Shipments ({detail.shipments.length})</h2>
        {detail.shipments.length === 0 ? (
          <p className="text-sm text-gray-500">
            No inbound shipments recorded yet.
            {detail.submissions[0] && (
              <Link href={`/admin/seller-submissions/${detail.submissions[0].id}`} className="ml-1 text-blue-600 hover:underline">
                View submission →
              </Link>
            )}
          </p>
        ) : (
          <div className="space-y-2">
            {detail.shipments.map((s) => (
              <div key={s.id} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm flex flex-wrap gap-x-4 gap-y-1">
                <span className="font-medium text-gray-900">{s.status}</span>
                {s.carrier && <span className="text-gray-500">{s.carrier} {s.trackingNumber}</span>}
                <span className="text-gray-500">Expected {s.expectedQuantity}</span>
                <span className="text-gray-500">Received {s.receivedQuantity ?? '—'}</span>
                {s.shippedAt && <span className="text-gray-400 text-xs">Shipped {s.shippedAt.toLocaleDateString()}</span>}
                {s.receivedAt && <span className="text-gray-400 text-xs">Received {s.receivedAt.toLocaleDateString()}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 15D: Start/Continue Intake — one obvious action per receivable shipment. The
          workbench reads seller/portfolio/agreement/commission/shipment context
          directly from the shipment id, no re-entry needed. */}
      {detail.currentAgreement?.status === 'accepted' && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Intake</h2>
          {detail.shipments.filter((s) => s.status === 'received' || s.status === 'issue').length === 0 ? (
            <p className="text-sm text-gray-500">
              No received shipment yet — the workbench opens once a shipment is marked received.
            </p>
          ) : (
            <div className="space-y-2">
              {detail.shipments
                .filter((s) => s.status === 'received' || s.status === 'issue')
                .map((s) => (
                  <div key={s.id} className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm flex items-center justify-between gap-3">
                    <span className="text-gray-600">
                      {s.trackingNumber ?? s.id} · received {s.receivedQuantity ?? '—'}
                      {s.status === 'issue' && <span className="ml-2 text-amber-700">(issue noted)</span>}
                    </span>
                    <Link
                      href={`/admin/intake/workbench/${s.id}`}
                      className="inline-block rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Start / Continue Intake →
                    </Link>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      {/* Items */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Items</h2>
        {itemsPage.items.length === 0 ? (
          <p className="text-sm text-gray-500">No inventory created from this portfolio yet.</p>
        ) : (
          <div className="rounded-md border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-2 font-medium">SKU</th>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Listing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {itemsPage.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-4 py-2">
                      <Link href={`/admin/items/${i.id}`} className="font-mono text-xs text-indigo-700 hover:underline">{i.sku}</Link>
                    </td>
                    <td className="px-4 py-2 text-gray-700">{i.brand} {i.name}</td>
                    <td className="px-4 py-2 text-gray-500">{i.status}</td>
                    <td className="px-4 py-2 text-gray-500">{i.listingStatus ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {itemsPage.nextCursor && (
          <p className="mt-2 text-xs text-gray-400">Showing first {itemsPage.items.length} items — see /admin/items for the full list.</p>
        )}
      </section>

      {/* Sales & Payouts */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Sales &amp; Payouts</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Metric label="Completed sales (GMV)" value={`$${detail.financial.completedSalesGmv.toFixed(2)}`} sub={`${detail.financial.completedSalesCount} sale(s)`} />
          <Metric label="Seller proceeds" value={`$${detail.financial.sellerProceeds.toFixed(2)}`} />
          <Metric label="Gross spread (commission)" value={`$${detail.financial.grossSpread.toFixed(2)}`} sub="Not profit — commission withheld" />
          <Metric label="Outstanding payout" value={`$${detail.financial.outstandingPayout.toFixed(2)}`} />
          <Metric label="Paid payout" value={`$${detail.financial.paidPayout.toFixed(2)}`} />
        </div>
      </section>

      {/* Activity */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Activity</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-gray-500">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-2">
            {activity.map((a, idx) => (
              <li key={idx} className="text-sm border-l-2 border-gray-200 pl-3">
                <p className="text-gray-900">{a.title}</p>
                {a.description && <p className="text-xs text-gray-500">{a.description}</p>}
                <p className="text-xs text-gray-400">{a.occurredAt.toLocaleString()}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Actions */}
      <section className="pt-6 border-t border-gray-200 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Portfolio actions</h2>
        {detail.status !== 'cancelled' && detail.status !== 'completed' && (
          <div className="flex flex-wrap gap-4">
            <CompletePortfolioForm portfolioId={detail.id} />
            <CancelPortfolioForm portfolioId={detail.id} />
          </div>
        )}
        {detail.status === 'cancelled' && <p className="text-sm text-gray-500">This portfolio is cancelled.</p>}
        {detail.status === 'completed' && <p className="text-sm text-gray-500">This portfolio is completed.</p>}
      </section>
    </div>
  )
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-gray-900 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  )
}
