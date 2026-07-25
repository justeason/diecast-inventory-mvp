import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { CreatePayoutForm, ReleaseLineForm, VoidLineForm } from '@/components/admin/SellerPayoutForms'

export const dynamic = 'force-dynamic'

const PAYOUT_STATUS_COLORS: Record<string, string> = {
  draft:    'bg-yellow-100 text-yellow-700',
  approved: 'bg-blue-100 text-blue-700',
  paid:     'bg-green-100 text-green-700',
}

export default async function SellerPayoutsDashboardPage() {
  // Unbatched eligible lines grouped by customer
  const eligibleLines = await prisma.sellerPayoutLine.findMany({
    where: { status: 'eligible', payoutId: null },
    select: {
      id: true,
      lineType: true,
      netAmount: true,
      currency: true,
      eligibleAt: true,
      customerProfileId: true,
      customerProfile: { select: { id: true, name: true, email: true } },
      agreement: { select: { id: true, submissionId: true, type: true } },
      orderItem: { select: { id: true, order: { select: { id: true } } } },
    },
    orderBy: { eligibleAt: 'asc' },
  })

  // Held lines
  const heldLines = await prisma.sellerPayoutLine.findMany({
    where: { status: 'held' },
    select: {
      id: true,
      lineType: true,
      netAmount: true,
      holdReason: true,
      heldAt: true,
      customerProfile: { select: { id: true, name: true, email: true } },
      agreement: { select: { submissionId: true } },
    },
    orderBy: { heldAt: 'asc' },
  })

  // All payout batches
  const payouts = await prisma.sellerPayout.findMany({
    select: {
      id: true,
      status: true,
      currency: true,
      totalAmount: true,
      createdAt: true,
      approvedAt: true,
      paidAt: true,
      customerProfile: { select: { name: true, email: true } },
      sellerProfile: { select: { displayName: true, status: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Group eligible lines by customer
  const byCustomer = new Map<string, typeof eligibleLines>()
  for (const line of eligibleLines) {
    const existing = byCustomer.get(line.customerProfileId) ?? []
    existing.push(line)
    byCustomer.set(line.customerProfileId, existing)
  }

  // Load seller profiles for customers with eligible lines
  const customerIds = [...byCustomer.keys()]
  const sellerProfiles = await prisma.sellerProfile.findMany({
    where: { profileId: { in: customerIds } },
    select: { id: true, profileId: true, status: true, payoutMethod: true, payoutHandle: true, displayName: true },
  })
  const profileByCustomerId = new Map(sellerProfiles.map((p) => [p.profileId, p]))

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Seller Payouts</h1>

      {/* ── Unbatched eligible lines ── */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Unbatched eligible lines</h2>
        {byCustomer.size === 0 ? (
          <p className="text-sm text-gray-500">No unbatched eligible lines.</p>
        ) : (
          <div className="space-y-6">
            {[...byCustomer.entries()].map(([customerProfileId, lines]) => {
              const customer = lines[0].customerProfile
              const sp = profileByCustomerId.get(customerProfileId) ?? null
              const buyoutTotal = lines
                .filter((l) => l.lineType === 'buyout')
                .reduce((s, l) => s + parseFloat(l.netAmount.toString()), 0)
              const consignmentTotal = lines
                .filter((l) => l.lineType === 'consignment')
                .reduce((s, l) => s + parseFloat(l.netAmount.toString()), 0)
              const grandTotal = lines.reduce((s, l) => s + parseFloat(l.netAmount.toString()), 0)

              return (
                <div key={customerProfileId} className="rounded-md border border-gray-200 bg-white p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                    <div>
                      <p className="font-medium text-gray-900">
                        {customer.name ?? '—'}{' '}
                        <span className="text-gray-500 font-normal text-sm">({customer.email})</span>
                      </p>
                      {sp ? (
                        <p className="text-xs text-gray-500 mt-0.5">
                          SellerProfile:{' '}
                          <span className={sp.status === 'active' ? 'text-green-700' : 'text-amber-700'}>
                            {sp.status}
                          </span>
                          {sp.displayName && ` · ${sp.displayName}`}
                          {sp.payoutMethod && ` · ${sp.payoutMethod}${sp.payoutHandle ? `: ${sp.payoutHandle}` : ''}`}
                        </p>
                      ) : (
                        <p className="text-xs text-amber-700 mt-0.5">
                          No SellerProfile —{' '}
                          <Link href={`/admin/seller-profiles/new?profileId=${customerProfileId}`} className="underline">
                            Create seller profile →
                          </Link>
                        </p>
                      )}
                    </div>
                    <div className="text-right text-sm">
                      <p className="font-semibold text-gray-900">${grandTotal.toFixed(2)}</p>
                      <p className="text-xs text-gray-500">{lines.length} line{lines.length !== 1 ? 's' : ''}</p>
                      {buyoutTotal > 0 && <p className="text-xs text-gray-400">Buyout: ${buyoutTotal.toFixed(2)}</p>}
                      {consignmentTotal > 0 && <p className="text-xs text-gray-400">Consignment: ${consignmentTotal.toFixed(2)}</p>}
                    </div>
                  </div>

                  {sp?.status !== 'active' && (
                    <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {sp ? 'SellerProfile is not active. Activate it before creating a payout.' : 'An active SellerProfile is required to create a payout.'}
                    </div>
                  )}

                  <CreatePayoutForm
                    lines={lines.map((l) => ({
                      id: l.id,
                      lineType: l.lineType,
                      netAmount: l.netAmount.toString(),
                      eligibleAt: l.eligibleAt,
                      submissionId: l.agreement?.submissionId ?? null,
                      orderId: l.orderItem?.order?.id ?? null,
                    }))}
                    sellerProfileId={sp?.id ?? null}
                    canCreate={sp?.status === 'active'}
                  />
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Held lines ── */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Held lines</h2>
        {heldLines.length === 0 ? (
          <p className="text-sm text-gray-500">No held lines.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Seller</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Hold reason</th>
                  <th className="px-4 py-3 font-medium">Held</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {heldLines.map((line) => (
                  <tr key={line.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-700">
                      {line.customerProfile.name ?? line.customerProfile.email}
                    </td>
                    <td className="px-4 py-3 capitalize text-gray-600">{line.lineType}</td>
                    <td className="px-4 py-3 font-mono font-medium text-gray-900">
                      ${parseFloat(line.netAmount.toString()).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-xs truncate">{line.holdReason}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {line.heldAt?.toLocaleDateString() ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <ReleaseLineForm lineId={line.id} />
                        <VoidLineForm lineId={line.id} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Payout batches ── */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Payout batches</h2>
        {payouts.length === 0 ? (
          <p className="text-sm text-gray-500">No payout batches yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Seller</th>
                  <th className="px-4 py-3 font-medium">Lines</th>
                  <th className="px-4 py-3 font-medium">Total</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Approved</th>
                  <th className="px-4 py-3 font-medium">Paid</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payouts.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PAYOUT_STATUS_COLORS[p.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {p.status.charAt(0).toUpperCase() + p.status.slice(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {p.customerProfile.name ?? p.customerProfile.email}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{p._count.lines}</td>
                    <td className="px-4 py-3 font-mono font-medium text-gray-900">
                      ${parseFloat(p.totalAmount.toString()).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{p.createdAt.toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{p.approvedAt?.toLocaleDateString() ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{p.paidAt?.toLocaleDateString() ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/seller-payouts/${p.id}`} className="text-blue-600 hover:underline text-xs">
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
