import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getModelQualityDetail } from '@/lib/catalogDataQualityQuery'
import { CatalogQualityRepairForms } from '@/components/admin/CatalogQualityRepairForms'
import type { IssueSeverity } from '@/lib/catalogDataQuality'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  return { title: `Quality: ${id.slice(0, 8)}… | Admin` }
}

const SEVERITY_COLORS: Record<IssueSeverity, string> = {
  error:   'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info:    'bg-gray-100 text-gray-600',
}

export default async function CatalogModelQualityPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const detail = await getModelQualityDetail(id)
  if (!detail) notFound()

  const { model, photos, refCounts, issues, recentAudits, duplicateCandidates } = detail

  const errors   = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')
  const infos    = issues.filter(i => i.severity === 'info')

  return (
    <div className="max-w-4xl space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/admin/catalog-quality" className="text-sm text-gray-500 hover:text-gray-900">
            ← Catalog Quality
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">
            {model.brand} · {model.name}
            {model.year ? ` (${model.year})` : ''}
          </h1>
          <p className="text-xs font-mono text-gray-400 mt-0.5">{model.id}</p>
        </div>
        <div className="flex gap-2 mt-6">
          <Link
            href={`/admin/catalog/${model.id}/edit`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Edit metadata →
          </Link>
          <Link
            href={`/admin/catalog/duplicates?search=${encodeURIComponent(model.brand)}`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Check duplicates →
          </Link>
        </div>
      </div>

      {/* Metadata */}
      <section className="rounded-md border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-50">
            {[
              ['Brand',  model.brand],
              ['Name',   model.name],
              ['Series', model.series ?? '—'],
              ['Year',   model.year?.toString() ?? '—'],
              ['Color',  model.color ?? '—'],
              ['Scale',  model.scale ?? '—'],
              ['Notes',  model.notes ?? '—'],
              ['Created', model.createdAt.toLocaleDateString()],
              ['Updated', model.updatedAt.toISOString()],
            ].map(([label, value]) => (
              <tr key={label}>
                <td className="px-3 py-2 text-xs text-gray-400 font-medium w-24">{label}</td>
                <td className="px-3 py-2 text-gray-800">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Photos */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Photos ({photos.length})
        </h2>
        {photos.length === 0 ? (
          <p className="text-sm text-gray-400">No photos.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {photos.map((photo, i) => (
              <div key={photo.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={photo.altText ?? model.name}
                  className="w-24 h-24 rounded-md object-contain border border-gray-200 bg-white"
                />
                {i === 0 && (
                  <span className="absolute top-1 left-1 rounded px-1 py-0.5 text-xs bg-blue-600 text-white">
                    Primary
                  </span>
                )}
                {!photo.hasCurrentFingerprint && (
                  <span className="absolute bottom-1 left-1 rounded px-1 py-0.5 text-xs bg-amber-500 text-white">
                    No FP
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {photos.some(p => !p.hasCurrentFingerprint) && (
          <p className="text-xs text-amber-600">
            Some photos are missing fingerprints.{' '}
            <Link href="/admin/catalog-image-intelligence" className="underline">
              Use Image Intelligence backfill →
            </Link>
          </p>
        )}
      </section>

      {/* Reference counts — no PII */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          References
        </h2>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {([
            ['Inventory items', refCounts.itemInstances],
            ['Active listings', refCounts.activeListings],
            ['Sold items',      refCounts.soldItems],
            ['Collection',      refCounts.collectionItems],
            ['Wanted by',       refCounts.wantedBy],
            ['Sell requests',   refCounts.sellerSubmissions],
            ['Market obs.',     refCounts.externalObs],
            ['Fingerprints',    refCounts.fingerprints],
          ] as [string, number][]).map(([label, count]) => (
            <div key={label} className="rounded-md border border-gray-200 bg-white p-3 text-center">
              <p className={`text-xl font-bold ${count > 0 ? 'text-gray-900' : 'text-gray-300'}`}>
                {count}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Issues */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Issues ({issues.length})
        </h2>

        {issues.length === 0 ? (
          <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
            No issues detected for this model.
          </div>
        ) : (
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {[...errors, ...warnings, ...infos].map(issue => (
              <div key={issue.issueKey} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={`shrink-0 mt-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_COLORS[issue.severity]}`}
                >
                  {issue.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-gray-400">{issue.issueType}</p>
                  <p className="text-sm text-gray-800">{issue.detail}</p>
                  {issue.repairPreview && (
                    <p className="text-xs text-blue-600 mt-0.5 font-mono">{issue.repairPreview}</p>
                  )}
                </div>
                {!issue.repairAction && (
                  <span className="text-xs text-gray-400 shrink-0 mt-1">view-only</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Repair forms — client component handles confirmation flow */}
      {issues.some(i => i.repairAction) && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Safe Repairs
          </h2>
          <p className="text-xs text-gray-500">
            Each repair requires explicit confirmation. All repairs are audited. No automatic actions.
          </p>
          <CatalogQualityRepairForms
            catalogModelId={model.id}
            updatedAt={model.updatedAt.toISOString()}
            issues={issues}
          />
        </section>
      )}

      {/* Duplicate candidates */}
      {duplicateCandidates.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Possible Duplicates
          </h2>
          <p className="text-xs text-gray-500">
            Text similarity ≥ 50. Use the{' '}
            <Link href="/admin/catalog/duplicates" className="text-blue-600 hover:underline">
              Duplicate Review
            </Link>{' '}
            workflow for any merge.
          </p>
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {duplicateCandidates.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-xs font-medium text-amber-700 w-12 shrink-0">
                  {c.score}/100
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 truncate">
                    {c.brand} · {c.name}{c.year ? ` (${c.year})` : ''}
                  </p>
                </div>
                <Link
                  href={`/admin/catalog/duplicates/review?idA=${model.id}&idB=${c.id}`}
                  className="text-xs font-medium text-blue-600 hover:underline shrink-0"
                >
                  Review →
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Audit history */}
      {recentAudits.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Repair History (last 10)
          </h2>
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {recentAudits.map(a => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <span className="font-mono text-gray-400 shrink-0">{a.action}</span>
                <span className="text-gray-500 flex-1 min-w-0 truncate">{a.issueKey}</span>
                <span className="text-gray-400 shrink-0">{a.createdAt.toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
