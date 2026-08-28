import type { Metadata } from 'next'
import { getBuyerSession } from '@/lib/buyerSession'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { CustomerAccountInfoForm } from '@/components/store/CustomerAccountInfoForm'
import { AccountNav } from '@/components/store/AccountNav'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Profile | CollectNTrades',
  robots: { index: false, follow: false },
}

// 16N: the canonical PRIVATE account/contact identity route — deliberately
// separate from /account/community (the public collector persona: handle,
// display name, bio, visibility). CustomerProfile (email/name/phone) is a
// different identity than CustomerCommunityProfile; neither write path touches
// the other's fields (see updateCustomerAccountInfo / saveCommunityProfile).
export default async function AccountProfilePage() {
  const session = await getBuyerSession()

  if (!session) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Profile</h1>
        <p className="text-sm text-gray-500 mb-8">Sign in to manage your account information.</p>
        <BuyerOrderAccessForm />
      </div>
    )
  }

  // Read-only for GET — no CustomerProfile row is created merely by visiting
  // this page (the session already guarantees one exists, from 16M's
  // verify-time upsert). `notes` is intentionally not selected — it stays
  // internal/admin-only, never exposed to the buyer.
  const accountInfo = await prisma.customerProfile.findUnique({
    where: { id: session.profileId },
    select: { name: true, phone: true, email: true, updatedAt: true },
  })

  return (
    <div className="max-w-lg">
      <AccountNav />
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Profile</h1>
      <p className="text-sm text-gray-500 mb-8">Manage your account information.</p>

      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Account Info</h2>
        <p className="text-sm text-gray-500 mb-6">Your name and phone number, used for orders and selling.</p>
        {accountInfo && (
          <CustomerAccountInfoForm
            existing={{
              name: accountInfo.name,
              phone: accountInfo.phone,
              email: accountInfo.email,
              updatedAt: accountInfo.updatedAt.toISOString(),
            }}
          />
        )}
      </section>
    </div>
  )
}
