import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { CommunityProfileForm } from '@/components/store/CommunityProfileForm'
import { AccountNav } from '@/components/store/AccountNav'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Community Profile | CollectNTrades',
  robots: { index: false, follow: false },
}

// 16N: restored to Community-only scope — the public collector persona
// (handle/displayName/bio/visibility), backed by CustomerCommunityProfile.
// Private account/contact identity (email/name/phone) lives on the separate
// canonical /account/profile route; this page never reads or writes it.
export default async function CommunitySettingsPage() {
  const session = await getBuyerSession()

  if (!session) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Community Profile</h1>
        <p className="text-sm text-gray-500 mb-8">Sign in to manage your community profile.</p>
        <BuyerOrderAccessForm />
      </div>
    )
  }

  const community = await prisma.customerCommunityProfile.findUnique({
    where: { profileId: session.profileId },
    select: { handle: true, displayName: true, bio: true, isPublic: true, showOnLeaderboards: true },
  })

  return (
    <div className="max-w-lg">
      <AccountNav />
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Community Profile</h1>
      <p className="text-sm text-gray-500 mb-8">
        Set up a public collector profile. All visibility settings are opt-in — disabled by default.
      </p>
      <CommunityProfileForm existing={community} />

      <p className="mt-8 text-sm text-gray-500">
        <Link href="/account/profile" className="text-gray-700 underline underline-offset-2 hover:text-gray-900">
          Account information
        </Link>
        {' '}— update your name, phone, or view your login email.
      </p>
    </div>
  )
}
