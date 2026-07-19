import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { CatalogModelForm } from '@/components/admin/CatalogModelForm'
import { CatalogPhotoUpload } from '@/components/admin/CatalogPhotoUpload'

export default async function EditCatalogModelPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const model = await prisma.catalogModel.findUnique({
    where: { id },
    include: {
      photos: { orderBy: { sortOrder: 'asc' }, select: { id: true, url: true, altText: true } },
    },
  })
  if (!model) notFound()

  const primaryPhoto = model.photos[0] ?? null

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/catalog" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Catalog
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Edit — {model.brand} {model.name}</h1>
      </div>
      <CatalogModelForm model={model} />
      <div className="mt-8 pt-6 border-t border-gray-200 max-w-lg">
        <CatalogPhotoUpload catalogId={model.id} photo={primaryPhoto} />
      </div>
    </>
  )
}
