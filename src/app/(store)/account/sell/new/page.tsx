import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { ManualSellRequestForm } from '@/components/store/ManualSellRequestForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Submit a Sell Request | CollectNTrades',
  robots: { index: false, follow: false },
}

export default async function ManualSellRequestPage() {
  const session = await getBuyerSession()
  if (!session) notFound()

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link href="/account/sell" className="text-sm text-gray-500 hover:text-gray-900">
          ← Sell Requests
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">Submit a sell request</h1>
      <p className="text-sm text-gray-500 mb-8">
        Use this form if the item is not already in your collection. Admin will review it before
        anything becomes inventory or public.
      </p>

      <ManualSellRequestForm />
    </div>
  )
}
