import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { ItemInstanceForm } from '@/components/admin/ItemInstanceForm'

export default async function NewItemPage() {
  const [catalogModels, locations] = await Promise.all([
    prisma.catalogModel.findMany({ orderBy: [{ brand: 'asc' }, { name: 'asc' }] }),
    prisma.storageLocation.findMany({ orderBy: { label: 'asc' } }),
  ])

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/items" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Items
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">New Item Instance</h1>
      </div>
      <ItemInstanceForm catalogModels={catalogModels} locations={locations} />
    </>
  )
}
