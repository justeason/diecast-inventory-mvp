import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { StorageLocationForm } from '@/components/admin/StorageLocationForm'

export default async function EditLocationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const location = await prisma.storageLocation.findUnique({ where: { id } })
  if (!location) notFound()

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/locations" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Locations
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Edit — {location.label}</h1>
      </div>
      <StorageLocationForm location={location} />
    </>
  )
}
