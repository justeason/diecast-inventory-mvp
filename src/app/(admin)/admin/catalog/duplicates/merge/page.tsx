import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { PairMergeForm } from '@/components/admin/PairMergeForm'
import { mergeCatalogModels } from '@/lib/actions/catalog'

export const dynamic = 'force-dynamic'

export default async function CatalogMergePage({
  searchParams,
}: {
  searchParams: Promise<{ canonicalId?: string; duplicateId?: string }>
}) {
  const { canonicalId, duplicateId } = await searchParams
  if (!canonicalId || !duplicateId) notFound()
  if (canonicalId === duplicateId) notFound()

  const [canonical, duplicate] = await Promise.all([
    prisma.catalogModel.findUnique({
      where: { id: canonicalId },
      include: {
        _count: { select: { items: true, collectionItems: true, sellerSubmissions: true } },
        items: { select: { listing: { select: { id: true } }, status: true } },
      },
    }),
    prisma.catalogModel.findUnique({
      where: { id: duplicateId },
      include: {
        _count: { select: { items: true, collectionItems: true, sellerSubmissions: true } },
        items: { select: { listing: { select: { id: true } }, status: true } },
      },
    }),
  ])

  if (!canonical || !duplicate) notFound()

  const activeListings = duplicate.items.filter((i) => i.listing && i.status !== 'sold').length
  const soldItems = duplicate.items.filter((i) => i.status === 'sold').length

  const canonicalLabel = [canonical.brand, canonical.name, canonical.year ? `(${canonical.year})` : null, canonical.color].filter(Boolean).join(' ')
  const duplicateLabel = [duplicate.brand, duplicate.name, duplicate.year ? `(${duplicate.year})` : null, duplicate.color].filter(Boolean).join(' ')

  return (
    <>
      <div className="mb-6">
        <Link
          href={`/admin/catalog/duplicates/review?idA=${canonicalId}&idB=${duplicateId}`}
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          ← Back to Review
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Confirm Merge</h1>
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-4 mb-6 space-y-3 text-sm">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Keep (canonical)</p>
          <p className="font-medium text-gray-900">{canonicalLabel}</p>
          <p className="text-xs text-gray-400">{canonicalId}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Delete (duplicate)</p>
          <p className="font-medium text-gray-900">{duplicateLabel}</p>
          <p className="text-xs text-gray-400">{duplicateId}</p>
        </div>
        <div className="border-t border-gray-100 pt-3 space-y-1 text-gray-600">
          <p>Items to reassign: <strong>{duplicate._count.items}</strong></p>
          <p>Collection items to reassign: <strong>{duplicate._count.collectionItems}</strong></p>
          <p>Sell requests to reassign: <strong>{duplicate._count.sellerSubmissions}</strong></p>
          {activeListings > 0 && (
            <p className="text-amber-700 font-medium">⚠ {activeListings} active listing{activeListings !== 1 ? 's' : ''} will be reassigned to canonical.</p>
          )}
          {soldItems > 0 && (
            <p className="text-gray-500">ℹ {soldItems} sold item{soldItems !== 1 ? 's' : ''} will be reassigned (historical record).</p>
          )}
        </div>
      </div>

      <PairMergeForm
        action={mergeCatalogModels}
        canonicalId={canonicalId}
        duplicateId={duplicateId}
        canonicalLabel={canonicalLabel}
      />
    </>
  )
}
