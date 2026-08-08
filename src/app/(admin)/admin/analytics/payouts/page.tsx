import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { getPayoutLiabilitySnapshot, getLiabilityAging, getPayoutFlow, getTimeSeries } from '@/lib/businessAnalyticsQuery'
import { chooseBucketGranularity } from '@/lib/businessAnalyticsDates'
import { fmtUsdDecimal, fmtInt, fmtDateTimeUtc, fmtBucketLabel } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'
import { SimpleBarChart } from '@/components/admin/analytics/SimpleBarChart'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Payout Liability | Admin' }

export default async function AdminPayoutAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const ctx = buildAnalyticsContext(await searchParams)
  const [snapshot, aging, flow, series] = await Promise.all([
    getPayoutLiabilitySnapshot(),
    getLiabilityAging(ctx.asOf),
    getPayoutFlow(ctx.range),
    getTimeSeries(ctx.range),
  ])
  const granularity = chooseBucketGranularity(ctx.range)

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Payout Liability</h1>
        <p className="text-xs text-gray-400 mt-1">As of {fmtDateTimeUtc(ctx.asOf)} · {ctx.range.label}</p>
        <p className="text-xs text-amber-600 mt-1">
          No historical liability snapshot table exists — this section shows the current snapshot plus
          period flow only. No historical liability trend is plotted (that would require fabricating
          past point-in-time balances from today&apos;s statuses).
        </p>
      </div>

      <AnalyticsNav currentPath="/admin/analytics/payouts" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics/payouts" range={ctx.range} error={ctx.error} />

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Current liability snapshot</h2>
        <p className="text-xs text-gray-400 mb-3">
          sum(SellerPayoutLine.netAmount) — voided lines excluded. &quot;Pending/processing/failed&quot; from
          a generic template do not map to real states here; only actual statuses are shown.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Metric label="Outstanding liability (total)" value={fmtUsdDecimal(snapshot.outstanding)} emphasize />
          <Metric label="Eligible, not yet batched" value={fmtUsdDecimal(snapshot.eligibleNoPayout)} />
          <Metric label="Held" value={fmtUsdDecimal(snapshot.held)} />
          <Metric label="In draft payout" value={fmtUsdDecimal(snapshot.inDraftPayout)} />
          <Metric label="In approved payout" value={fmtUsdDecimal(snapshot.inApprovedPayout)} />
          <Metric label="Sellers with outstanding liability" value={fmtInt(snapshot.sellersWithOutstanding)} />
          <Metric label="Paid (all time)" value={fmtUsdDecimal(snapshot.paidTotal)} />
          <Metric label="Voided / reversed (excluded above)" value={fmtUsdDecimal(snapshot.voidedTotal)} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Liability age</h2>
        <p className="text-xs text-gray-400 mb-3">
          No due-date field exists on SellerPayout/SellerPayoutLine — buckets are the age since
          SellerPayoutLine.eligibleAt, not &quot;overdue&quot; age. Outstanding liability only.
        </p>
        <SimpleBarChart bars={aging.map(b => ({ label: b.key, value: b.amount.toNumber() }))} formatValue={v => `$${v.toFixed(0)}`} />
        <div className="grid grid-cols-4 gap-2 mt-3 text-center text-xs">
          {aging.map(b => (
            <div key={b.key} className="rounded-md border border-gray-200 py-2">
              <div className="font-medium text-gray-900">{fmtUsdDecimal(b.amount)}</div>
              <div className="text-gray-400">{fmtInt(b.count)} lines</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Payout flow during period</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Metric label="Paid during period" value={fmtUsdDecimal(flow.paidDuringPeriod)} note={`${fmtInt(flow.paidCount)} lines`} />
          <Metric label="New liability recorded during period" value={fmtUsdDecimal(flow.newLiabilityDuringPeriod)} note="Not voided; by eligibleAt" />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Payouts paid — trend</h2>
        <p className="text-xs text-gray-400 mb-3">
          {granularity === 'day' ? 'Daily' : granularity === 'week' ? 'Weekly' : 'Monthly'} buckets by
          SellerPayout.paidAt, UTC, zero-filled. This is a FLOW series (money actually paid), not a
          liability-balance trend — no historical liability snapshots exist to plot that.
        </p>
        <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.payoutsPaid.toNumber() }))} formatValue={v => `$${v.toFixed(0)}`} />
      </section>
    </div>
  )
}

function Metric({ label, value, note, emphasize }: { label: string; value: string; note?: string; emphasize?: boolean }) {
  return (
    <div className={`rounded-md border p-4 ${emphasize ? 'border-gray-900 bg-gray-50' : 'border-gray-200 bg-white'}`}>
      <p className="text-xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-600 mt-1.5">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
    </div>
  )
}
