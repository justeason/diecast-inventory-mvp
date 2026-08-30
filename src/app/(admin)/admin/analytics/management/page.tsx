import type { Metadata } from 'next'
import type { Prisma } from '@prisma/client'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { getManagementSummary } from '@/lib/managementAnalyticsQuery'
import { fmtUsdDecimal, fmtInt, fmtDateTimeUtc } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Management Summary | Admin' }

// 17E: a composition layer only — every figure below is read from an existing
// authoritative helper (14B/17C business analytics, 15N financial position, 17D
// catalog analytics), never recomputed. This page owns no formulas; the linked
// detail pages remain the source of truth for their own numbers.

export default async function AdminManagementSummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const sp = await searchParams
  const ctx = buildAnalyticsContext(sp)
  const summary = await getManagementSummary(ctx.range)

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Management Summary</h1>
        <p className="text-xs text-gray-400 mt-1">A composed view of existing Analytics, Financial Position, and Catalog Analytics — not a new source of truth.</p>
      </div>

      <AnalyticsNav currentPath="/admin/analytics/management" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics/management" range={ctx.range} error={ctx.error} />

      <section>
        <div className="flex items-baseline gap-2 mb-1">
          <h2 className="text-lg font-semibold text-gray-900">Selected period</h2>
          <span className="text-xs text-gray-400">{ctx.range.label}</span>
        </div>
        <p className="text-xs text-gray-400 mb-3">Changing the date range above affects only this section.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Stat label="Completed orders" value={fmtInt(summary.commercial.completedOrders)} />
          <Stat label="Units sold" value={fmtInt(summary.commercial.unitsSold)} />
          <Stat label="GMV" value={fmtUsdDecimal(summary.commercial.gmv)} />
        </div>
        <Link href={`/admin/analytics?${ctx.queryString}`} className="text-sm text-blue-600 hover:underline mt-2 inline-block">
          View full Business Analytics →
        </Link>
      </section>

      <section>
        <div className="flex items-baseline gap-2 mb-1">
          <h2 className="text-lg font-semibold text-gray-900">Current financial position</h2>
          <span className="text-xs text-gray-400">as of {fmtDateTimeUtc(ctx.asOf)}</span>
        </div>
        <p className="text-xs text-gray-400 mb-3">A current snapshot — unaffected by the date range above.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <OwnedInventoryStat position={summary.financialPosition.ownedInventory} />
          <Stat
            label="Outstanding seller liability"
            value={fmtUsdDecimal(summary.financialPosition.outstandingSellerLiability)}
            href="/admin/analytics/payouts"
          />
          <Stat label="Liquidity" value="Unavailable" note="No bank/settlement balance is persisted in this system." href="/admin/finance/position" />
        </div>
        <Link href="/admin/finance/position" className="text-sm text-blue-600 hover:underline mt-2 inline-block">
          View full Financial Position &amp; Liquidity →
        </Link>
      </section>

      <section>
        <div className="flex items-baseline gap-2 mb-1">
          <h2 className="text-lg font-semibold text-gray-900">Current catalog signals</h2>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Models with existing Wanted interest and zero purchasable copies right now — a current snapshot, unaffected by the date range above.
        </p>
        <NoSupplyShortlist items={summary.catalogSignals.noSupply} truncated={summary.catalogSignals.noSupplyTruncated} />
        <Link href="/admin/analytics/catalog" className="text-sm text-blue-600 hover:underline mt-2 inline-block">
          View full Catalog Analytics →
        </Link>
      </section>
    </div>
  )
}

function Stat({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const body = (
    <>
      <p className="text-xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-600 mt-1.5">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
    </>
  )
  const cls = 'rounded-md border border-gray-200 bg-white p-4' + (href ? ' hover:bg-gray-50 transition-colors' : '')
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>
}

// Renders OwnedInventoryPosition.costCoverage (a FinancialMetric<Decimal>) using
// the same three-state discipline as the 15N Financial Position page — never a
// bare $0/N/A standing in for an unavailable or partial figure.
function OwnedInventoryStat({ position }: { position: { ownedUnits: number; costCoverage: { status: string; value?: Prisma.Decimal; coveragePct?: number; reason?: string } } }) {
  const { costCoverage } = position
  if (costCoverage.status === 'unavailable') {
    return <Stat label="Owned inventory cost" value="Unavailable" note={costCoverage.reason} href="/admin/finance/position" />
  }
  const note = costCoverage.status === 'partial' ? `${costCoverage.coveragePct}% of ${fmtInt(position.ownedUnits)} owned units` : `${fmtInt(position.ownedUnits)} owned units`
  return <Stat label="Owned inventory cost" value={fmtUsdDecimal(costCoverage.value!)} note={note} href="/admin/finance/position" />
}

function NoSupplyShortlist({ items, truncated }: { items: Array<{ catalogModelId: string; brand: string; name: string; wantedCount: number }>; truncated: boolean }) {
  if (items.length === 0) {
    return <p className="text-sm text-gray-400 rounded-md border border-gray-200 bg-white p-4">None currently.</p>
  }
  return (
    <div className="overflow-x-auto rounded-md border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr className="text-left text-gray-500">
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Wanted</th>
            <th className="px-3 py-2 font-medium">Available</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map(r => (
            <tr key={r.catalogModelId} className="hover:bg-gray-50">
              <td className="px-3 py-2 font-medium text-gray-900">{r.brand} {r.name}</td>
              <td className="px-3 py-2 font-mono text-xs">{fmtInt(r.wantedCount)}</td>
              <td className="px-3 py-2 font-mono text-xs">0</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="text-xs text-gray-400 px-1 py-2">Top {items.length} by Wanted count — more may qualify. See full Catalog Analytics for the complete list.</p>}
    </div>
  )
}
