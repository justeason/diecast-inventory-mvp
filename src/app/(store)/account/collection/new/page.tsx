import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { CollectionItemForm } from '@/components/store/CollectionItemForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Add to Collection | CollectNTrades',
  robots: { index: false, follow: false },
}

export default async function NewCollectionItemPage() {
  const session = await getBuyerSession()
  if (!session) notFound()

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link href="/account/collection" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to My Collection
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Add to Collection</h1>
      <CollectionItemForm mode="create" />
    </div>
  )
}
