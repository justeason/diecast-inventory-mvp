import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { getSellerPerformancePage, type SellerSortKey } from '@/lib/businessAnalyticsQuery'
import { fmtUsdDecimal, fmtInt, fmtPct, fmtDays, fmtDateTimeUtc } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Seller Performance | Admin' }

const SORT_OPTIONS: Array<{ value: SellerSortKey; label: string }> = [
  { value: 'grossSales', label: 'Gross sales' },
  { value: 'unitsSold', label: 'Units sold' },
  { value: 'sellThrough', label: 'Sell-through' },
  { value: 'payoutOutstanding', label: 'Payout outstanding' },
  { value: 'medianDaysToSell', label: 'Median days to sell' },
]
const SORT_KEYS = new Set(SORT_OPTIONS.map(o => o.value))

export default async function AdminSellerAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string; sort?: string; cv?: string; cp?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const sp = await searchParams
  const ctx = buildAnalyticsContext(sp)
  const sort: SellerSortKey = SORT_KEYS.has(sp.sort as SellerSortKey) ? (sp.sort as SellerSortKey) : 'grossSales'
  const cursor = sp.cv && sp.cp ? { value: Number(sp.cv), profileId: sp.cp } : null

  const { items, nextCursor } = await getSellerPerformancePage(ctx.range, sort, Number.isFinite(cursor?.value) ? cursor : null)

  const baseQuery = new URLSearchParams(ctx.queryString)
  baseQuery.set('sort', sort)
  const nextHref = nextCursor
    ? `/admin/analytics/sellers?${baseQuery.toString()}&cv=${nextCursor.value}&cp=${encodeURIComponent(nextCursor.profileId)}`
    : null

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Seller Performance</h1>
        <p className="text-xs text-gray-400 mt-1">Selected period: {ctx.range.label} · Snapshot as of {fmtDateTimeUtc(ctx.asOf)}</p>
      </div>

      <AnalyticsNav currentPath="/admin/analytics/sellers" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics/sellers" range={ctx.range} error={ctx.error} />

      {/* 17C (P1-2): the table below mixes three time bases under one date filter —
          this line + the per-column "(lifetime)"/"(current)" header tags disclose
          that explicitly, so a selected period is never misread as scoping every
          column. Formulas/predicates are unchanged — see businessAnalyticsQuery.ts. */}
      <p className="text-xs text-gray-400">
        Gross sales and Proceeds use the selected period above. Outstanding is a current snapshot. All other columns are lifetime totals per seller.
      </p>

      <div className="flex items-center justify-between">
        <div className="flex gap-2 text-xs">
          <span className="text-gray-400 self-center">Sort:</span>
          {SORT_OPTIONS.map(o => {
            const q = new URLSearchParams(ctx.queryString)
            q.set('sort', o.value)
            return (
              <Link
                key={o.value}
                href={`/admin/analytics/sellers?${q.toString()}`}
                className={`rounded-full px-3 py-1 border ${sort === o.value ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-600 hover:border-gray-500'}`}
              >
                {o.label}
              </Link>
            )
          })}
        </div>
        <a
          href={`/admin/analytics/sellers/export?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(ctx.queryString)), sort }).toString()}`}
          className="text-xs text-gray-500 hover:text-gray-900 underline underline-offset-2"
        >
          Export CSV
        </a>
      </div>

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-gray-500">
              <th className="px-3 py-2 font-medium">Seller</th>
              <th className="px-3 py-2 font-medium">Submissions (lifetime)</th>
              <th className="px-3 py-2 font-medium">Received (lifetime)</th>
              <th className="px-3 py-2 font-medium">Listed (lifetime)</th>
              <th className="px-3 py-2 font-medium">Sold (lifetime)</th>
              <th className="px-3 py-2 font-medium">Sell-through (lifetime)</th>
              <th className="px-3 py-2 font-medium">Gross sales</th>
              <th className="px-3 py-2 font-medium">Proceeds</th>
              <th className="px-3 py-2 font-medium">Paid (lifetime)</th>
              <th className="px-3 py-2 font-medium">Outstanding (current)</th>
              <th className="px-3 py-2 font-medium">Med. intake→list (lifetime)</th>
              <th className="px-3 py-2 font-medium">Med. list→sale (lifetime)</th>
              <th className="px-3 py-2 font-medium">Rejection rate (lifetime)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map(r => (
              <tr key={r.profileId} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-medium text-gray-900">{r.displayName}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.submissions)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.unitsReceived)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.unitsListed)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.unitsSold)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtPct(r.sellThrough)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtUsdDecimal(r.grossSales)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtUsdDecimal(r.sellerProceeds)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtUsdDecimal(r.payoutPaid)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtUsdDecimal(r.payoutOutstanding)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtDays(r.medianIntakeToListingDays)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtDays(r.medianListingToSaleDays)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtPct(r.rejectionRate)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={13} className="px-3 py-6 text-center text-gray-400">No sellers found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {nextHref && (
        <Link href={nextHref} className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2">
          Next 50 →
        </Link>
      )}

      <p className="text-xs text-gray-400">
        Identifiers shown: a public seller handle (only if the seller made their community profile
        public) or a truncated internal ID. Never an admin-entered display name, which may contain
        a real name.
        No email, phone, address, or payment account is shown.
      </p>
    </div>
  )
}
