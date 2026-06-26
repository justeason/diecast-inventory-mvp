import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { ItemInstanceForm } from '@/components/admin/ItemInstanceForm'

export default async function EditItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [item, catalogModels, locations] = await Promise.all([
    prisma.itemInstance.findUnique({ where: { id } }),
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
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Edit — {item.sku}</h1>
      </div>
      <ItemInstanceForm item={item} catalogModels={catalogModels} locations={locations} />
    </>
  )
}
