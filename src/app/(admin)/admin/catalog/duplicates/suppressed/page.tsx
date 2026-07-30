import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { unsuppressPair } from '@/lib/actions/catalogDuplicates'
import { UnsuppressForm } from '@/components/admin/UnsuppressForm'

export const dynamic = 'force-dynamic'

export default async function SuppressedPage() {
  const suppressions = await prisma.catalogDuplicateSuppression.findMany({
    orderBy: { createdAt: 'desc' },
  })

  // Fetch model names for both IDs in each pair
  const allIds = [...new Set(suppressions.flatMap((s) => s.pairKey.split('|')))]
  const models = await prisma.catalogModel.findMany({
    where: { id: { in: allIds } },
    select: { id: true, brand: true, name: true, year: true, color: true },
  })
  const modelMap = new Map(models.map((m) => [m.id, m]))

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/catalog/duplicates" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Duplicates
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Suppressed Pairs</h1>
        <p className="text-sm text-gray-500 mt-1">
          {suppressions.length} suppressed pair{suppressions.length !== 1 ? 's' : ''}. These pairs are excluded from the duplicates dashboard.
        </p>
      </div>

      {suppressions.length === 0 ? (
        <div className="rounded-md bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600">
          No suppressed pairs.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
          {suppressions.map((s) => {
            const [idA, idB] = s.pairKey.split('|')
            const mA = modelMap.get(idA)
            const mB = modelMap.get(idB)
            const labelA = mA
              ? `${mA.brand} · ${mA.name}${mA.year ? ` (${mA.year})` : ''}${mA.color ? ` — ${mA.color}` : ''}`
              : `Deleted (${idA?.slice(0, 8)}…)`
            const labelB = mB
              ? `${mB.brand} · ${mB.name}${mB.year ? ` (${mB.year})` : ''}${mB.color ? ` — ${mB.color}` : ''}`
              : `Deleted (${idB?.slice(0, 8)}…)`

            return (
              <div key={s.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 truncate">{labelA}</p>
                  <p className="text-xs text-gray-500 truncate">vs. {labelB}</p>
                  {s.adminNote && (
                    <p className="text-xs text-gray-400 mt-0.5">{s.adminNote}</p>
                  )}
                </div>
                <UnsuppressForm action={unsuppressPair} pairKey={s.pairKey} />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
