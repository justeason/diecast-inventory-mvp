import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { getOverviewMetrics, getTimeSeries } from '@/lib/businessAnalyticsQuery'
import { getMetricDefinition } from '@/lib/businessAnalyticsRegistry'
import { periodChange } from '@/lib/businessAnalyticsMath'
import { chooseBucketGranularity } from '@/lib/businessAnalyticsDates'
import { fmtUsdDecimal, fmtInt, fmtPct, fmtDays, fmtPeriodChange, fmtDateTimeUtc, fmtBucketLabel } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'
import { KpiCard } from '@/components/admin/analytics/KpiCard'
import { SimpleBarChart } from '@/components/admin/analytics/SimpleBarChart'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Business Analytics | Admin' }

export default async function AdminAnalyticsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const ctx = buildAnalyticsContext(await searchParams)
  const [metrics, series] = await Promise.all([getOverviewMetrics(ctx.range), getTimeSeries(ctx.range)])
  const granularity = chooseBucketGranularity(ctx.range)

  // Flow metrics get a period-over-period comparison when a predecessor period exists
  // (never for 'all time' — previousPeriod() returns null there). Snapshot metrics
  // (active inventory, unpaid liability) and cohort ratios (sell-through, listing-to-
  // sale) never get a trend — see businessAnalyticsMath.test for the omission rule.
  let prevUnitsSold: number | null = null
  let prevCompletedOrders: number | null = null
  let prevGmvCents: number | null = null
  let prevSpreadCents: number | null = null
  let prevMarginCents: number | null = null
  if (ctx.previous) {
    const prevRange = { ...ctx.range, start: ctx.previous.start, end: ctx.previous.end }
    const prev = await getOverviewMetrics(prevRange)
    prevUnitsSold = prev.unitsSold
    prevCompletedOrders = prev.completedOrders
    prevGmvCents = prev.gmv.times(100).toNumber()
    prevSpreadCents = prev.grossSpreadDetermined.times(100).toNumber()
    prevMarginCents = prev.grossMarginDetermined.times(100).toNumber()
  }

  const def = getMetricDefinition

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Business Analytics</h1>
          <p className="text-xs text-gray-400 mt-1">As of {fmtDateTimeUtc(ctx.asOf)} · {ctx.range.label}</p>
        </div>
      </div>

      <AnalyticsNav currentPath="/admin/analytics" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics" range={ctx.range} error={ctx.error} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <KpiCard value={fmtInt(metrics.unitsSold)} definition={def('units_sold')!} change={prevUnitsSold !== null ? fmtPeriodChange(periodChange(metrics.unitsSold, prevUnitsSold)) : undefined} />
        <KpiCard value={fmtInt(metrics.completedOrders)} definition={def('completed_orders')!} change={prevCompletedOrders !== null ? fmtPeriodChange(periodChange(metrics.completedOrders, prevCompletedOrders)) : undefined} />
        <KpiCard
          value={fmtUsdDecimal(metrics.gmv)}
          definition={def('gmv')!}
          change={prevGmvCents !== null ? fmtPeriodChange(periodChange(metrics.gmv.times(100).toNumber(), prevGmvCents)) : undefined}
        />
        <KpiCard
          value={fmtUsdDecimal(metrics.grossSpreadDetermined)}
          definition={def('gross_spread')!}
          change={prevSpreadCents !== null ? fmtPeriodChange(periodChange(metrics.grossSpreadDetermined.times(100).toNumber(), prevSpreadCents)) : undefined}
          note={metrics.grossSpreadUndeterminedItems > 0 ? `${metrics.grossSpreadUndeterminedItems} consignment item(s) excluded — no payout line yet` : undefined}
        />
        <KpiCard
          value={fmtUsdDecimal(metrics.grossMarginDetermined)}
          definition={def('gross_margin')!}
          change={prevMarginCents !== null ? fmtPeriodChange(periodChange(metrics.grossMarginDetermined.times(100).toNumber(), prevMarginCents)) : undefined}
          note={metrics.grossMarginUndeterminedItems > 0 ? `${metrics.grossMarginUndeterminedItems} buyout/company-owned item(s) excluded — no purchasePrice recorded` : undefined}
        />
        <KpiCard value="Not available" definition={def('marketplace_revenue')!} note="See Gross spread / Gross margin instead — never summed together" />
        <KpiCard value={fmtInt(metrics.activeInventory)} definition={def('active_inventory')!} />
        <KpiCard
          value={fmtPct(metrics.sellThrough.denominator > 0 ? (metrics.sellThrough.numerator / metrics.sellThrough.denominator) * 100 : null)}
          definition={def('sell_through')!}
          note={`${metrics.sellThrough.numerator} of ${metrics.sellThrough.denominator} intake cohort`}
        />
        <KpiCard
          value={fmtDays(metrics.medianDaysToSell)}
          definition={def('median_days_to_sell')!}
          note={metrics.daysToSellInvalidCount > 0 ? `${metrics.daysToSellInvalidCount} record(s) excluded as invalid (negative/missing duration)` : undefined}
        />
        <KpiCard
          value={fmtPct(metrics.listingToSale.denominator > 0 ? (metrics.listingToSale.numerator / metrics.listingToSale.denominator) * 100 : null)}
          definition={def('listing_to_sale_conversion')!}
          note={`${metrics.listingToSale.numerator} of ${metrics.listingToSale.denominator} listing cohort`}
        />
        <KpiCard value={fmtUsdDecimal(metrics.unpaidSellerLiability)} definition={def('payout_liability')!} />
        <KpiCard value={fmtInt(metrics.sellersWithCompletedSales)} definition={{ key: 'sellers_with_sales', name: 'Sellers with completed sales', description: 'Distinct sellers with at least one unit sold in the selected period.', metricType: 'flow', timestampBasis: 'Order.completedAt' }} />
      </div>

      <p className="text-xs text-gray-400">
        Snapshot metrics (active inventory, unpaid liability) reflect current state, not a historical point-in-time — no snapshot history is stored.
        Refunds/reversals are not tracked in this schema; all monetary figures above are gross totals of completed-order records.
      </p>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Trends</h2>
        <p className="text-xs text-gray-400 mb-3">
          {granularity === 'day' ? 'Daily' : granularity === 'week' ? 'Weekly' : 'Monthly'} buckets, UTC. Missing
          buckets are zero-filled, not omitted.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <p className="text-xs text-gray-500 mb-1">GMV</p>
            <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.gmv.toNumber() }))} formatValue={v => `$${v.toFixed(0)}`} />
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Units sold</p>
            <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.unitsSold }))} formatValue={v => fmtInt(v)} />
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Gross spread (consignment)</p>
            <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.consignmentGrossSpread.toNumber() }))} formatValue={v => `$${v.toFixed(0)}`} />
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Gross margin (buyout/company-owned)</p>
            <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.buyoutGrossMargin.toNumber() }))} formatValue={v => `$${v.toFixed(0)}`} />
          </div>
        </div>
      </section>
    </div>
  )
}
