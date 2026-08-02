import type { Metadata } from 'next'
import { getBuyerSession } from '@/lib/buyerSession'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { CommunityProfileForm } from '@/components/store/CommunityProfileForm'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Community Profile | CollectNTrades',
  robots: { index: false, follow: false },
}

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
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Community Profile</h1>
      <p className="text-sm text-gray-500 mb-8">
        Set up a public collector profile. All visibility settings are opt-in — disabled by default.
      </p>
      <CommunityProfileForm existing={community} />
    </div>
  )
}
