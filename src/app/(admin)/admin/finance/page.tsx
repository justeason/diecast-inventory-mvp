import Link from 'next/link'
import { getOverviewMetrics, getOutstandingLiability, getPayoutFlow } from '@/lib/businessAnalyticsQuery'
import { parseDateRangeParams } from '@/lib/businessAnalyticsDates'
import { fmtUsdDecimal, fmtInt } from '@/lib/businessAnalyticsFormat'

export const dynamic = 'force-dynamic'

// 15H Part F section 21 — lightweight Finance domain hub. Reuses 14B metrics
// exactly as computed there (Part L section 37) — GMV, gross spread (consignment),
// and gross margin (buyout/company-owned) are shown as three DISTINCT figures, never
// summed into one "revenue" number, and no cash/asset/liquidity figure is fabricated.
// "Financial Position & Liquidity" (15N) has a clearly labeled, data-free placeholder.

export default async function FinanceHubPage() {
  const { range } = parseDateRangeParams({ period: '30d' })
  const [overview, outstandingLiability, payoutFlow] = await Promise.all([
    getOverviewMetrics(range),
    getOutstandingLiability(),
    getPayoutFlow(range),
  ])

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Finance</h1>
      <p className="text-sm text-gray-500 mb-6">{range.label}</p>

      <Section title="Sales">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="GMV" value={fmtUsdDecimal(overview.gmv)} />
          <StatCard label="Units sold" value={fmtInt(overview.unitsSold)} />
          <StatCard label="Completed orders" value={fmtInt(overview.completedOrders)} />
        </div>
      </Section>

      <Section title="Seller economics">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard
            label="Consignment gross spread"
            value={fmtUsdDecimal(overview.grossSpreadDetermined)}
            note={overview.grossSpreadUndeterminedItems > 0 ? `${overview.grossSpreadUndeterminedItems} item(s) undetermined` : undefined}
          />
          <StatCard
            label="Buyout gross margin"
            value={fmtUsdDecimal(overview.grossMarginDetermined)}
            note={overview.grossMarginUndeterminedItems > 0 ? `${overview.grossMarginUndeterminedItems} item(s) undetermined` : undefined}
          />
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Gross spread and gross margin are different measures over different item populations — never blended into one &quot;revenue&quot; figure.
        </p>
      </Section>

      <Section title="Seller payout liability">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Outstanding liability" value={fmtUsdDecimal(outstandingLiability)} href="/admin/seller-payouts" />
          <StatCard label={`Paid (${range.label})`} value={fmtUsdDecimal(payoutFlow.paidDuringPeriod)} note={`${payoutFlow.paidCount} payout(s)`} />
        </div>
      </Section>

      <Section title="Tools">
        <div className="flex flex-wrap gap-3">
          <ToolLink href="/admin/seller-payouts" label="Payouts" />
          <ToolLink href="/admin/reconciliation" label="Reconciliation" />
          <ToolLink href="/admin/analytics" label="Business Analytics (full trends & breakdowns)" />
        </div>
      </Section>

      <section className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-4">
        <h2 className="text-sm font-semibold text-gray-500">Financial Position &amp; Liquidity</h2>
        <p className="text-sm text-gray-400 mt-1">
          Reserved for a future milestone once authoritative settlement/accounting data exists. No cash, asset, or liquidity figures are shown here today.
        </p>
      </section>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  )
}

function StatCard({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const body = (
    <>
      <p className="text-xl font-bold text-gray-900 tabular-nums">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-0.5">{note}</p>}
    </>
  )
  const className = 'rounded-md border border-gray-200 bg-white p-4' + (href ? ' hover:bg-gray-50 transition-colors' : '')
  return href ? <Link href={href} className={className}>{body}</Link> : <div className={className}>{body}</div>
}

function ToolLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="rounded-md border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50 transition-colors">
      <p className="text-sm font-medium text-gray-900">{label}</p>
    </Link>
  )
}
