import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { EditListingForm, type ConsignmentContextForListing } from '@/components/admin/ListingForm'
import {
  adminCaseTypeLabel,
  isOpenCaseStatus,
} from '@/lib/adminLifecycleDisplay'

export default async function EditListingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const listing = await prisma.listing.findUnique({
    where: { id },
    include: {
      item: {
        include: {
          catalog: true,
          location: true,
          _count: { select: { photos: true } },
          sellerAgreement: {
            select: {
              id: true,
              submissionId: true,
              status: true,
              commissionPercent: true,
              fixedFee: true,
              minimumSellerPayout: true,
              agreedListPrice: true,
              sellerTermsSummary: true,
            },
          },
        },
      },
    },
  })

  if (!listing) notFound()

  // Seller lifecycle cases scoped to this listing's item instance.
  const lifecycleCases = await prisma.sellerLifecycleCase.findMany({
    where: { itemInstanceId: listing.item.id },
    select: { id: true, caseType: true, status: true, returnedAt: true },
    orderBy: { openedAt: 'desc' as const },
  })
  const openReturnOrDisputeCases = lifecycleCases.filter(
    (c) =>
      isOpenCaseStatus(c.status) &&
      ['buyer_return', 'buyer_dispute', 'return_to_seller', 'consignment_expiration'].includes(
        c.caseType,
      ),
  )
  // Item physically returned to seller — listing must not be (re)activated.
  const confirmedReturn = lifecycleCases.some((c) => c.returnedAt)

  const consignmentContext: ConsignmentContextForListing | null =
    listing.item.sourceType === 'consignment' && listing.item.sellerAgreement?.status === 'accepted'
      ? {
          agreementId: listing.item.sellerAgreement.id,
          submissionId: listing.item.sellerAgreement.submissionId,
          commissionPercent:
            listing.item.sellerAgreement.commissionPercent?.toString() ?? '0',
          fixedFee: listing.item.sellerAgreement.fixedFee?.toFixed(2) ?? null,
          minimumSellerPayout:
            listing.item.sellerAgreement.minimumSellerPayout?.toFixed(2) ?? null,
          agreedListPrice: listing.item.sellerAgreement.agreedListPrice?.toFixed(2) ?? null,
          sellerTermsSummary: listing.item.sellerAgreement.sellerTermsSummary ?? null,
        }
      : null

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/listings" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Listings
        </Link>
        <div className="flex items-baseline gap-4 mt-2">
          <h1 className="text-2xl font-bold text-gray-900">Edit Listing</h1>
          <Link
            href={`/admin/items/${listing.item.id}/edit`}
            className="text-sm text-blue-600 hover:underline"
          >
            View Item →
          </Link>
        </div>
      </div>
      {listing.status === 'active' && listing.item._count.photos === 0 && (
        <div className="mb-6 max-w-lg rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This listing has no actual item photos. Buyers may see a catalog reference image if
          available, but actual item photos are recommended.
        </div>
      )}
      {confirmedReturn && (
        <div className="mb-6 max-w-lg rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-semibold mb-1">Item returned to seller.</p>
          <p>
            This item has a confirmed physical return. Do not reactivate this listing — the seller
            no longer has the item consigned.
          </p>
        </div>
      )}
      {openReturnOrDisputeCases.length > 0 && (
        <div className="mb-6 max-w-lg rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold mb-1">Active seller case on this item.</p>
          <p className="mb-2">
            An open return or dispute case affects this listing. Review before changing its status.
          </p>
          <div className="space-y-1">
            {openReturnOrDisputeCases.map((c) => (
              <Link
                key={c.id}
                href={`/admin/seller-cases/${c.id}`}
                className="block text-xs text-blue-600 hover:underline"
              >
                {adminCaseTypeLabel(c.caseType)} — view case →
              </Link>
            ))}
          </div>
        </div>
      )}
      <EditListingForm listing={listing} consignmentContext={consignmentContext} />
    </>
  )
}
