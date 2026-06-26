import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { EditListingForm } from '@/components/admin/ListingForm'

export default async function EditListingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { item: { include: { catalog: true, location: true } } },
  })

  if (!listing) notFound()

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/listings" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Listings
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Edit Listing</h1>
      </div>
      <EditListingForm listing={listing} />
    </>
  )
}
