import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import {
  getCatalogAttributionCoverage, getCatalogModelPerformancePage, getWantedWithNoSupply,
  type CatalogModelSortKey, type CatalogModelRow, type WantedNoSupplyRow,
} from '@/lib/catalogAnalyticsQuery'
import { fmtUsdDecimal, fmtInt, fmtPct, fmtDays, fmtDateTimeUtc } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Catalog Performance | Admin' }

const SORT_OPTIONS: Array<{ value: CatalogModelSortKey; label: string }> = [
  { value: 'unitsSold', label: 'Units sold' },
  { value: 'gmv', label: 'GMV' },
  { value: 'medianDaysToSell', label: 'Median days to sell' },
  { value: 'availableCopies', label: 'Available copies' },
  { value: 'wantedCount', label: 'Wanted' },
]
const SORT_KEYS = new Set(SORT_OPTIONS.map(o => o.value))

function modelLabel(m: { brand: string; name: string; year: number | null; series: string | null; scale: string | null }): { primary: string; secondary: string } {
  const secondaryParts = [m.year ? String(m.year) : null, m.series, m.scale].filter((p): p is string => !!p)
  return { primary: `${m.brand} ${m.name}`, secondary: secondaryParts.join(' · ') }
}

export default async function AdminCatalogAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string; sort?: string; cv?: string; cm?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const sp = await searchParams
  const ctx = buildAnalyticsContext(sp)
  const sort: CatalogModelSortKey = SORT_KEYS.has(sp.sort as CatalogModelSortKey) ? (sp.sort as CatalogModelSortKey) : 'unitsSold'
  const cursor = sp.cv && sp.cm ? { value: Number(sp.cv), catalogModelId: sp.cm } : null

  const [coverage, { items, nextCursor }, { items: noSupply, truncated: noSupplyTruncated }] = await Promise.all([
    getCatalogAttributionCoverage(ctx.range),
    getCatalogModelPerformancePage(ctx.range, sort, Number.isFinite(cursor?.value) ? cursor : null),
    getWantedWithNoSupply(),
  ])

  const baseQuery = new URLSearchParams(ctx.queryString)
  baseQuery.set('sort', sort)
  const nextHref = nextCursor
    ? `/admin/analytics/catalog?${baseQuery.toString()}&cv=${nextCursor.value}&cm=${encodeURIComponent(nextCursor.catalogModelId)}`
    : null

  const unitPct = coverage.periodUnits > 0 ? (coverage.attributedUnits / coverage.periodUnits) * 100 : null
  const gmvPct = coverage.periodGmv.isZero() ? null : coverage.attributedGmv.dividedBy(coverage.periodGmv).times(100).toNumber()
  // 17D final reconciliation (Part 3): ItemInstance.catalogId is required/non-nullable
  // and catalog merges reassign it before deleting a duplicate, so coverage is
  // structurally guaranteed 100% for all valid persisted data — a permanently-100%
  // card adds no information on a normal page load. The query stays fully defensive
  // (never assumes 100%); only the UI is conditional, so this section surfaces ONLY
  // if a real gap is ever observed — functioning as a silent data-integrity check
  // rather than a decorative always-the-same KPI.
  const hasCoverageGap = coverage.periodUnits > 0 && (
    coverage.attributedUnits < coverage.periodUnits || !coverage.attributedGmv.equals(coverage.periodGmv)
  )

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Catalog Performance</h1>
        <p className="text-xs text-gray-400 mt-1">Selected period: {ctx.range.label} · Snapshot as of {fmtDateTimeUtc(ctx.asOf)}</p>
      </div>

      <AnalyticsNav currentPath="/admin/analytics/catalog" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics/catalog" range={ctx.range} error={ctx.error} />

      {/* 17D: units sold / GMV / median days-to-sell below are SELECTED PERIOD —
          available copies / Wanted are CURRENT SNAPSHOT, unaffected by the date
          filter. Mirrors the 17C seller-table disclosure convention. */}
      <p className="text-xs text-gray-400">
        Units sold, GMV, and Median days to sell use the selected period above. Available copies and Wanted are a current snapshot.
      </p>

      {hasCoverageGap && (
        <section>
          <h2 className="text-sm font-semibold text-amber-700 mb-1">Catalog attribution coverage (selected period)</h2>
          <p className="text-xs text-gray-400 mb-3">
            A sale is catalog-attributed only if its physical item has a CatalogModel link. Unattributed sales still
            count in overall business totals elsewhere in Analytics — they are simply excluded from the model table
            below. Every completed sale is expected to be catalog-attributed; this section only appears when that
            is not the case, which may indicate a data-integrity issue worth investigating.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Metric
              label="Catalog-attributed units"
              value={`${fmtInt(coverage.attributedUnits)} of ${fmtInt(coverage.periodUnits)} · ${fmtPct(unitPct)}`}
            />
            <Metric
              label="Catalog-attributed GMV"
              value={`${fmtUsdDecimal(coverage.attributedGmv)} of ${fmtUsdDecimal(coverage.periodGmv)} · ${fmtPct(gmvPct)}`}
            />
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">Model performance (selected period)</h2>
          <div className="flex gap-2 text-xs">
            <span className="text-gray-400 self-center">Sort:</span>
            {SORT_OPTIONS.map(o => {
              const q = new URLSearchParams(ctx.queryString)
              q.set('sort', o.value)
              return (
                <Link
                  key={o.value}
                  href={`/admin/analytics/catalog?${q.toString()}`}
                  className={`rounded-full px-3 py-1 border ${sort === o.value ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-600 hover:border-gray-500'}`}
                >
                  {o.label}
                </Link>
              )
            })}
          </div>
        </div>

        <ModelTable items={items} />

        {nextHref && (
          <Link href={nextHref} className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2 mt-3 inline-block">
            Next 50 →
          </Link>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Wanted with no available copies (current)</h2>
        <p className="text-xs text-gray-400 mb-3">
          Models with existing Wanted interest and zero purchasable copies right now — not scoped to the selected period.
          {noSupplyTruncated
            ? ` Showing the top ${noSupply.length} by Wanted count — more models may qualify.`
            : ' This is the complete list.'}
        </p>
        <NoSupplyTable items={noSupply} />
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-600 mt-1.5">{label}</p>
    </div>
  )
}

function ModelTable({ items }: { items: CatalogModelRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr className="text-left text-gray-500">
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Units sold (period)</th>
            <th className="px-3 py-2 font-medium">GMV (period)</th>
            <th className="px-3 py-2 font-medium">Median days to sell (period)</th>
            <th className="px-3 py-2 font-medium">Available copies (current)</th>
            <th className="px-3 py-2 font-medium">Wanted (current)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map(r => {
            const { primary, secondary } = modelLabel(r)
            return (
              <tr key={r.catalogModelId} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <Link href={`/admin/catalog/${r.catalogModelId}/edit`} className="font-medium text-blue-600 hover:underline">{primary}</Link>
                  {secondary && <p className="text-xs text-gray-400">{secondary}</p>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.unitsSold)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtUsdDecimal(r.gmv)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtDays(r.medianDaysToSell)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.availableCopies)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.wantedCount)}</td>
              </tr>
            )
          })}
          {items.length === 0 && (
            <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No catalog-attributed sales in this period.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function NoSupplyTable({ items }: { items: WantedNoSupplyRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr className="text-left text-gray-500">
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Wanted (current)</th>
            <th className="px-3 py-2 font-medium">Available copies</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map(r => {
            const { primary, secondary } = modelLabel(r)
            return (
              <tr key={r.catalogModelId} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <Link href={`/admin/catalog/${r.catalogModelId}/edit`} className="font-medium text-blue-600 hover:underline">{primary}</Link>
                  {secondary && <p className="text-xs text-gray-400">{secondary}</p>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.wantedCount)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.availableCopies)}</td>
              </tr>
            )
          })}
          {items.length === 0 && (
            <tr><td colSpan={3} className="px-3 py-6 text-center text-gray-400">No Wanted models are currently out of stock.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
