import type { Metadata } from 'next'
import Link from 'next/link'
import {
  getQualitySummary, scanIssues, getRecentRepairs,
  scanDuplicateIssues, scanReferenceIntegrityIssues,
  type IssueRow, type ScanIssuesResult,
} from '@/lib/catalogDataQualityQuery'
import type { IssueCategory, IssueSeverity, IssueType } from '@/lib/catalogDataQuality'
import { CatalogBulkRepairPanel } from '@/components/admin/CatalogBulkRepairPanel'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Catalog Quality | Admin' }

const SEVERITY_COLORS: Record<IssueSeverity, string> = {
  error:   'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info:    'bg-gray-100 text-gray-600',
}

const CATEGORY_LABELS: Record<IssueCategory, string> = {
  completeness:        'Completeness',
  formatting:          'Formatting',
  duplicate_risk:      'Duplicate Risk',
  reference_integrity: 'Reference Integrity',
}

export default async function CatalogQualityPage({
  searchParams,
}: {
  searchParams: Promise<{
    category?:    string
    severity?:    string
    repairable?:  string
    brand?:       string
    year?:        string
    modelId?:     string
    issueType?:   string
    cursor?:      string
  }>
}) {
  const params = await searchParams
  const {
    category, severity, repairable, brand, year, modelId, issueType, cursor,
  } = params

  const isDupRisk      = category === 'duplicate_risk'
  const isRefIntegrity = category === 'reference_integrity'

  const emptyDup: { issues: IssueRow[]; hasMore: boolean; nextCursor?: string }  = { issues: [], hasMore: false }
  const emptyRef: { issues: IssueRow[]; hasMore: boolean; nextCursor?: string }  = { issues: [], hasMore: false }
  const emptySngl: ScanIssuesResult                                              = { issues: [], nextCursor: null, hasMore: false }

  const [summary, singleResult, dupResult, refResult, recentRepairs] = await Promise.all([
    getQualitySummary(),
    !isDupRisk && !isRefIntegrity
      ? scanIssues(
          {
            category:       category as IssueCategory | undefined,
            severity:       severity as IssueSeverity | undefined,
            repairableOnly: repairable === '1',
            brand:          brand || undefined,
            year:           year ? parseInt(year, 10) : undefined,
            catalogModelId: modelId || undefined,
            issueType:      issueType as IssueType | undefined,
          },
          cursor || undefined,
          50,
        )
      : Promise.resolve(emptySngl),
    isDupRisk    ? scanDuplicateIssues(50, cursor || undefined)          : Promise.resolve(emptyDup),
    isRefIntegrity ? scanReferenceIntegrityIssues(50, cursor || undefined) : Promise.resolve(emptyRef),
    getRecentRepairs(5),
  ])

  const activeIssues     = isDupRisk ? dupResult.issues : isRefIntegrity ? refResult.issues : singleResult.issues
  const activeHasMore    = isDupRisk ? dupResult.hasMore : isRefIntegrity ? refResult.hasMore : singleResult.hasMore
  const activeNextCursor = isDupRisk ? dupResult.nextCursor : isRefIntegrity ? refResult.nextCursor : singleResult.nextCursor

  const buildFilter = (overrides: Record<string, string | undefined>) => {
    const base = { category, severity, repairable, brand, year, modelId, issueType }
    const merged = { ...base, ...overrides }
    const qs = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join('&')
    return `/admin/catalog-quality${qs ? '?' + qs : ''}`
  }

  const CATEGORIES: IssueCategory[] = [
    'completeness', 'formatting', 'duplicate_risk', 'reference_integrity',
  ]
  const SEVERITIES: IssueSeverity[] = ['error', 'warning', 'info']

  return (
    <div className="max-w-5xl space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Catalog Quality</h1>
          <p className="text-sm text-gray-500 mt-1">
            Detect and repair data quality issues in the catalog.
            Merges are handled by the{' '}
            <Link href="/admin/catalog/duplicates" className="text-blue-600 hover:underline">
              Duplicate Review
            </Link>{' '}
            workflow.
          </p>
        </div>
        <Link
          href="/admin/catalog"
          className="text-sm text-gray-500 hover:text-gray-900 mt-1"
        >
          ← Catalog
        </Link>
      </div>

      {/* Summary Cards */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          {
            label: 'Completeness',
            value: `${summary.completenessPercent}%`,
            sub:   `${summary.totalModels} models`,
            warn:  summary.completenessPercent < 80,
          },
          {
            label: 'Photo Coverage',
            value: `${summary.modelsWithPhoto} / ${summary.totalModels}`,
            sub:   `${summary.modelsWithoutPhoto} missing`,
            warn:  summary.modelsWithoutPhoto > 0,
          },
          {
            label: 'Fingerprint Coverage',
            value: `${summary.photoFingerprintPercent}%`,
            sub:   `${summary.photosMissingFingerprint} photos missing`,
            warn:  summary.photosMissingFingerprint > 0,
          },
          {
            label: 'Repairs (30 days)',
            value: String(summary.recentAuditCount),
            sub:   'audited actions',
            warn:  false,
          },
        ].map(({ label, value, sub, warn }) => (
          <div key={label} className="rounded-md border border-gray-200 bg-white p-4 text-center">
            <p className={`text-2xl font-bold ${warn ? 'text-amber-700' : 'text-gray-900'}`}>
              {value}
            </p>
            <p className="text-xs font-medium text-gray-700 mt-1">{label}</p>
            <p className="text-xs text-gray-400">{sub}</p>
          </div>
        ))}
      </section>

      {/* Filters */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Filters</h2>

        {/* Category */}
        <div className="flex flex-wrap gap-2">
          <Link
            href={buildFilter({ category: undefined, cursor: undefined })}
            className={`px-3 py-1 rounded-full text-xs border ${
              !category ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            All categories
          </Link>
          {CATEGORIES.map(c => (
            <Link
              key={c}
              href={buildFilter({ category: c, cursor: undefined })}
              className={`px-3 py-1 rounded-full text-xs border ${
                category === c ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}
            >
              {CATEGORY_LABELS[c]}
            </Link>
          ))}
        </div>

        {/* Severity */}
        <div className="flex flex-wrap gap-2">
          <Link
            href={buildFilter({ severity: undefined, cursor: undefined })}
            className={`px-3 py-1 rounded-full text-xs border ${
              !severity ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            All severities
          </Link>
          {SEVERITIES.map(s => (
            <Link
              key={s}
              href={buildFilter({ severity: s, cursor: undefined })}
              className={`px-3 py-1 rounded-full text-xs border ${
                severity === s ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Link>
          ))}
          <Link
            href={buildFilter({ repairable: repairable === '1' ? undefined : '1', cursor: undefined })}
            className={`px-3 py-1 rounded-full text-xs border ${
              repairable === '1' ? 'bg-blue-700 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            Repairable only
          </Link>
        </div>

        {/* Search inputs */}
        <form method="GET" action="/admin/catalog-quality" className="flex flex-wrap gap-2">
          {category    && <input type="hidden" name="category"   value={category} />}
          {severity    && <input type="hidden" name="severity"   value={severity} />}
          {repairable  && <input type="hidden" name="repairable" value={repairable} />}
          <input
            type="text" name="brand" defaultValue={brand ?? ''}
            placeholder="Brand contains…"
            className="rounded-md border border-gray-200 px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="number" name="year" defaultValue={year ?? ''}
            placeholder="Year"
            className="rounded-md border border-gray-200 px-3 py-1.5 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="text" name="modelId" defaultValue={modelId ?? ''}
            placeholder="Model ID"
            className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="px-3 py-1.5 rounded-md bg-gray-800 text-white text-xs hover:bg-gray-900"
          >
            Search
          </button>
          {(brand || year || modelId) && (
            <Link
              href={buildFilter({ brand: undefined, year: undefined, modelId: undefined, cursor: undefined })}
              className="px-3 py-1.5 rounded-md border border-gray-200 text-xs text-gray-600 hover:bg-gray-50"
            >
              Clear
            </Link>
          )}
        </form>
      </section>

      {/* Issue list */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Issues
            {cursor && <span className="ml-2 font-normal normal-case text-gray-400">(paginated)</span>}
          </h2>
          <Link
            href="/admin/catalog-image-intelligence"
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            Image Intelligence →
          </Link>
        </div>

        {isDupRisk && (
          <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800 space-y-1">
            <p className="font-medium">Search-quality coverage</p>
            <p className="text-xs"><strong>Applicable:</strong> normalized_key_collision — two models with identical normalized brand+name compete for the same search slot.</p>
            <p className="text-xs"><strong>Not applicable:</strong> persisted normalized field, tsvector, alias collision (not in this schema).</p>
          </div>
        )}

        {activeIssues.length === 0 ? (
          <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
            No issues found{isDupRisk || isRefIntegrity ? ' in this category' : ' with current filters'}.
          </div>
        ) : (
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {activeIssues.map(issue => (
              <div key={issue.issueKey} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={`shrink-0 mt-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_COLORS[issue.severity]}`}
                >
                  {issue.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-400 font-mono">{issue.issueType}</p>
                  <p className="text-sm font-medium text-gray-900">
                    {issue.catalogModel.brand} · {issue.catalogModel.name}
                    {issue.catalogModel.year ? ` (${issue.catalogModel.year})` : ''}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{issue.detail}</p>
                  {issue.repairPreview && (
                    <p className="text-xs text-blue-600 mt-0.5 font-mono">{issue.repairPreview}</p>
                  )}
                </div>
                <div className="shrink-0 flex gap-2 items-center mt-0.5">
                  {issue.relatedCatalogModelId ? (
                    <Link
                      href={`/admin/catalog/duplicates/review?idA=${issue.catalogModelId}&idB=${issue.relatedCatalogModelId}`}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      Review →
                    </Link>
                  ) : issue.repairAction ? (
                    <Link
                      href={`/admin/catalog-quality/models/${issue.catalogModelId}`}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      Repair →
                    </Link>
                  ) : null}
                  {!issue.relatedCatalogModelId && (
                    <Link
                      href={`/admin/catalog-quality/models/${issue.catalogModelId}`}
                      className="text-xs text-gray-400 hover:text-gray-700"
                    >
                      Detail
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {activeHasMore && activeNextCursor && (
          <div className="flex items-center gap-4">
            <Link
              href={buildFilter({ cursor: activeNextCursor })}
              className="text-sm text-blue-600 hover:underline"
            >
              Next 50 issues →
            </Link>
            {cursor && (
              <Link
                href={buildFilter({ cursor: undefined })}
                className="text-sm text-gray-400 hover:text-gray-700"
              >
                ← First page
              </Link>
            )}
          </div>
        )}
        {!activeHasMore && activeIssues.length > 0 && (
          <p className="text-xs text-gray-400">All issues shown.</p>
        )}

        {/* Bulk repair panel — trim_whitespace issues from the current single-model scan */}
        {!isDupRisk && !isRefIntegrity && (
          <CatalogBulkRepairPanel
            issues={singleResult.issues.filter(i => i.repairAction === 'trim_whitespace')}
          />
        )}
      </section>

      {/* Recent repairs */}
      {recentRepairs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Recent Repairs
          </h2>
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {recentRepairs.map(r => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-xs font-mono text-gray-400 shrink-0">{r.action}</span>
                <span className="text-xs text-gray-600 flex-1 min-w-0 truncate">{r.issueKey}</span>
                <Link
                  href={`/admin/catalog-quality/models/${r.catalogModelId}`}
                  className="text-xs text-gray-400 hover:text-gray-700 shrink-0"
                >
                  {r.catalogModelId.slice(0, 8)}…
                </Link>
                <span className="text-xs text-gray-400 shrink-0">
                  {r.createdAt.toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Links to existing tools */}
      <section className="rounded-md border border-gray-100 bg-gray-50 p-4 space-y-2">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Related Tools</h2>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/admin/catalog/duplicates"         className="text-blue-600 hover:underline">Duplicate Review (merge workflow)</Link>
          <Link href="/admin/catalog-image-intelligence" className="text-blue-600 hover:underline">Image Intelligence (fingerprint backfill)</Link>
          <Link href="/admin/catalog"                    className="text-blue-600 hover:underline">Catalog Editor</Link>
        </div>
      </section>
    </div>
  )
}
