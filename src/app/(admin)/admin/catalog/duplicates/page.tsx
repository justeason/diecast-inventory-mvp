import Link from 'next/link'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export default async function CatalogDuplicatesPage() {
  const models = await prisma.catalogModel.findMany({
    include: {
      items: { select: { listing: { select: { id: true } } } },
    },
    orderBy: [{ brand: 'asc' }, { name: 'asc' }],
  })

  // Group by normalized brand + name.
  const groupMap = new Map<string, typeof models>()
  for (const model of models) {
    const key = `${model.brand.trim().toLowerCase()}|${model.name.trim().toLowerCase()}`
    if (!groupMap.has(key)) groupMap.set(key, [])
    groupMap.get(key)!.push(model)
  }

  const duplicateGroups = [...groupMap.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => b.length - a.length)

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/catalog" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Catalog
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Catalog Duplicate Review</h1>
      </div>

      {duplicateGroups.length === 0 ? (
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          No duplicate candidates found — your catalog looks clean.
        </div>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            Found {duplicateGroups.length} group{duplicateGroups.length !== 1 ? 's' : ''} with matching
            brand and name. Review each group and merge if appropriate.
          </p>

          {duplicateGroups.map((group) => {
            const first = group[0]
            const totalItems    = group.reduce((n, m) => n + m.items.length, 0)
            const totalListings = group.reduce((n, m) => n + m.items.filter((i) => i.listing).length, 0)
            const key = `${first.brand}|${first.name}`

            return (
              <div key={key} className="rounded-md border border-gray-200 bg-white">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                  <div>
                    <span className="font-medium text-gray-900">
                      {first.brand} · {first.name}
                    </span>
                    <span className="ml-3 text-xs text-gray-400">
                      {group.length} records · {totalItems} item{totalItems !== 1 ? 's' : ''} ·{' '}
                      {totalListings} listing{totalListings !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <Link
                    href={`/admin/catalog/duplicates/merge?representativeId=${first.id}`}
                    className="text-sm font-medium text-blue-600 hover:underline"
                  >
                    Review & Merge →
                  </Link>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left text-xs text-gray-500">
                        <th className="px-4 py-2 font-medium">Year</th>
                        <th className="px-4 py-2 font-medium">Color</th>
                        <th className="px-4 py-2 font-medium">Series</th>
                        <th className="px-4 py-2 font-medium">Scale</th>
                        <th className="px-4 py-2 font-medium">Items</th>
                        <th className="px-4 py-2 font-medium">Listings</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {group.map((model) => (
                        <tr key={model.id}>
                          <td className="px-4 py-2 text-gray-700">{model.year    ?? '—'}</td>
                          <td className="px-4 py-2 text-gray-700">{model.color   ?? '—'}</td>
                          <td className="px-4 py-2 text-gray-700">{model.series  ?? '—'}</td>
                          <td className="px-4 py-2 text-gray-700">{model.scale   ?? '—'}</td>
                          <td className="px-4 py-2 text-gray-700">{model.items.length}</td>
                          <td className="px-4 py-2 text-gray-700">
                            {model.items.filter((i) => i.listing).length}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
