import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { CreateListingForm, type ItemWithRelations } from '@/components/admin/ListingForm'
import { safeGetAdminPricingContext } from '@/lib/adminPricingContext'

export default async function NewListingPage({
  searchParams,
}: {
  searchParams: Promise<{ itemId?: string }>
}) {
  const { itemId } = await searchParams

  const rawItems = await prisma.itemInstance.findMany({
    where: { status: 'available', listing: null },
    include: {
      catalog: true,
      location: true,
      sellerAgreement: {
        select: {
          id: true,
          submissionId: true,
          status: true,
          commissionPercent: true,
          commissionMinimumFee: true,
          fixedFee: true,
          minimumSellerPayout: true,
          agreedListPrice: true,
          sellerTermsSummary: true,
        },
      },
    },
    orderBy: { sku: 'asc' },
  })

  const eligibleItems: ItemWithRelations[] = rawItems.map((item) => ({
    ...item,
    consignmentContext:
      item.sourceType === 'consignment' && item.sellerAgreement?.status === 'accepted'
        ? {
            agreementId: item.sellerAgreement.id,
            submissionId: item.sellerAgreement.submissionId,
            commissionPercent: item.sellerAgreement.commissionPercent?.toString() ?? '0',
            commissionMinimumFee: item.sellerAgreement.commissionMinimumFee?.toFixed(2) ?? null,
            fixedFee: item.sellerAgreement.fixedFee?.toFixed(2) ?? null,
            minimumSellerPayout: item.sellerAgreement.minimumSellerPayout?.toFixed(2) ?? null,
            agreedListPrice: item.sellerAgreement.agreedListPrice?.toFixed(2) ?? null,
            sellerTermsSummary: item.sellerAgreement.sellerTermsSummary ?? null,
          }
        : null,
  }))

  const preSelectedItem = itemId
    ? (eligibleItems.find((item) => item.id === itemId) ?? null)
    : null

  // Follow-up §1/§3: fetched only for the pre-selected item (never every
  // eligible item — see ListingForm.tsx's item-selection navigation, which
  // is what keeps `itemId` in sync with the picker), and isolated so a
  // technical failure renders a neutral unavailable panel instead of losing
  // the create-listing workflow.
  const adminPricingContext = preSelectedItem
    ? await safeGetAdminPricingContext(
        {
          catalogModelId: preSelectedItem.catalogId,
          marketVariantId: preSelectedItem.marketVariantId,
          condition: preSelectedItem.condition,
          asOf: new Date(),
        },
        { route: '/admin/listings/new', itemId: preSelectedItem.id },
      )
    : null

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/listings" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Listings
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">New Listing</h1>
      </div>
      <CreateListingForm items={eligibleItems} preSelectedItem={preSelectedItem} adminPricingContext={adminPricingContext} />
    </>
  )
}
