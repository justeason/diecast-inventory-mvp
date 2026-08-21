import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { ManualSellRequestForm } from '@/components/store/ManualSellRequestForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Submit a Sell Request | CollectNTrades',
  robots: { index: false, follow: false },
}

export default async function ManualSellRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ catalogId?: string }>
}) {
  const session = await getBuyerSession()
  if (!session) notFound()

  // 16F: Sell One from a catalog card that isn't in the customer's Collection yet
  // (Part 23) — catalogId only identifies WHICH model to prefill from; the actual
  // brand/name/etc values always come from this server-side re-fetch, never
  // trusted from the query string itself.
  const { catalogId } = await searchParams
  const catalogModel = catalogId
    ? await prisma.catalogModel.findUnique({
        where: { id: catalogId },
        select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
      })
    : null

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

      <ManualSellRequestForm
        initial={
          catalogModel
            ? {
                catalogId: catalogModel.id,
                brand: catalogModel.brand,
                name: catalogModel.name,
                series: catalogModel.series,
                year: catalogModel.year,
                color: catalogModel.color,
                scale: catalogModel.scale,
              }
            : undefined
        }
      />
    </div>
  )
}
