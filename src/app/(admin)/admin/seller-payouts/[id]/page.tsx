import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import {
  RemoveLineForm,
  ApprovePayoutForm,
  MarkPayoutPaidForm,
} from '@/components/admin/SellerPayoutForms'
import { derivePayoutLineDisplayStatus } from '@/lib/sellerPayoutCalculation'
import {
  adminCaseTypeLabel,
  adminCaseStatusLabel,
  ADMIN_CASE_STATUS_COLORS,
  isOpenCaseStatus,
} from '@/lib/adminLifecycleDisplay'

export const dynamic = 'force-dynamic'

const PAYOUT_STATUS_COLORS: Record<string, string> = {
  draft:    'bg-yellow-100 text-yellow-700',
  approved: 'bg-blue-100 text-blue-700',
  paid:     'bg-green-100 text-green-700',
}

const LINE_DISPLAY_COLORS: Record<string, string> = {
  Eligible:               'bg-gray-100 text-gray-600',
  Held:                   'bg-amber-100 text-amber-700',
  Voided:                 'bg-red-100 text-red-500',
  'Payout being prepared': 'bg-yellow-100 text-yellow-700',
  'Payout approved':       'bg-blue-100 text-blue-700',
  Paid:                   'bg-green-100 text-green-700',
}

export default async function PayoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const payout = await prisma.sellerPayout.findUnique({
    where: { id },
    include: {
      customerProfile: { select: { id: true, name: true, email: true } },
      sellerProfile: { select: { id: true, displayName: true, status: true, payoutMethod: true, payoutHandle: true } },
      lines: {
        select: {
          id: true,
          lineType: true,
          status: true,
          netAmount: true,
          grossSalePrice: true,
          agreedBuyoutAmount: true,
          commissionPercent: true,
          commissionAmount: true,
          fixedFee: true,
          minimumSellerPayout: true,
          minimumAdjustment: true,
          eligibleAt: true,
          agreement: { select: { id: true, submissionId: true, type: true } },
          orderItem: { select: { id: true, order: { select: { id: true, status: true } } } },
        },
        orderBy: { eligibleAt: 'asc' },
      },
    },
  })

  if (!payout) notFound()

  // Linked lifecycle cases: any case tied to a payout line in this batch, or to an
  // order that contributed a line to this batch.
  const lineIds = payout.lines.map((l) => l.id)
  const orderIds = Array.from(
    new Set(
      payout.lines
        .map((l) => l.orderItem?.order?.id)
        .filter((v): v is string => !!v),
    ),
  )
  const linkedCases =
    lineIds.length === 0 && orderIds.length === 0
      ? []
      : await prisma.sellerLifecycleCase.findMany({
          where: {
            OR: [
              { sellerPayoutLineId: { in: lineIds } },
              ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
            ],
          },
          select: {
            id: true,
            caseType: true,
            status: true,
            returnedAt: true,
            openedAt: true,
            sellerSubmissionId: true,
          },
          orderBy: { openedAt: 'desc' as const },
        })
  const openLinkedCases = linkedCases.filter((c) => isOpenCaseStatus(c.status))

  const isDraft = payout.status === 'draft'
  const isApproved = payout.status === 'approved'
  const isPaid = payout.status === 'paid'

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/seller-payouts" className="text-sm text-gray-500 hover:text-gray-900">
          ← Seller Payouts
        </Link>
        <div className="flex items-center gap-4 mt-2">
          <h1 className="text-2xl font-bold text-gray-900">Payout Detail</h1>
          <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${PAYOUT_STATUS_COLORS[payout.status] ?? 'bg-gray-100 text-gray-600'}`}>
            {payout.status.charAt(0).toUpperCase() + payout.status.slice(1)}
          </span>
        </div>
      </div>

      {/* Header info */}
      <div className="mb-8 rounded-md border border-gray-200 bg-gray-50 p-5 text-sm space-y-2 max-w-xl">
        <div className="flex gap-3">
          <dt className="text-gray-500 w-36 shrink-0">Seller</dt>
          <dd className="text-gray-900">
            <Link href={`/admin/customers/${payout.customerProfile.id}`} className="hover:underline text-blue-600">
              {payout.customerProfile.name ?? payout.customerProfile.email}
            </Link>
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-gray-500 w-36 shrink-0">SellerProfile</dt>
          <dd className="text-gray-900">
            {payout.sellerProfile ? (
              <>
                {payout.sellerProfile.displayName ?? '(no display name)'}{' '}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${payout.sellerProfile.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                  {payout.sellerProfile.status}
                </span>
                {payout.sellerProfile.payoutMethod && (
                  <span className="ml-2 text-xs text-gray-500">
                    {payout.sellerProfile.payoutMethod}
                    {payout.sellerProfile.payoutHandle ? `: ${payout.sellerProfile.payoutHandle}` : ''}
                  </span>
                )}
              </>
            ) : (
              <span className="text-amber-700">No linked SellerProfile</span>
            )}
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-gray-500 w-36 shrink-0">Currency</dt>
          <dd className="text-gray-900">{payout.currency}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-gray-500 w-36 shrink-0">Total</dt>
          <dd className="font-semibold text-gray-900">${parseFloat(payout.totalAmount.toString()).toFixed(2)}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-gray-500 w-36 shrink-0">Created</dt>
          <dd className="text-gray-900">{payout.createdAt.toLocaleDateString()}</dd>
        </div>
        {payout.approvedAt && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Approved</dt>
            <dd className="text-gray-900">{payout.approvedAt.toLocaleDateString()}</dd>
          </div>
        )}
        {payout.paidAt && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Paid</dt>
            <dd className="text-gray-900">{payout.paidAt.toLocaleDateString()}</dd>
          </div>
        )}
        {payout.paymentMethod && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Payment method</dt>
            <dd className="text-gray-900">{payout.paymentMethod}</dd>
          </div>
        )}
        {payout.paymentReference && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Reference</dt>
            <dd className="font-mono text-xs text-gray-900 break-all">{payout.paymentReference}</dd>
          </div>
        )}
        {payout.adminNotes && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Admin notes</dt>
            <dd className="text-gray-700 whitespace-pre-wrap">{payout.adminNotes}</dd>
          </div>
        )}
      </div>

      {/* Non-complete order warning — shown when any consignment line's order is no longer complete */}
      {payout.lines.some(
        (l) => l.lineType === 'consignment' && l.orderItem?.order?.status && l.orderItem.order.status !== 'complete',
      ) && !isPaid && (
        <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold mb-1">Order status changed after payout line was created.</p>
          <p>
            One or more consignment payout lines on this batch are linked to orders that are no longer
            marked as complete. The payout amounts are not automatically revised — no line or order record
            has been changed. Review each affected line before {isApproved ? 'recording payment' : 'approval or payment'}.
          </p>
          {isDraft && (
            <p className="mt-1 text-xs text-amber-700">
              To hold or void a line, remove it from this draft payout first, then use the Hold or Void action.
            </p>
          )}
        </div>
      )}

      {/* Linked lifecycle cases */}
      {linkedCases.length > 0 && (
        <section className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Linked cases</h2>

          {openLinkedCases.length > 0 && (isApproved || isPaid) && (
            <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-semibold mb-1">
                Critical: open seller case while payout is {isPaid ? 'paid' : 'approved'}.
              </p>
              <p>
                {isPaid
                  ? 'This payout is already recorded as paid. An open return or dispute may require manual recovery. No payout fields are changed automatically.'
                  : 'This payout is already approved. Do not record payment until the open case is resolved. Approval is not reversed automatically.'}
              </p>
            </div>
          )}
          {openLinkedCases.length > 0 && isDraft && (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-semibold mb-1">Open seller case on this draft payout.</p>
              <p>
                Remove the affected line from this draft and hold it before approval. Lines are not
                removed automatically.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {linkedCases.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs"
              >
                <span className="font-medium text-gray-700">{adminCaseTypeLabel(c.caseType)}</span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
                    ADMIN_CASE_STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {adminCaseStatusLabel(c.status)}
                </span>
                {c.returnedAt && (
                  <span className="text-gray-500">Returned {c.returnedAt.toLocaleDateString()}</span>
                )}
                <Link
                  href={`/admin/seller-cases/${c.id}`}
                  className="ml-auto text-blue-600 hover:underline"
                >
                  View case →
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Lines table */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Payout lines</h2>
        {payout.lines.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This payout has no lines. It cannot be approved until at least one line is added.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Details</th>
                  <th className="px-4 py-3 font-medium text-right">Net amount</th>
                  <th className="px-4 py-3 font-medium">Eligible</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  {isDraft && <th className="px-4 py-3 font-medium"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payout.lines.map((line) => {
                  const displayStatus = derivePayoutLineDisplayStatus(line.status, payout)
                  return (
                    <tr key={line.id} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3 capitalize font-medium text-gray-700">{line.lineType}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs space-y-0.5 max-w-xs">
                        {line.lineType === 'buyout' ? (
                          <>
                            {line.agreement && (
                              <p>
                                <Link
                                  href={`/admin/seller-submissions/${line.agreement.submissionId}/agreement`}
                                  className="text-blue-600 hover:underline"
                                >
                                  View agreement →
                                </Link>
                              </p>
                            )}
                            {line.agreedBuyoutAmount && (
                              <p>Agreed buyout: ${parseFloat(line.agreedBuyoutAmount.toString()).toFixed(2)}</p>
                            )}
                          </>
                        ) : (
                          <>
                            {line.agreement && (
                              <p>
                                <Link
                                  href={`/admin/seller-submissions/${line.agreement.submissionId}/agreement`}
                                  className="text-blue-600 hover:underline"
                                >
                                  View agreement →
                                </Link>
                              </p>
                            )}
                            {line.orderItem?.order && (
                              <p>
                                <Link
                                  href={`/admin/orders/${line.orderItem.order.id}`}
                                  className="text-blue-600 hover:underline"
                                >
                                  View order →
                                </Link>
                              </p>
                            )}
                            {line.grossSalePrice && (
                              <p>Sale price: ${parseFloat(line.grossSalePrice.toString()).toFixed(2)}</p>
                            )}
                            {line.commissionPercent && (
                              <p>Commission: {(parseFloat(line.commissionPercent.toString()) * 100).toFixed(2)}%
                                {line.commissionAmount && ` (−$${parseFloat(line.commissionAmount.toString()).toFixed(2)})`}
                              </p>
                            )}
                            {line.fixedFee && (
                              <p>Fixed fee: −${parseFloat(line.fixedFee.toString()).toFixed(2)}</p>
                            )}
                            {line.minimumSellerPayout && (
                              <p>Min. payout: ${parseFloat(line.minimumSellerPayout.toString()).toFixed(2)}</p>
                            )}
                            {line.minimumAdjustment && parseFloat(line.minimumAdjustment.toString()) > 0 && (
                              <p>Min. adjustment: +${parseFloat(line.minimumAdjustment.toString()).toFixed(2)}</p>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono font-medium text-gray-900 text-right">
                        ${parseFloat(line.netAmount.toString()).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {line.eligibleAt.toLocaleDateString()}
                        {line.lineType === 'consignment' &&
                         line.orderItem?.order?.status &&
                         line.orderItem.order.status !== 'complete' && (
                          <span className="block mt-1 text-amber-700 font-medium">
                            Order no longer complete — review before {isPaid ? 'no further action' : 'approval or payment'}.
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${LINE_DISPLAY_COLORS[displayStatus] ?? 'bg-gray-100 text-gray-600'}`}>
                          {displayStatus}
                        </span>
                      </td>
                      {isDraft && (
                        <td className="px-4 py-3">
                          <RemoveLineForm payoutId={id} lineId={line.id} />
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Draft actions */}
      {isDraft && (
        <section className="mb-8 pt-6 border-t border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Approve payout</h2>
          {payout.lines.length === 0 ? (
            <p className="text-sm text-amber-700">Add at least one line before approving.</p>
          ) : !payout.sellerProfile || payout.sellerProfile.status !== 'active' ? (
            <p className="text-sm text-amber-700">An active SellerProfile is required to approve.</p>
          ) : (
            <ApprovePayoutForm payoutId={id} />
          )}
        </section>
      )}

      {/* Approved actions */}
      {isApproved && (
        <section className="mb-8 pt-6 border-t border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Record payment</h2>
          <p className="text-xs text-gray-500 mb-4">
            Record that payment was manually sent. No external payment is executed.
          </p>
          <MarkPayoutPaidForm payoutId={id} />
        </section>
      )}

      {/* Paid — read-only */}
      {isPaid && (
        <div className="pt-6 border-t border-gray-200">
          <p className="text-sm text-green-700 font-medium">
            This payout has been recorded as paid on {payout.paidAt?.toLocaleDateString()}.
          </p>
          <p className="text-xs text-gray-500 mt-1">No further changes can be made.</p>
        </div>
      )}
    </>
  )
}
