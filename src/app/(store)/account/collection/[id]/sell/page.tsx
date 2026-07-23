import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { SellItemForm } from '@/components/store/SellItemForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sell Request | CollectNTrades',
  robots: { index: false, follow: false },
}

function displayName(item: {
  brand: string | null
  name: string | null
  catalog: { brand: string; name: string } | null
}): string {
  if (item.catalog) return `${item.catalog.brand} ${item.catalog.name}`
  const parts = [item.brand, item.name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Unnamed item'
}

export default async function SellItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getBuyerSession()
  if (!session) notFound()

  const item = await prisma.collectionItem.findFirst({
    where: { id, profileId: session.profileId },
    select: {
      id: true,
      brand: true,
      name: true,
      series: true,
      year: true,
      color: true,
      scale: true,
      condition: true,
      conditionNotes: true,
      quantity: true,
      catalog: { select: { brand: true, name: true } },
      sellerSubmissions: {
        where: { status: { in: ['submitted', 'under_review', 'needs_info'] } },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!item) notFound()

  const name = displayName(item)
  const activeSubmission = item.sellerSubmissions[0] ?? null

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link
          href={`/account/collection/${id}`}
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          ← Back to {name}
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Request to sell</h1>
      <p className="text-base text-gray-600 mb-6">{name}</p>

      {activeSubmission ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4 space-y-2">
          <p className="text-sm font-medium text-amber-900">
            You already have an active sell request for this item.
          </p>
          <p className="text-sm text-amber-700">
            You can track its status on your sell requests page.
          </p>
          <div className="flex flex-col gap-1.5 pt-1">
            <Link
              href={`/account/sell/${activeSubmission.id}`}
              className="text-sm font-medium text-amber-900 underline underline-offset-2"
            >
              View sell request →
            </Link>
            <Link
              href={`/account/collection/${id}`}
              className="text-sm text-amber-700 hover:text-amber-900"
            >
              ← Back to item
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-6 rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm space-y-1">
            <p className="font-medium text-gray-900">{name}</p>
            {item.series && <p className="text-gray-500">Series: {item.series}</p>}
            {item.year && <p className="text-gray-500">Year: {item.year}</p>}
            {item.color && <p className="text-gray-500">Color: {item.color}</p>}
            {item.scale && <p className="text-gray-500">Scale: {item.scale}</p>}
          </div>

          <SellItemForm
            collectionItemId={item.id}
            prefill={{
              condition: item.condition,
              conditionNotes: item.conditionNotes,
              quantity: item.quantity,
            }}
          />

          <div className="mt-5">
            <Link
              href={`/account/collection/${id}`}
              className="text-sm text-gray-500 hover:text-gray-900"
            >
              ← Cancel, back to item
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
