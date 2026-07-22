import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sell Requests | CollectNTrades',
  robots: { index: false, follow: false },
}

export default async function SellRequestsPage() {
  const session = await getBuyerSession()
  if (!session) notFound()

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Sell Requests</h1>
      <p className="text-sm text-gray-500 mb-8">
        Track the status of items you&apos;ve submitted for sale.
      </p>
      <div className="rounded-md border border-gray-200 bg-gray-50 px-6 py-8 text-center">
        <p className="text-sm text-gray-600 mb-4">
          Your sell requests will appear here. Submit a request from any item in your collection.
        </p>
        <Link
          href="/account/collection"
          className="inline-block rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
        >
          Go to My Collection
        </Link>
      </div>
    </div>
  )
}
