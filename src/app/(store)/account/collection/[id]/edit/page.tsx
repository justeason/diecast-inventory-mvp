import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { CollectionItemForm } from '@/components/store/CollectionItemForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Edit Collection Item | CollectNTrades',
  robots: { index: false, follow: false },
}

export default async function EditCollectionItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getBuyerSession()
  if (!session) notFound()

  const [item, catalogModels] = await Promise.all([
    prisma.collectionItem.findFirst({
      where: { id, profileId: session.profileId },
    }),
    prisma.catalogModel.findMany({
      orderBy: [{ brand: 'asc' }, { name: 'asc' }],
      select: { id: true, brand: true, name: true, year: true, color: true, series: true },
    }),
  ])
  if (!item) notFound()

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link
          href={`/account/collection/${item.id}`}
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          ← Back to item
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Edit Collection Item</h1>
      <CollectionItemForm mode="edit" item={item} catalogModels={catalogModels} />
    </div>
  )
}
