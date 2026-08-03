import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { WantedEditForm } from '@/components/store/WantedEditForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Edit Wanted Entry | CollectNTrades',
  robots: { index: false, follow: false },
}

export default async function WantedEditPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getBuyerSession()
  if (!session) notFound()

  const { id } = await params
  const entry = await prisma.wantedCatalogModel.findFirst({
    where: { id, customerProfileId: session.profileId },
    select: {
      id: true,
      maxDesiredPrice: true,
      notes: true,
      catalogModel: { select: { brand: true, name: true, year: true } },
    },
  })
  if (!entry) notFound()

  const modelName = `${entry.catalogModel.brand} ${entry.catalogModel.name}${entry.catalogModel.year ? ` (${entry.catalogModel.year})` : ''}`

  return (
    <div className="max-w-md">
      <div className="mb-6">
        <Link href="/account/wanted" className="text-sm text-gray-500 hover:text-gray-900">
          ← Wanted List
        </Link>
      </div>

      <h1 className="text-xl font-bold text-gray-900 mb-1">Edit wanted entry</h1>
      <p className="text-sm text-gray-500 mb-6">{modelName}</p>

      <WantedEditForm
        id={entry.id}
        defaultMaxPrice={entry.maxDesiredPrice?.toString() ?? ''}
        defaultNotes={entry.notes ?? ''}
      />
    </div>
  )
}
