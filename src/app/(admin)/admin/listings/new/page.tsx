import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { CreateListingForm } from '@/components/admin/ListingForm'

export default async function NewListingPage({
  searchParams,
}: {
  searchParams: Promise<{ itemId?: string }>
}) {
  const { itemId } = await searchParams

  const eligibleItems = await prisma.itemInstance.findMany({
    where: { status: 'available', listing: null },
    include: { catalog: true, location: true },
    orderBy: { sku: 'asc' },
  })

  const preSelectedItem = itemId
    ? (eligibleItems.find((item) => item.id === itemId) ?? null)
    : null

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/listings" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Listings
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">New Listing</h1>
      </div>
      <CreateListingForm items={eligibleItems} preSelectedItem={preSelectedItem} />
    </>
  )
}
