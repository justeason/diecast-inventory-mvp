import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { ItemInstanceForm } from '@/components/admin/ItemInstanceForm'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { formatCommissionDisplay } from '@/lib/sellerAgreementDisplay'
import { derivePayoutLineDisplayStatus } from '@/lib/sellerPayoutCalculation'
import {
  adminCaseTypeLabel,
  adminCaseStatusLabel,
  ADMIN_CASE_STATUS_COLORS,
  isOpenCaseStatus,
} from '@/lib/adminLifecycleDisplay'
import { ResaleEstimatorPanel } from '@/components/admin/ResaleEstimatorPanel'
import { formatCandidateLabel } from '@/lib/catalogMatching'

export default async function EditItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [item, locations] = await Promise.all([
    prisma.itemInstance.findUnique({
      where: { id },
      include: {
        catalog: { select: { id: true, brand: true, name: true, year: true, color: true, series: true, scale: true } },
        photos: { select: { url: true, type: true }, orderBy: { sortOrder: 'asc' } },
        listing: { select: { id: true, status: true } },
        intakeDraft: { select: { id: true, sellerSubmissionId: true } },
        sellerAgreement: {
          select: {
            id: true,
            submissionId: true,
            type: true,
            status: true,
            agreedBuyoutAmount: true,
            commissionPercent: true,
            fixedFee: true,
            minimumSellerPayout: true,
            agreedListPrice: true,
            acceptedAt: true,
            acceptanceMethod: true,
            payoutLines: {
              select: {
                id: true,
                lineType: true,
                status: true,
                netAmount: true,
                eligibleAt: true,
                payout: { select: { id: true, status: true, paidAt: true } },
              },
              take: 1,
              orderBy: { eligibleAt: 'asc' as const },
            },
          },
        },
        orderItems: {
          select: {
            sellerPayoutLine: {
              select: {
                id: true,
                lineType: true,
                status: true,
                netAmount: true,
                eligibleAt: true,
                payout: { select: { id: true, status: true, paidAt: true } },
              },
            },
          },
          take: 1,
          orderBy: { createdAt: 'desc' as const },
        },
      },
    }),
    prisma.storageLocation.findMany({ orderBy: { label: 'asc' } }),
  ])

  if (!item) notFound()

  // Seller lifecycle cases scoped to this item instance.
  const lifecycleCases = await prisma.sellerLifecycleCase.findMany({
    where: { itemInstanceId: item.id },
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
  const openCases = lifecycleCases.filter((c) => isOpenCaseStatus(c.status))
  const returnedCase = lifecycleCases.find((c) => c.returnedAt)
  // Inconsistency: item physically returned but listing still active.
  const returnedWithActiveListing = !!returnedCase && item.listing?.status === 'active'

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/items" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Items
        </Link>
        <div className="flex items-baseline gap-4 mt-2 flex-wrap">
          <h1 className="text-2xl font-bold text-gray-900">Edit — {item.sku}</h1>
          {item.listing ? (
            <Link
              href={`/admin/listings/${item.listing.id}/edit`}
              className="text-sm text-blue-600 hover:underline"
            >
              View Listing →
            </Link>
          ) : (
            <Link
              href={`/admin/listings/new?itemId=${item.id}`}
              className="text-sm text-green-700 hover:underline"
            >
              Create Listing →
            </Link>
          )}
          <Link
            href={`/admin/items/new?from=${item.id}`}
            className="text-sm text-gray-500 hover:underline"
          >
            Duplicate →
          </Link>
        </div>
      </div>

      {/* Inventory ownership */}
      {item.sourceType && (
        <div className="mb-6 max-w-2xl rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
          <p className="font-semibold text-gray-700 mb-2">Inventory ownership</p>
          {item.sourceType === 'company_owned' && (
            <p className="text-gray-500">Company-owned. Acquired directly by the business.</p>
          )}
          {item.sourceType === 'buyout' && (
            <div className="space-y-1">
              <p className="text-gray-700">
                <span className="font-medium">Buyout</span> — acquired from seller via one-time
                buyout.
              </p>
              {item.purchasePrice != null && (
                <p className="text-gray-500">
                  Acquisition cost:{' '}
                  <span className="font-mono">${item.purchasePrice.toFixed(2)}</span>
                </p>
              )}
              {item.sellerAgreement && (
                <Link
                  href={`/admin/seller-submissions/${item.sellerAgreement.submissionId}/agreement`}
                  className="text-gray-700 hover:underline"
                >
                  View commercial agreement →
                </Link>
              )}
            </div>
          )}
          {item.sourceType === 'consignment' && (
            <div className="space-y-1">
              <p className="text-gray-700">
                <span className="font-medium">Consignment</span> — item remains seller-owned.
                Payout is not automatic.
              </p>
              {item.sellerAgreement?.commissionPercent && (
                <p className="text-gray-500">
                  Commission:{' '}
                  {formatCommissionDisplay(item.sellerAgreement.commissionPercent.toString())}
                </p>
              )}
              {item.sellerAgreement?.minimumSellerPayout && (
                <p className="text-gray-500">
                  Min. payout: $
                  {parseFloat(item.sellerAgreement.minimumSellerPayout.toFixed(2)).toFixed(2)}
                </p>
              )}
              {item.sellerAgreement && (
                <Link
                  href={`/admin/seller-submissions/${item.sellerAgreement.submissionId}/agreement`}
                  className="text-gray-700 hover:underline"
                >
                  View commercial agreement →
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {/* Payout context for seller-sourced inventory */}
      {item.sourceType === 'buyout' && (() => {
        const payoutLine = item.sellerAgreement?.payoutLines?.[0] ?? null
        const displayStatus = payoutLine
          ? derivePayoutLineDisplayStatus(payoutLine.status, payoutLine.payout ?? null)
          : null
        return (
          <div className="mb-6 max-w-2xl rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
            <p className="font-semibold text-gray-700 mb-2">Buyout payment status</p>
            {payoutLine ? (
              <div className="space-y-1 text-gray-600">
                <p>Status: <span className="text-gray-900">{displayStatus}</span></p>
                <p>Net amount: <span className="font-mono text-gray-900">${parseFloat(payoutLine.netAmount.toString()).toFixed(2)}</span></p>
                {payoutLine.payout?.paidAt && (
                  <p>Paid: <span className="text-gray-900">{payoutLine.payout.paidAt.toLocaleDateString()}</span></p>
                )}
                {payoutLine.payout && (
                  <Link href={`/admin/seller-payouts/${payoutLine.payout.id}`} className="text-blue-600 hover:underline">
                    View payout →
                  </Link>
                )}
              </div>
            ) : (
              <p className="text-amber-700 text-sm">No payout eligibility record found. This should be created automatically on buyout inventory conversion.</p>
            )}
          </div>
        )
      })()}
      {item.sourceType === 'consignment' && (() => {
        const consignmentLine = item.orderItems?.[0]?.sellerPayoutLine ?? null
        const displayStatus = consignmentLine
          ? derivePayoutLineDisplayStatus(consignmentLine.status, consignmentLine.payout ?? null)
          : null
        return (
          <div className="mb-6 max-w-2xl rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
            <p className="font-semibold text-gray-700 mb-2">Consignment payout status</p>
            {consignmentLine ? (
              <div className="space-y-1 text-gray-600">
                <p>Status: <span className="text-gray-900">{displayStatus}</span></p>
                <p>Net amount: <span className="font-mono text-gray-900">${parseFloat(consignmentLine.netAmount.toString()).toFixed(2)}</span></p>
                {consignmentLine.payout?.paidAt && (
                  <p>Paid: <span className="text-gray-900">{consignmentLine.payout.paidAt.toLocaleDateString()}</span></p>
                )}
                {consignmentLine.payout && (
                  <Link href={`/admin/seller-payouts/${consignmentLine.payout.id}`} className="text-blue-600 hover:underline">
                    View payout →
                  </Link>
                )}
              </div>
            ) : (
              <p className="text-gray-500 text-sm">No payout eligibility until the related order is completed.</p>
            )}
          </div>
        )
      })()}

      {/* Seller-sourced inventory traceability */}
      {item.intakeDraft?.sellerSubmissionId && (
        <div className="mb-6 max-w-2xl rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
          <p className="font-semibold text-gray-700 mb-1">Seller-sourced inventory</p>
          <p className="text-gray-500 mb-2">
            This inventory item was created through a seller submission intake.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link
              href={`/admin/seller-submissions/${item.intakeDraft.sellerSubmissionId}`}
              className="text-gray-700 hover:underline"
            >
              View seller submission →
            </Link>
            <Link
              href={`/admin/intake/${item.intakeDraft.id}/edit`}
              className="text-gray-700 hover:underline"
            >
              View intake →
            </Link>
          </div>
        </div>
      )}

      {item.listing?.status === 'active' && item.photos.length === 0 && (
        <div className="mb-6 max-w-2xl rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This item is listed without actual item photos. Add item photos when possible so buyers
          can verify condition.
        </div>
      )}

      {item.photos.length > 0 && (
        <div className="mb-6 max-w-2xl">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Photos</h2>
          <div className="flex flex-wrap gap-3">
            {item.photos.map((photo, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="relative h-32 w-32 overflow-hidden rounded-md">
                  <PhotoThumbnail photoUrl={photo.url} alt={`${photo.type} photo`} size="fill" />
                </div>
                <p className="text-xs text-gray-500 capitalize text-center">{photo.type}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Seller lifecycle */}
      {(lifecycleCases.length > 0 || returnedWithActiveListing) && (
        <div className="mb-6 max-w-2xl rounded-md border border-gray-200 bg-white px-4 py-3 text-sm">
          <p className="font-semibold text-gray-700 mb-2">Seller lifecycle</p>

          {returnedWithActiveListing && (
            <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
              <span className="font-semibold">Inconsistency: </span>
              This item is marked as returned to the seller but its listing is still active.
              Archive the listing to prevent it from selling.
            </div>
          )}

          {returnedCase?.returnedAt && (
            <p className="text-xs text-gray-600 mb-2">
              Return confirmed on {returnedCase.returnedAt.toLocaleDateString()}.
            </p>
          )}

          {lifecycleCases.length === 0 ? (
            <p className="text-xs text-gray-400">No lifecycle cases for this item.</p>
          ) : openCases.length === 0 ? (
            <p className="text-xs text-gray-400">No open lifecycle cases for this item.</p>
          ) : (
            <div className="space-y-2">
              {openCases.map((c) => (
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
                  <Link
                    href={`/admin/seller-cases/${c.id}`}
                    className="ml-auto text-blue-600 hover:underline"
                  >
                    View case →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-6 max-w-2xl">
        <ResaleEstimatorPanel catalogId={item.catalogId} />
      </div>

      <ItemInstanceForm
        item={item}
        defaultCatalogId={item.catalog?.id}
        defaultCatalogLabel={item.catalog ? formatCandidateLabel(item.catalog) : undefined}
        locations={locations}
      />
    </>
  )
}
