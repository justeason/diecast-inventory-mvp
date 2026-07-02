import Link from 'next/link'
import { prisma } from '@/lib/prisma'

export default async function AdminCatalogPage() {
  const models = await prisma.catalogModel.findMany({
    include: { _count: { select: { items: true } } },
    orderBy: [{ brand: 'asc' }, { name: 'asc' }],
  })

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Catalog Models</h1>
        <div className="flex items-center gap-4">
          <Link href="/admin/catalog/duplicates" className="text-sm text-gray-600 hover:text-gray-900">
            Find Duplicates →
          </Link>
          <Link
            href="/admin/catalog/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            New Model
          </Link>
        </div>
      </div>

      {models.length === 0 ? (
        <p className="text-sm text-gray-500">No catalog models yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Brand</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Series</th>
                <th className="px-4 py-3 font-medium">Year</th>
                <th className="px-4 py-3 font-medium">Color</th>
                <th className="px-4 py-3 font-medium">Scale</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {models.map((model) => (
                <tr key={model.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">{model.brand}</td>
                  <td className="px-4 py-3 font-medium">{model.name}</td>
                  <td className="px-4 py-3 text-gray-500">{model.series ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{model.year ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{model.color ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{model.scale ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{model._count.items}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/catalog/${model.id}/edit`} className="text-blue-600 hover:underline text-sm">
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
