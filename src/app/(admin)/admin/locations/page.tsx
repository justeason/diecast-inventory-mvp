import Link from 'next/link'
import { prisma } from '@/lib/prisma'

export default async function AdminLocationsPage() {
  const locations = await prisma.storageLocation.findMany({
    include: { _count: { select: { items: true } } },
    orderBy: { label: 'asc' },
  })

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Storage Locations</h1>
        <Link
          href="/admin/locations/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          New Location
        </Link>
      </div>

      {locations.length === 0 ? (
        <p className="text-sm text-gray-500">No storage locations yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">Notes</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {locations.map((loc) => (
                <tr key={loc.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{loc.label}</td>
                  <td className="px-4 py-3 text-gray-500">{loc.notes ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{loc._count.items}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/locations/${loc.id}/edit`} className="text-blue-600 hover:underline text-sm">
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
