import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { suppressPair } from '@/lib/actions/catalogDuplicates'
import { stablePairKey, scorePair } from '@/lib/catalogDuplicateDetection'
import { SuppressPairForm } from '@/components/admin/SuppressPairForm'
import { getMergeImpactSummary } from '@/lib/catalogDataQualityQuery'

export const dynamic = 'force-dynamic'

type Model = {
  id: string
  brand: string
  name: string
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
  notes: string | null
  createdAt: Date
  _count: {
    items: number
    collectionItems: number
    sellerSubmissions: number
  }
  items: { listing: { id: string } | null; status: string }[]
}

function diff(a: string | number | null | undefined, b: string | number | null | undefined) {
  if (a === b) return false
  if ((a ?? null) === null && (b ?? null) === null) return false
  return true
}

function FieldRow({
  label,
  valA,
  valB,
}: {
  label: string
  valA: string | number | null | undefined
  valB: string | number | null | undefined
}) {
  const differs = diff(valA, valB)
  return (
    <tr className={differs ? 'bg-amber-50' : ''}>
      <td className="px-3 py-1.5 text-xs text-gray-500 font-medium w-20">{label}</td>
      <td className={`px-3 py-1.5 text-sm ${differs ? 'font-medium text-amber-900' : 'text-gray-700'}`}>
        {valA ?? <span className="text-gray-300">—</span>}
      </td>
      <td className={`px-3 py-1.5 text-sm ${differs ? 'font-medium text-amber-900' : 'text-gray-700'}`}>
        {valB ?? <span className="text-gray-300">—</span>}
      </td>
    </tr>
  )
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ idA?: string; idB?: string }>
}) {
  const { idA, idB } = await searchParams
  if (!idA || !idB) notFound()

  const [modelA, modelB, mergeImpact] = await Promise.all([
    prisma.catalogModel.findUnique({
      where: { id: idA },
      include: {
        _count: { select: { items: true, collectionItems: true, sellerSubmissions: true } },
        items: { select: { listing: { select: { id: true } }, status: true } },
      },
    }),
    prisma.catalogModel.findUnique({
      where: { id: idB },
      include: {
        _count: { select: { items: true, collectionItems: true, sellerSubmissions: true } },
        items: { select: { listing: { select: { id: true } }, status: true } },
      },
    }),
    getMergeImpactSummary(idA, idB),
  ]) as [Model | null, Model | null, Awaited<ReturnType<typeof getMergeImpactSummary>>]

  if (!modelA || !modelB) notFound()

  const { score, matchReasons } = scorePair(modelA, modelB)
  const pairKey = stablePairKey(idA, idB)

  const activeListingsA = modelA.items.filter((i) => i.listing && i.status !== 'sold').length
  const activeListingsB = modelB.items.filter((i) => i.listing && i.status !== 'sold').length
  const soldA = modelA.items.filter((i) => i.status === 'sold').length
  const soldB = modelB.items.filter((i) => i.status === 'sold').length

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/catalog/duplicates" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Duplicates
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Review Pair</h1>
        <p className="text-sm text-gray-500 mt-1">
          Similarity score: <strong>{score}/100</strong> · {matchReasons.join(' · ')}
        </p>
      </div>

      {/* Side-by-side comparison */}
      <div className="rounded-md border border-gray-200 bg-white overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-2 text-xs text-gray-500 font-medium text-left w-20">Field</th>
              <th className="px-3 py-2 text-xs text-gray-500 font-medium text-left">
                Model A
                <span className="ml-2 text-gray-400 font-normal text-xs">{idA.slice(0, 8)}…</span>
              </th>
              <th className="px-3 py-2 text-xs text-gray-500 font-medium text-left">
                Model B
                <span className="ml-2 text-gray-400 font-normal text-xs">{idB.slice(0, 8)}…</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            <FieldRow label="Brand" valA={modelA.brand} valB={modelB.brand} />
            <FieldRow label="Name" valA={modelA.name} valB={modelB.name} />
            <FieldRow label="Year" valA={modelA.year} valB={modelB.year} />
            <FieldRow label="Color" valA={modelA.color} valB={modelB.color} />
            <FieldRow label="Series" valA={modelA.series} valB={modelB.series} />
            <FieldRow label="Scale" valA={modelA.scale} valB={modelB.scale} />
            <FieldRow label="Notes" valA={modelA.notes} valB={modelB.notes} />
          </tbody>
        </table>
      </div>

      {/* Merge impact summary */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Pre-merge impact (re-fetched after lock)
        </p>
        <div className="grid grid-cols-2 gap-4">
          {([
            { label: 'Model A', impact: mergeImpact.modelA, activeListings: activeListingsA, sold: soldA },
            { label: 'Model B', impact: mergeImpact.modelB, activeListings: activeListingsB, sold: soldB },
          ] as const).map(({ label, impact, activeListings, sold }) => (
            <div key={label} className="rounded-md border border-gray-200 bg-white px-4 py-3 text-sm space-y-1">
              <p className="font-medium text-gray-700 mb-2">{label}</p>
              <p className="text-gray-600">Inventory items: <strong>{impact.itemInstances}</strong></p>
              <p className="text-gray-600">
                Active listings:{' '}
                <strong className={activeListings > 0 ? 'text-amber-700' : ''}>{activeListings}</strong>
              </p>
              <p className="text-gray-600">Sold: <strong>{sold}</strong></p>
              <p className="text-gray-600">Collection items: <strong>{impact.collectionItems}</strong></p>
              <p className="text-gray-600">Wanted by: <strong>{impact.wantedBy}</strong></p>
              <p className="text-gray-600">Sell requests: <strong>{impact.sellerSubmissions}</strong></p>
              <p className="text-gray-600">Photos: <strong>{impact.photos}</strong></p>
              <p className="text-gray-600">Fingerprints: <strong>{impact.fingerprints}</strong></p>
              <p className="text-gray-600">Market observations: <strong>{impact.externalObs}</strong></p>
            </div>
          ))}
        </div>
        {(activeListingsA > 0 || activeListingsB > 0) && (
          <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Warning: one or more models have active listings. Merging will reassign all inventory to the canonical model.
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3 flex-wrap">
        <Link
          href={`/admin/catalog/duplicates/merge?canonicalId=${idA}&duplicateId=${idB}`}
          className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          Keep A, merge B into A →
        </Link>
        <Link
          href={`/admin/catalog/duplicates/merge?canonicalId=${idB}&duplicateId=${idA}`}
          className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          Keep B, merge A into B →
        </Link>
        <SuppressPairForm action={suppressPair} idA={idA} idB={idB} pairKey={pairKey} />
      </div>
    </>
  )
}
