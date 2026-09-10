import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { getGuestSellerBatch } from '@/lib/actions/guestSeller'
import { CustomerSignInPanel } from '@/components/store/CustomerSignInPanel'
import { ClaimGuestBatchPanel } from '@/components/store/ClaimGuestBatchPanel'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Add Saved Items | CollectNTrades',
  robots: { index: false, follow: false },
}

// 19C: the one authenticated continuation destination for a guest seller's
// saved batch. GET is read-only — getGuestSellerBatch() never creates/mutates
// anything, and no claim happens merely by rendering this page; the customer
// must click Add Saved Items (ClaimGuestBatchPanel), which calls the dedicated
// claimGuestSellerBatch Server Action. A GuestSellerSession can never exist with
// zero items (see guestSeller.ts), so an empty batch here means "no valid guest
// session at all" — expired, already claimed, or never existed — one safe empty
// state covers all three, matching §41/§42's read-only requirement.
export default async function ClaimSellBatchPage() {
  const session = await getBuyerSession()
  const batch = await getGuestSellerBatch()

  if (!session) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Sign In to Continue</h1>
        <p className="text-sm text-gray-500 mb-8">
          Sign in to add your saved selling items to your account.
        </p>
        <CustomerSignInPanel returnTo="/account/sell/claim" />
      </div>
    )
  }

  if (batch.items.length === 0) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">No saved selling items were found</h1>
        <p className="text-sm text-gray-600 mb-6">
          Your saved batch may have already been added to your account, or it has expired.
        </p>
        <Link href="/sell" className="text-sm font-medium text-gray-900 hover:underline underline-offset-2">
          ← Return to Sell
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-md">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Your saved items are ready</h1>
      <p className="text-sm text-gray-500 mb-6">
        {batch.items.length} item{batch.items.length !== 1 ? 's' : ''} saved from before you signed in.
      </p>
      <ul className="space-y-2 mb-6">
        {batch.items.map((item) => (
          <li key={item.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="font-medium text-gray-900">
              {item.brand} {item.name}{item.year && <span className="text-gray-500 font-normal"> ({item.year})</span>}
            </p>
            <p className="text-xs text-gray-500">Qty {item.quantity}</p>
          </li>
        ))}
      </ul>
      <ClaimGuestBatchPanel />
    </div>
  )
}
