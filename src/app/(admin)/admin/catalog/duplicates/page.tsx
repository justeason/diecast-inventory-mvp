import Link from 'next/link'
import { findDuplicatePairs } from '@/lib/actions/catalogDuplicates'

export const dynamic = 'force-dynamic'

const CONFIDENCE_LABELS: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-gray-100 text-gray-600',
}

export default async function CatalogDuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    confidence?: string
    brand?: string
    series?: string
    search?: string
    cursor?: string
  }>
}) {
  const { confidence, brand, series, search, cursor } = await searchParams

  const minScore = confidence === 'high' ? 80 : confidence === 'medium' ? 50 : 1
  const { pairs, nextModelCursor } = await findDuplicatePairs({ minScore, brand, series, search, cursor })

  const filtered = confidence
    ? pairs.filter((p) => p.confidence === confidence)
    : pairs

  // Preserve current filters in pagination/filter links
  const filterBase = [
    brand ? `brand=${encodeURIComponent(brand)}` : '',
    series ? `series=${encodeURIComponent(series)}` : '',
    search ? `search=${encodeURIComponent(search)}` : '',
    confidence ? `confidence=${confidence}` : '',
  ].filter(Boolean).join('&')

  const nextHref = nextModelCursor
    ? `/admin/catalog/duplicates?${filterBase ? filterBase + '&' : ''}cursor=${nextModelCursor}`
    : null

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <Link href="/admin/catalog" className="text-sm text-gray-500 hover:text-gray-900">
            ← Back to Catalog
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">Catalog Duplicate Review</h1>
          <p className="text-sm text-gray-500 mt-1">
            {filtered.length} pair{filtered.length !== 1 ? 's' : ''} found
            {filtered.length >= 100 ? ' (capped at 100)' : ''}.
            Suppressed pairs are excluded.
            {cursor && <span className="ml-1 text-gray-400">(paginated view)</span>}
          </p>
        </div>
        <Link
          href="/admin/catalog/duplicates/suppressed"
          className="text-sm text-gray-500 hover:text-gray-900 mt-8"
        >
          View suppressed →
        </Link>
      </div>

      {/* Filter form */}
      <form method="GET" action="/admin/catalog/duplicates" className="flex gap-2 mb-4 flex-wrap">
        <input
          type="text"
          name="brand"
          defaultValue={brand ?? ''}
          placeholder="Filter by brand…"
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          name="series"
          defaultValue={series ?? ''}
          placeholder="Filter by series…"
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          name="search"
          defaultValue={search ?? ''}
          placeholder="Search brand/name/series…"
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {confidence && <input type="hidden" name="confidence" value={confidence} />}
        <button
          type="submit"
          className="px-3 py-1.5 rounded-md bg-gray-800 text-white text-sm hover:bg-gray-900"
        >
          Search
        </button>
        {(brand || series || search || cursor) && (
          <Link
            href={`/admin/catalog/duplicates${confidence ? `?confidence=${confidence}` : ''}`}
            className="px-3 py-1.5 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
          >
            Clear
          </Link>
        )}
      </form>

      {/* Confidence filter tabs */}
      <div className="flex gap-3 mb-6 flex-wrap">
        {[
          { label: 'All', conf: undefined },
          { label: 'High confidence', conf: 'high' },
          { label: 'Medium', conf: 'medium' },
          { label: 'Low', conf: 'low' },
        ].map(({ label, conf }) => {
          const params = new URLSearchParams()
          if (conf) params.set('confidence', conf)
          if (brand) params.set('brand', brand)
          if (series) params.set('series', series)
          if (search) params.set('search', search)
          const href = `/admin/catalog/duplicates${params.size ? '?' + params.toString() : ''}`
          const active = conf ? confidence === conf : !confidence
          return (
            <Link
              key={label}
              href={href}
              className={`px-3 py-1 rounded-full text-sm border ${
                active
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}
            >
              {label}
            </Link>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          No duplicate candidates found — your catalog looks clean.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
          {filtered.map((pair) => (
            <div key={pair.pairKey} className="flex items-center gap-4 px-4 py-3">
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_COLORS[pair.confidence]}`}
              >
                {CONFIDENCE_LABELS[pair.confidence]} {pair.score}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {pair.modelA.brand} · {pair.modelA.name}
                  {pair.modelA.year ? ` (${pair.modelA.year})` : ''}
                  {pair.modelA.color ? ` — ${pair.modelA.color}` : ''}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  vs. {pair.modelB.brand} · {pair.modelB.name}
                  {pair.modelB.year ? ` (${pair.modelB.year})` : ''}
                  {pair.modelB.color ? ` — ${pair.modelB.color}` : ''}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{pair.matchReasons.join(' · ')}</p>
              </div>
              <Link
                href={`/admin/catalog/duplicates/review?idA=${pair.modelA.id}&idB=${pair.modelB.id}`}
                className="shrink-0 text-sm font-medium text-blue-600 hover:underline"
              >
                Review →
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* Cursor pagination — only shown when not at 100-pair cap and more candidates exist */}
      {nextHref && filtered.length < 100 && (
        <div className="mt-4">
          <Link
            href={nextHref}
            className="text-sm text-blue-600 hover:underline"
          >
            Next 2,000 models →
          </Link>
          <p className="text-xs text-gray-400 mt-1">
            Pairs are found within each page of 2,000 catalog models (sorted alphabetically). Use brand/series filters to narrow scope.
          </p>
        </div>
      )}
    </>
  )
}
