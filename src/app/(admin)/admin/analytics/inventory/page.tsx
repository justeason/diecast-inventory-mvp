import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { getInventorySnapshot, getInventoryAging, getDaysToSellDurations, getSellThroughCohort, getTimeSeries } from '@/lib/businessAnalyticsQuery'
import { computeDurationStats } from '@/lib/businessAnalyticsMath'
import { chooseBucketGranularity } from '@/lib/businessAnalyticsDates'
import { fmtInt, fmtPct, fmtDays, fmtDateTimeUtc, fmtBucketLabel } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'
import { SimpleBarChart } from '@/components/admin/analytics/SimpleBarChart'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Inventory Analytics | Admin' }

export default async function AdminInventoryAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const ctx = buildAnalyticsContext(await searchParams)
  const [snapshot, aging, daysToSell, sellThrough, series] = await Promise.all([
    getInventorySnapshot(ctx.range),
    getInventoryAging(ctx.asOf),
    getDaysToSellDurations(ctx.range),
    getSellThroughCohort(ctx.range),
    getTimeSeries(ctx.range),
  ])
  const stats = computeDurationStats(daysToSell.durations)
  const granularity = chooseBucketGranularity(ctx.range)
  const sellThroughPct = sellThrough.denominator > 0 ? (sellThrough.numerator / sellThrough.denominator) * 100 : null

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Operational Inventory Performance</h1>
        <p className="text-xs text-gray-400 mt-1">As of {fmtDateTimeUtc(ctx.asOf)} · {ctx.range.label}</p>
        <p className="text-xs text-amber-600 mt-1">
          Traditional inventory turnover (COGS ÷ average inventory value) is not shown — cost basis is
          unavailable for consignment items and inconsistently entered for company-owned items, so a
          fabricated ratio would be misleading. Sell-through, aging, and days-to-sell are used instead.
        </p>
      </div>

      <AnalyticsNav currentPath="/admin/analytics/inventory" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics/inventory" range={ctx.range} error={ctx.error} />

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Current inventory snapshot</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric label="Total physical inventory" value={fmtInt(snapshot.total)} />
          <Metric label="Available" value={fmtInt(snapshot.available)} />
          <Metric label="Reserved" value={fmtInt(snapshot.reserved)} />
          <Metric label="Sold (all time)" value={fmtInt(snapshot.sold)} />
          <Metric label="Draft / not for sale" value={fmtInt(snapshot.draft + snapshot.notForSale)} />
          <Metric label="Of which actively listed" value={fmtInt(snapshot.listedActive)} note="Subset of available/reserved — not additional to the total above" />
          <Metric label="Sold during period" value={fmtInt(snapshot.soldDuringPeriod)} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Inventory aging</h2>
        <p className="text-xs text-gray-400 mb-3">Current unsold inventory only, bucketed by ItemInstance.createdAt (intake timestamp) age as of now.</p>
        <SimpleBarChart bars={aging.map(b => ({ label: b.key, value: b.units }))} formatValue={v => fmtInt(v)} />
        <div className="grid grid-cols-5 gap-2 mt-3 text-center text-xs">
          {aging.map(b => (
            <div key={b.key} className="rounded-md border border-gray-200 py-2">
              <div className="font-medium text-gray-900">{fmtInt(b.units)}</div>
              <div className="text-gray-400">{fmtPct(b.pct)}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Days to sell</h2>
        <p className="text-xs text-gray-400 mb-3">Order.completedAt − ItemInstance.createdAt, sold units in the selected period only. Negative durations (data error) excluded.</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric label="Average" value={fmtDays(stats.average)} />
          <Metric label="Median" value={fmtDays(stats.median)} />
          <Metric label="P75" value={fmtDays(stats.p75)} />
          <Metric label="P90" value={fmtDays(stats.p90)} />
        </div>
        {stats.count === 0 && <p className="text-xs text-gray-400 mt-2">No sales in this period — N/A.</p>}
        {daysToSell.invalidCount > 0 && (
          <p className="text-xs text-amber-600 mt-2">{daysToSell.invalidCount} record(s) excluded as invalid data (negative or missing duration) — not silently included.</p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Sell-through (cohort)</h2>
        <p className="text-xs text-gray-400 mb-3">
          Units that entered sellable inventory (ItemInstance.createdAt) in the period and have since sold, ÷ cohort size.
          Sale window is truncated at asOf — some cohort units may still sell later.
        </p>
        <Metric label="Sell-through" value={fmtPct(sellThroughPct)} note={`${sellThrough.numerator} of ${sellThrough.denominator} intake cohort`} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Trends</h2>
        <p className="text-xs text-gray-400 mb-3">
          {granularity === 'day' ? 'Daily' : granularity === 'week' ? 'Weekly' : 'Monthly'} buckets, UTC, zero-filled.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <p className="text-xs text-gray-500 mb-1">Inventory intake</p>
            <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.inventoryIntake }))} formatValue={v => fmtInt(v)} />
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Inventory sold</p>
            <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.inventorySold }))} formatValue={v => fmtInt(v)} />
          </div>
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-600 mt-1.5">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
    </div>
  )
}
