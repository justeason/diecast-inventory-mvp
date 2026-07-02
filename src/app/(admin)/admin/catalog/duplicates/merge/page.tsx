import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { CatalogMergeForm } from '@/components/admin/CatalogMergeForm'
import { mergeCatalogModels } from '@/lib/actions/catalog'

export const dynamic = 'force-dynamic'

export default async function CatalogMergePage({
  searchParams,
}: {
  searchParams: Promise<{ representativeId?: string }>
}) {
  const { representativeId } = await searchParams
  if (!representativeId) notFound()

  const representative = await prisma.catalogModel.findUnique({
    where: { id: representativeId },
    select: { brand: true, name: true },
  })
  if (!representative) notFound()

  // Find all catalog models with the same brand + name (case-insensitive).
  const allModels = await prisma.catalogModel.findMany({
    where: {
      brand: { equals: representative.brand, mode: 'insensitive' },
      name:  { equals: representative.name,  mode: 'insensitive' },
    },
    include: {
      items: { select: { listing: { select: { id: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  })

  if (allModels.length < 2) {
    return (
      <>
        <div className="mb-6">
          <Link href="/admin/catalog/duplicates" className="text-sm text-gray-500 hover:text-gray-900">
            ← Back to Duplicates
          </Link>
        </div>
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          This group no longer has duplicates — it may have already been merged.
        </div>
      </>
    )
  }

  const models = allModels.map((m) => ({
    id:           m.id,
    brand:        m.brand,
    name:         m.name,
    year:         m.year,
    series:       m.series,
    color:        m.color,
    scale:        m.scale,
    notes:        m.notes,
    itemCount:    m.items.length,
    listingCount: m.items.filter((i) => i.listing).length,
    createdAt:    m.createdAt.toISOString(),
  }))

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/catalog/duplicates" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Duplicates
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">
          Merge: {representative.brand} · {representative.name}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {allModels.length} catalog records share this brand and name. Select one to keep as
          canonical, check the ones to merge away, then confirm.
        </p>
      </div>

      <CatalogMergeForm action={mergeCatalogModels} models={models} />
    </>
  )
}
