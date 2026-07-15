import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { SellerProfileForm } from '@/components/admin/SellerProfileForm'

export default async function NewSellerProfilePage() {
  // Only show CustomerProfiles that do not yet have a SellerProfile
  const eligibleProfiles = await prisma.customerProfile.findMany({
    where: { sellerProfile: null },
    select: { id: true, email: true, name: true },
    orderBy: { email: 'asc' },
  })

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/seller-profiles" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Seller Profiles
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">New Seller Profile</h1>
      </div>

      {eligibleProfiles.length === 0 ? (
        <div className="max-w-lg rounded-md border border-amber-200 bg-amber-50 px-5 py-4 text-sm">
          <p className="font-medium text-amber-800 mb-1">No eligible customer profiles found.</p>
          <p className="text-amber-700">
            All existing customer profiles already have seller profiles, or no customer profiles
            exist yet. Customer profiles are created automatically when buyers place orders.
          </p>
        </div>
      ) : (
        <SellerProfileForm mode="create" eligibleProfiles={eligibleProfiles} />
      )}
    </>
  )
}
