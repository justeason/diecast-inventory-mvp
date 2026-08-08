import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { getConversionFunnel } from '@/lib/businessAnalyticsQuery'
import { fmtInt, fmtPct, fmtDateTimeUtc } from '@/lib/businessAnalyticsFormat'
import { AnalyticsFilterBar } from '@/components/admin/analytics/AnalyticsFilterBar'
import { AnalyticsNav } from '@/components/admin/analytics/AnalyticsNav'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Conversion Analytics | Admin' }

export default async function AdminConversionAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>
}) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const ctx = buildAnalyticsContext(await searchParams)
  const funnel = await getConversionFunnel(ctx.range)

  const listingPct = funnel.listingToSale.denominator > 0 ? (funnel.listingToSale.numerator / funnel.listingToSale.denominator) * 100 : null
  const completionPct = funnel.orderCompletion.denominator > 0 ? (funnel.orderCompletion.numerator / funnel.orderCompletion.denominator) * 100 : null
  const cancellationPct = funnel.cancellationRate.denominator > 0 ? (funnel.cancellationRate.numerator / funnel.cancellationRate.denominator) * 100 : null

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Conversion</h1>
        <p className="text-xs text-gray-400 mt-1">As of {fmtDateTimeUtc(ctx.asOf)} · {ctx.range.label}</p>
        <p className="text-xs text-amber-600 mt-1">
          Only funnel stages backed by persistent records are shown. Page views, impressions, product-detail
          views, and add-to-cart events are not tracked in this schema and are not invented here.
        </p>
      </div>

      <AnalyticsNav currentPath="/admin/analytics/conversion" queryString={ctx.queryString} />
      <AnalyticsFilterBar path="/admin/analytics/conversion" range={ctx.range} error={ctx.error} />

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Funnel (period-created cohorts, by stage timestamp)</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <Metric label="Listings created" value={fmtInt(funnel.listingsCreated)} basis="Listing.createdAt" />
          <Metric label="Items entering reservation" value={fmtInt(funnel.itemsEnteringReservation)} basis="Order.createdAt (reservation is atomic with order creation)" />
          <Metric label="Orders created" value={fmtInt(funnel.ordersCreated)} basis="Order.createdAt" />
          <Metric label="Payments completed" value={fmtInt(funnel.paymentsCompleted)} basis="Order.paidAt" />
          <Metric label="Completed orders" value={fmtInt(funnel.completedOrders)} basis="Order.completedAt" />
          <Metric label="Units sold" value={fmtInt(funnel.unitsSold)} basis="Order.completedAt" />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Listing-to-sale conversion (cohort)</h2>
        <p className="text-xs text-gray-400 mb-3">
          Listings created in the period that eventually completed a sale ÷ listings created in the period.
          Sale window truncated at asOf — this is NOT (sales in period ÷ listings created in period), which
          would mix two different populations.
        </p>
        <Metric label="Listing-to-sale conversion" value={fmtPct(listingPct)} note={`${funnel.listingToSale.numerator} of ${funnel.listingToSale.denominator}`} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Order completion rate</h2>
        <p className="text-xs text-gray-400 mb-3">Completed orders ÷ orders created in the period (exact status classification, not inferred).</p>
        <div className="grid grid-cols-2 gap-4">
          <Metric label="Order completion rate" value={fmtPct(completionPct)} note={`${funnel.orderCompletion.numerator} of ${funnel.orderCompletion.denominator}`} />
          <Metric label="Cancellation rate" value={fmtPct(cancellationPct)} note={`${funnel.cancellationRate.numerator} of ${funnel.cancellationRate.denominator} — no distinct "failed" status exists`} />
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value, note, basis }: { label: string; value: string; note?: string; basis?: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-600 mt-1.5">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
      {basis && <p className="text-[11px] text-gray-300 mt-1">{basis}</p>}
    </div>
  )
}
