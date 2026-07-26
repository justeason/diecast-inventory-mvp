import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { findLifecycleFinancialWarnings } from '@/lib/sellerLifecycle'
import {
  ResolveCaseForm,
  CancelCaseForm,
  RecordReturnShipmentForm,
  MarkItemReturnedForm,
} from '@/components/admin/SellerLifecycleForms'

export const dynamic = 'force-dynamic'

const CASE_STATUS_COLORS: Record<string, string> = {
  open: 'bg-yellow-100 text-yellow-700',
  action_required: 'bg-red-100 text-red-700',
  resolved: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
}

const RETURN_CASE_TYPES = ['buyer_return', 'return_to_seller', 'consignment_expiration']

export default async function SellerCaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const lifecycleCase = await prisma.sellerLifecycleCase.findUnique({
    where: { id },
    select: {
      id: true,
      caseType: true,
      status: true,
      sellerVisible: true,
      sellerMessage: true,
      adminNotes: true,
      resolutionSummary: true,
      openedAt: true,
      resolvedAt: true,
      cancelledAt: true,
      returnCarrier: true,
      returnTrackingNumber: true,
      returnShippedAt: true,
      returnedAt: true,
      agreementId: true,
      intakeDraftId: true,
      itemInstanceId: true,
      listingId: true,
      orderId: true,
      orderItemId: true,
      sellerPayoutLineId: true,
      sellerSubmission: {
        select: {
          id: true,
          brand: true,
          name: true,
          profile: { select: { name: true, email: true } },
        },
      },
    },
  })
  if (!lifecycleCase) notFound()

  const submissionId = lifecycleCase.sellerSubmission.id

  // Gather data for financial warnings.
  const [cases, payoutLines, items, intakeDrafts] = await Promise.all([
    prisma.sellerLifecycleCase.findMany({
      where: { sellerSubmissionId: submissionId },
      select: {
        id: true,
        caseType: true,
        status: true,
        returnedAt: true,
        itemInstanceId: true,
        listingId: true,
        orderItemId: true,
      },
    }),
    prisma.sellerPayoutLine.findMany({
      where: { agreement: { submissionId } },
      select: {
        id: true,
        status: true,
        payoutId: true,
        orderItemId: true,
        payout: { select: { status: true } },
      },
    }),
    prisma.itemInstance.findMany({
      where: { sellerAgreement: { submissionId } },
      select: { id: true, status: true, listing: { select: { status: true } } },
    }),
    prisma.intakeDraft.findMany({
      where: { sellerSubmissionId: submissionId },
      select: { status: true, convertedItemId: true },
    }),
  ])

  const warnings = findLifecycleFinancialWarnings({ cases, payoutLines, items, intakeDrafts })

  const isOpen = lifecycleCase.status === 'open' || lifecycleCase.status === 'action_required'
  const isReturnCase = RETURN_CASE_TYPES.includes(lifecycleCase.caseType)
  const sellerLabel =
    lifecycleCase.sellerSubmission.profile.name ?? lifecycleCase.sellerSubmission.profile.email
  const itemTitle =
    [lifecycleCase.sellerSubmission.brand, lifecycleCase.sellerSubmission.name]
      .filter(Boolean)
      .join(' ') || 'Untitled item'

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href="/admin/seller-lifecycle" className="text-sm text-gray-500 hover:text-gray-900">
          ← Seller lifecycle
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Case: {lifecycleCase.caseType}</h1>
        <span
          className={`mt-1 shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
            CASE_STATUS_COLORS[lifecycleCase.status] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {lifecycleCase.status}
        </span>
      </div>
      <p className="text-sm text-gray-600 mb-1">
        {sellerLabel} · {itemTitle}
      </p>
      <p className="text-xs text-gray-400 mb-6">Opened {lifecycleCase.openedAt.toLocaleString()}</p>

      {/* Financial warnings */}
      {warnings.length > 0 && (
        <div className="mb-6 space-y-2">
          {warnings.map((w) => (
            <div
              key={w.code}
              className={`rounded-md border px-4 py-3 text-sm ${
                w.severity === 'critical'
                  ? 'border-red-300 bg-red-50 text-red-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              <span className="font-medium uppercase text-xs mr-2">{w.severity}</span>
              {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Case fields */}
      <div className="mb-6 rounded-md border border-gray-200 bg-gray-50 p-4">
        <dl className="space-y-2 text-sm">
          <Row label="Seller visible" value={lifecycleCase.sellerVisible ? 'Yes' : 'No'} />
          {lifecycleCase.sellerMessage && <Row label="Seller message" value={lifecycleCase.sellerMessage} />}
          {lifecycleCase.adminNotes && <Row label="Admin notes" value={lifecycleCase.adminNotes} />}
          {lifecycleCase.resolutionSummary && (
            <Row label="Resolution" value={lifecycleCase.resolutionSummary} />
          )}
          {lifecycleCase.resolvedAt && (
            <Row label="Resolved" value={lifecycleCase.resolvedAt.toLocaleString()} />
          )}
          {lifecycleCase.cancelledAt && (
            <Row label="Cancelled" value={lifecycleCase.cancelledAt.toLocaleString()} />
          )}
          {lifecycleCase.returnCarrier && <Row label="Return carrier" value={lifecycleCase.returnCarrier} />}
          {lifecycleCase.returnTrackingNumber && (
            <Row label="Tracking" value={lifecycleCase.returnTrackingNumber} />
          )}
          {lifecycleCase.returnShippedAt && (
            <Row label="Return shipped" value={lifecycleCase.returnShippedAt.toLocaleDateString()} />
          )}
          {lifecycleCase.returnedAt && (
            <Row label="Returned" value={lifecycleCase.returnedAt.toLocaleDateString()} />
          )}
        </dl>
      </div>

      {/* Related links */}
      <div className="mb-6 flex flex-wrap gap-3 text-sm">
        <Link
          href={`/admin/seller-submissions/${submissionId}`}
          className="text-blue-600 hover:underline"
        >
          Submission
        </Link>
        {lifecycleCase.agreementId && (
          <Link
            href={`/admin/seller-submissions/${submissionId}/agreement`}
            className="text-blue-600 hover:underline"
          >
            Agreement
          </Link>
        )}
        {lifecycleCase.itemInstanceId && (
          <Link
            href={`/admin/items/${lifecycleCase.itemInstanceId}/edit`}
            className="text-blue-600 hover:underline"
          >
            Item
          </Link>
        )}
        {lifecycleCase.orderId && (
          <Link href={`/admin/orders/${lifecycleCase.orderId}`} className="text-blue-600 hover:underline">
            Order
          </Link>
        )}
        {lifecycleCase.sellerPayoutLineId && (
          <Link href="/admin/seller-payouts" className="text-blue-600 hover:underline">
            Payout line
          </Link>
        )}
      </div>

      {/* Actions */}
      {isOpen ? (
        <div className="space-y-8 pt-6 border-t border-gray-200">
          {isReturnCase && (
            <>
              <div>
                <h2 className="text-sm font-semibold text-gray-900 mb-3">Record return shipment</h2>
                <RecordReturnShipmentForm caseId={lifecycleCase.id} />
              </div>
              {!lifecycleCase.returnedAt && (
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 mb-3">Mark item returned</h2>
                  <MarkItemReturnedForm caseId={lifecycleCase.id} />
                </div>
              )}
            </>
          )}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Resolve case</h2>
            <ResolveCaseForm caseId={lifecycleCase.id} sellerVisible={lifecycleCase.sellerVisible} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Cancel case</h2>
            <CancelCaseForm caseId={lifecycleCase.id} />
          </div>
        </div>
      ) : (
        <p className="pt-6 border-t border-gray-200 text-sm text-gray-500">
          This case is {lifecycleCase.status} and cannot be modified.
        </p>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="text-gray-500 w-32 shrink-0">{label}</dt>
      <dd className="text-gray-900 whitespace-pre-wrap">{value}</dd>
    </div>
  )
}
