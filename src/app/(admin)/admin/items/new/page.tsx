import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { ItemInstanceForm } from '@/components/admin/ItemInstanceForm'

export default async function NewItemPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>
}) {
  const { from } = await searchParams

  const [catalogModels, locations, sourceItem] = await Promise.all([
    prisma.catalogModel.findMany({ orderBy: [{ brand: 'asc' }, { name: 'asc' }] }),
    prisma.storageLocation.findMany({ orderBy: { label: 'asc' } }),
    from ? prisma.itemInstance.findUnique({ where: { id: from } }) : Promise.resolve(null),
  ])

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/items" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Items
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">
          {sourceItem ? `Duplicate — ${sourceItem.sku}` : 'New Item Instance'}
        </h1>
        {sourceItem && (
          <p className="text-sm text-gray-500 mt-1">
            Fields pre-filled from {sourceItem.sku}. Enter a new unique SKU to save.
          </p>
        )}
      </div>
      <ItemInstanceForm
        catalogModels={catalogModels}
        locations={locations}
        prefill={sourceItem ?? undefined}
      />
    </>
  )
}
