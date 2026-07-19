import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { ItemInstanceForm } from '@/components/admin/ItemInstanceForm'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'

export default async function EditItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [item, catalogModels, locations] = await Promise.all([
    prisma.itemInstance.findUnique({
      where: { id },
      include: {
        photos: { select: { url: true, type: true }, orderBy: { sortOrder: 'asc' } },
        listing: { select: { id: true, status: true } },
      },
    }),
    prisma.catalogModel.findMany({ orderBy: [{ brand: 'asc' }, { name: 'asc' }] }),
    prisma.storageLocation.findMany({ orderBy: { label: 'asc' } }),
  ])

  if (!item) notFound()

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/items" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Items
        </Link>
        <div className="flex items-baseline gap-4 mt-2 flex-wrap">
          <h1 className="text-2xl font-bold text-gray-900">Edit — {item.sku}</h1>
          {item.listing ? (
            <Link
              href={`/admin/listings/${item.listing.id}/edit`}
              className="text-sm text-blue-600 hover:underline"
            >
              View Listing →
            </Link>
          ) : (
            <Link
              href={`/admin/listings/new?itemId=${item.id}`}
              className="text-sm text-green-700 hover:underline"
            >
              Create Listing →
            </Link>
          )}
          <Link
            href={`/admin/items/new?from=${item.id}`}
            className="text-sm text-gray-500 hover:underline"
          >
            Duplicate →
          </Link>
        </div>
      </div>

      {item.listing?.status === 'active' && item.photos.length === 0 && (
        <div className="mb-6 max-w-2xl rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This item is listed without actual item photos. Add item photos when possible so buyers
          can verify condition.
        </div>
      )}

      {item.photos.length > 0 && (
        <div className="mb-6 max-w-2xl">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Photos</h2>
          <div className="flex flex-wrap gap-3">
            {item.photos.map((photo, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="h-32 w-32 overflow-hidden rounded-md">
                  <PhotoThumbnail photoUrl={photo.url} alt={`${photo.type} photo`} size="fill" />
                </div>
                <p className="text-xs text-gray-500 capitalize text-center">{photo.type}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <ItemInstanceForm item={item} catalogModels={catalogModels} locations={locations} />
    </>
  )
}
