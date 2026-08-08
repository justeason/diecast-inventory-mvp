import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { getRevenueBreakdown, getTimeSeries } from '@/lib/businessAnalyticsQuery'
import { chooseBucketGranularity } from '@/lib/businessAnalyticsDates'
import { fmtUsdDecimal, fmtInt, fmtDateTimeUtc, fmtBucketLabel } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'
import { SimpleBarChart } from '@/components/admin/analytics/SimpleBarChart'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Revenue | Admin' }

export default async function AdminRevenueAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const ctx = buildAnalyticsContext(await searchParams)
  const [rev, series] = await Promise.all([getRevenueBreakdown(ctx.range), getTimeSeries(ctx.range)])
  const granularity = chooseBucketGranularity(ctx.range)

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Revenue</h1>
        <p className="text-xs text-gray-400 mt-1">As of {fmtDateTimeUtc(ctx.asOf)} · {ctx.range.label}</p>
        <p className="text-xs text-amber-600 mt-1">
          Refunds/reversals are not tracked in this schema (no Refund model, no &quot;refunded&quot; order
          status) — all figures below are gross; there is no net alternative to show.
          &quot;Marketplace revenue&quot; is not shown — it would require tracking payment-processing fees
          and an explicit accounting policy, neither of which is persisted here. &quot;Gross spread&quot; and
          &quot;gross margin&quot; below are the closest defensible figures, clearly distinct from audited revenue.
        </p>
      </div>

      <AnalyticsNav currentPath="/admin/analytics/revenue" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics/revenue" range={ctx.range} error={ctx.error} />

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">GMV</h2>
        <p className="text-xs text-gray-400 mb-3">Buyer-facing sale price of all completed order items (gross — sum(OrderItem.price), Order.status = complete).</p>
        <Metric label="GMV" value={fmtUsdDecimal(rev.gmv)} emphasize />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Consignment sales (gross spread = commission + fee withheld)</h2>
        <p className="text-xs text-gray-400 mb-3">
          Seller proceeds = SellerPayoutLine.netAmount. Gross spread = grossSalePrice − netAmount — the
          amount withheld from the seller, NOT audited net revenue (payment-processing fees not deducted).
          These sum to consignment GMV exactly, by construction.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric label="Consignment GMV" value={fmtUsdDecimal(rev.consignment.gmv)} note={`${fmtInt(rev.consignment.items)} items`} />
          <Metric label="Seller proceeds" value={fmtUsdDecimal(rev.consignment.sellerProceeds)} />
          <Metric label="Gross spread" value={fmtUsdDecimal(rev.consignment.grossSpread)} />
          <Metric label="Reconciliation difference" value={fmtUsdDecimal(rev.reconciliationDifference)} note={rev.reconciliationDifference.isZero() ? 'Exact — GMV = proceeds + spread' : 'Non-zero indicates a data gap (see items above)'} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Buyout / company-owned sales (gross margin = sale price − cost)</h2>
        <p className="text-xs text-gray-400 mb-3">
          Gross margin = OrderItem.price − ItemInstance.purchasePrice — NOT audited net revenue (payment-
          processing fees not deducted). The seller (for buyout items) was already paid at intake, from a
          prior period — not from this period&apos;s sale — so no &quot;seller proceeds&quot; is attributed to
          these sales here; see Payouts for buyout obligations.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric label="GMV (cost basis known)" value={fmtUsdDecimal(rev.costBased.gmv.minus(rev.costBased.undeterminedGmv))} note={`${fmtInt(rev.costBased.items)} items`} />
          <Metric label="Gross margin" value={fmtUsdDecimal(rev.costBased.grossMargin)} />
          <Metric
            label="GMV with undetermined margin"
            value={fmtUsdDecimal(rev.costBased.undeterminedGmv)}
            note={rev.costBased.undeterminedItems > 0 ? `${fmtInt(rev.costBased.undeterminedItems)} items — no purchasePrice recorded` : 'None'}
          />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Marketplace revenue</h2>
        <Metric label="Marketplace revenue (net, audited)" value="Not available from current data model" note="Requires payment-processing fee tracking and an explicit revenue-recognition policy — neither exists in this schema." />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Seller proceeds — period flow</h2>
        <p className="text-xs text-gray-400 mb-3">
          sum(SellerPayoutLine.netAmount) by SellerPayoutLine.eligibleAt in period, excluding voided — both
          consignment and buyout lines. This is a DIFFERENT population than &quot;consignment seller
          proceeds&quot; above: buyout lines here are keyed to intake/agreement acceptance, not to any sale
          in this period.
        </p>
        <Metric label="Seller proceeds recorded this period" value={fmtUsdDecimal(rev.sellerProceedsFlow)} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Trends</h2>
        <p className="text-xs text-gray-400 mb-3">
          {granularity === 'day' ? 'Daily' : granularity === 'week' ? 'Weekly' : 'Monthly'} buckets, UTC,
          zero-filled, by Order.completedAt. Gross spread (consignment) and gross margin
          (buyout/company-owned) are separate series over disjoint items — never summed together.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <p className="text-xs text-gray-500 mb-1">GMV</p>
            <SimpleBarChart bars={series.map(b => ({ label: fmtBucketLabel(b.bucketStart, granularity), value: b.gmv.toNumber() }))} formatValue={v => `$${v.toFixed(0)}`} />
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

function Metric({ label, value, note, emphasize }: { label: string; value: string; note?: string; emphasize?: boolean }) {
  return (
    <div className={`rounded-md border p-4 ${emphasize ? 'border-gray-900 bg-gray-50' : 'border-gray-200 bg-white'}`}>
      <p className="text-xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-600 mt-1.5">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
    </div>
  )
}
