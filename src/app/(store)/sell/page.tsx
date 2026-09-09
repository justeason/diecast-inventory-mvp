import type { Metadata } from 'next'
import { getSellBatch, getUnclaimedGuestBatchCount } from '@/lib/actions/sellCapture'
import { SellCaptureFlow } from '@/components/store/SellCaptureFlow'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sell Your Collectibles | CollectNTrades',
  robots: { index: false, follow: false },
}

// 19B: the camera-first, no-login-required Sell entry point. Read-only on
// GET — getSellBatch()/getUnclaimedGuestBatchCount() never create a
// GuestSellerSession or MobileCaptureSession; both stay lazy until the first
// confirmed "Add" (see sellCapture.ts). NOT yet linked from global/header Sell
// navigation or anonymous "Sell One" continuation — those still point at the
// existing sign-in-gated flow until 19C makes guest work claimable. This route
// exists for direct-URL testing/development only, per the 19B release
// boundary.
export default async function SellPage() {
  const [batch, unclaimedGuestBatchCount] = await Promise.all([
    getSellBatch(),
    getUnclaimedGuestBatchCount(),
  ])

  return (
    <div className="max-w-lg mx-auto py-4 px-4">
      <SellCaptureFlow initialItems={batch.items} unclaimedGuestBatchCount={unclaimedGuestBatchCount} />
    </div>
  )
}
