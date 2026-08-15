import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { SHIPMENT_STATUS_LABELS } from '@/lib/sellerInboundShipmentConstants'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  shipped: 'bg-blue-100 text-blue-700',
  received: 'bg-green-100 text-green-700',
  issue: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-400',
}

const VALID_STATUSES = new Set(['draft', 'shipped', 'received', 'issue', 'cancelled'])

// 15H: Operations > Inbound Shipments — a read-only bounded list (take 50 + keyset
// cursor), the piece the prior IA never surfaced as a standalone page (shipments
// were only reachable one at a time, from a portfolio or submission detail). Links
// out to the existing authoritative workbench/portfolio/submission pages — no new
// business logic.
export default async function InboundShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>
}) {
  const { status: rawStatus, cursor } = await searchParams
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : ''

  const shipments = await prisma.sellerInboundShipment.findMany({
    where: status ? { status } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true,
      status: true,
      carrier: true,
      trackingNumber: true,
      expectedQuantity: true,
      receivedQuantity: true,
      createdAt: true,
      receivedAt: true,
      sellerSubmissionId: true,
      sellerPortfolio: { select: { id: true, name: true } },
      sellerSubmission: { select: { profile: { select: { sellerProfile: { select: { displayName: true } } } } } },
    },
  })

  const hasMore = shipments.length > PAGE_SIZE
  const page = hasMore ? shipments.slice(0, PAGE_SIZE) : shipments

  const hrefFor = (s: { id?: string; status?: string }) => {
    const p = new URLSearchParams()
    if (s.status !== undefined ? s.status : status) p.set('status', s.status !== undefined ? s.status : status)
    if (s.id) p.set('cursor', s.id)
    return `/admin/intake/inbound${p.size ? '?' + p.toString() : ''}`
  }

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/intake" className="text-sm text-gray-500 hover:text-gray-900">← Back to Intake</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Inbound Shipments</h1>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <Link
          href="/admin/intake/inbound"
          className={`px-3 py-1.5 rounded-md text-sm border ${!status ? 'border-gray-900 text-gray-900' : 'border-gray-200 text-gray-500 hover:text-gray-900'}`}
        >
          All
        </Link>
        {Object.entries(SHIPMENT_STATUS_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={hrefFor({ status: key })}
            className={`px-3 py-1.5 rounded-md text-sm border ${status === key ? 'border-gray-900 text-gray-900' : 'border-gray-200 text-gray-500 hover:text-gray-900'}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {page.length === 0 ? (
        <p className="text-sm text-gray-500">No shipments found.</p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Seller / Portfolio</th>
                <th className="px-4 py-3 font-medium">Tracking</th>
                <th className="px-4 py-3 font-medium">Qty (exp / recv)</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {page.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[s.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {SHIPMENT_STATUS_LABELS[s.status] ?? s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    {s.sellerPortfolio ? (
                      <Link href={`/admin/seller-portfolios/${s.sellerPortfolio.id}`} className="hover:underline">
                        {s.sellerPortfolio.name ?? s.sellerPortfolio.id}
                      </Link>
                    ) : (
                      s.sellerSubmission?.profile?.sellerProfile?.displayName ?? '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {[s.carrier, s.trackingNumber].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-700 font-mono text-xs">
                    {s.expectedQuantity} / {s.receivedQuantity ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{s.createdAt.toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    {(s.status === 'received' || s.status === 'issue') ? (
                      <Link href={`/admin/intake/workbench/${s.id}`} className="text-sm font-medium text-blue-600 hover:underline">
                        Start / Continue Intake →
                      </Link>
                    ) : s.sellerSubmissionId ? (
                      <Link href={`/admin/seller-submissions/${s.sellerSubmissionId}`} className="text-sm text-gray-600 hover:text-gray-900">
                        Submission →
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="mt-4">
          <Link href={hrefFor({ id: page[page.length - 1].id })} className="text-sm text-blue-600 hover:underline">
            Next →
          </Link>
        </div>
      )}
    </>
  )
}
