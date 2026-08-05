import type { Metadata } from 'next'
import { ALGORITHM_VERSION } from '@/lib/catalogImageFingerprint'
import {
  getFingerprintCoverageStats,
  getExactDuplicateGroups,
  getNearDuplicatePairs,
  NEAR_DUP_MAX_DISTANCE,
} from '@/lib/catalogImageMatchingQuery'
import { CatalogImageBackfillPanel } from '@/components/admin/CatalogImageBackfillPanel'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Image Intelligence | Admin' }

export default async function CatalogImageIntelligencePage() {
  const [stats, exactDups, nearDups] = await Promise.all([
    getFingerprintCoverageStats(),
    getExactDuplicateGroups(),
    getNearDuplicatePairs(NEAR_DUP_MAX_DISTANCE),
  ])

  const pct = stats.totalPhotos > 0
    ? Math.round((stats.fingerprintedCount / stats.totalPhotos) * 100)
    : 100

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Catalog Image Intelligence</h1>
        <p className="text-sm text-gray-500 mt-1">
          Algorithm: <code className="font-mono">{ALGORITHM_VERSION}</code>
        </p>
      </div>

      {/* Coverage */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Coverage</h2>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Total photos',    value: stats.totalPhotos },
            { label: 'Fingerprinted',   value: stats.fingerprintedCount },
            { label: 'Missing',         value: stats.missingCount, warn: stats.missingCount > 0 },
          ].map(({ label, value, warn }) => (
            <div key={label} className="rounded-md border border-gray-200 bg-white p-4 text-center">
              <p className={`text-2xl font-bold ${warn ? 'text-yellow-700' : 'text-gray-900'}`}>
                {value}
              </p>
              <p className="text-xs text-gray-500 mt-1">{label}</p>
            </div>
          ))}
        </div>
        <div className="rounded-full bg-gray-100 h-2 overflow-hidden">
          <div
            className="h-2 bg-gray-900 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-gray-500">{pct}% fingerprinted</p>
      </section>

      {/* Backfill */}
      {stats.missingCount > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Backfill</h2>
          <CatalogImageBackfillPanel />
        </section>
      )}

      {/* Exact duplicates */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
          Exact duplicates{' '}
          <span className="text-gray-400 font-normal normal-case">
            (same photo on multiple catalog models)
          </span>
        </h2>
        {exactDups.length === 0 ? (
          <p className="text-sm text-gray-400">None found.</p>
        ) : (
          <div className="space-y-3">
            {exactDups.map(group => (
              <div
                key={group.contentSha256}
                className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2"
              >
                <p className="text-xs font-mono text-gray-500">{group.contentSha256.slice(0, 16)}…</p>
                <div className="flex flex-wrap gap-3">
                  {group.entries.map(e => (
                    <div key={e.catalogModelId} className="flex items-center gap-2">
                      {e.photoUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={e.photoUrl}
                          alt={e.catalogModelName}
                          className="w-10 h-10 rounded object-contain bg-white border border-gray-200"
                        />
                      )}
                      <span className="text-xs text-gray-700">{e.catalogModelName}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Near duplicates */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
          Near duplicates{' '}
          <span className="text-gray-400 font-normal normal-case">
            (Hamming ≤ 3, different models — informational only)
          </span>
        </h2>
        {nearDups.length === 0 ? (
          <p className="text-sm text-gray-400">None found.</p>
        ) : (
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white overflow-hidden">
            {nearDups.map((pair, i) => (
              <div key={i} className="flex items-center gap-4 p-3">
                <span className="text-xs font-mono text-gray-400 w-12 shrink-0 text-center">
                  d={pair.distance}
                </span>
                {[pair.modelA, pair.modelB].map((m, mi) => (
                  <div key={mi} className="flex items-center gap-2 flex-1 min-w-0">
                    {m.photoUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.photoUrl}
                        alt={m.name}
                        className="w-8 h-8 rounded object-contain bg-gray-50 border border-gray-200 shrink-0"
                      />
                    )}
                    <span className="text-xs text-gray-700 truncate">{m.name}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
