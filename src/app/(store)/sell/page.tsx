import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { getSellBatch, getUnclaimedGuestBatchCount } from '@/lib/actions/sellCapture'
import { SellCaptureFlow } from '@/components/store/SellCaptureFlow'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sell Your Collectibles | CollectNTrades',
  robots: { index: false, follow: false },
}

// 19B/19C: the camera-first, no-login-required Sell entry point — now the
// primary customer-facing "Sell" nav destination (see customerNav.ts).
// Read-only on GET: getSellBatch()/getUnclaimedGuestBatchCount() never create a
// session, and a ?catalogId lookup is a plain findUnique, never a write — no
// DB mutation happens merely by visiting this page with any combination of
// query params.
export default async function SellPage({
  searchParams,
}: {
  searchParams: Promise<{ catalogId?: string; claimed?: string }>
}) {
  const { catalogId, claimed } = await searchParams

  const [session, batch, unclaimedGuestBatchCount, preselected] = await Promise.all([
    getBuyerSession(),
    getSellBatch(),
    getUnclaimedGuestBatchCount(),
    catalogId
      ? prisma.catalogModel.findUnique({
          where:  { id: catalogId },
          select: { id: true, brand: true, name: true, year: true },
        })
      : Promise.resolve(null),
  ])

  return (
    <div className="max-w-lg mx-auto py-4 px-4">
      <SellCaptureFlow
        initialItems={batch.items}
        unclaimedGuestBatchCount={unclaimedGuestBatchCount}
        isAuthenticated={!!session}
        preselected={preselected}
        justClaimed={claimed === '1'}
      />
    </div>
  )
}
