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
    include: {
      item: {
        include: {
          catalog: true,
          location: true,
          _count: { select: { photos: true } },
        },
      },
    },
  })

  if (!listing) notFound()

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/listings" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Listings
        </Link>
        <div className="flex items-baseline gap-4 mt-2">
          <h1 className="text-2xl font-bold text-gray-900">Edit Listing</h1>
          <Link
            href={`/admin/items/${listing.item.id}/edit`}
            className="text-sm text-blue-600 hover:underline"
          >
            View Item →
          </Link>
        </div>
      </div>
      {listing.status === 'active' && listing.item._count.photos === 0 && (
        <div className="mb-6 max-w-lg rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This listing has no actual item photos. Buyers may see a catalog reference image if
          available, but actual item photos are recommended.
        </div>
      )}
      <EditListingForm listing={listing} />
    </>
  )
}
