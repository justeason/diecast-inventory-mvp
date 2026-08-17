import type { Metadata } from 'next'
import Link from 'next/link'
import {
  getOwnedInventoryPosition, getOwnedInventoryAging,
  getConsignedInventoryHeld, getPayoutLiabilitySnapshot, getPayoutApprovalAttention,
  getLiabilityAging, getOverviewMetrics, getPayoutFlow, getBuyerPaymentsCaptured,
} from '@/lib/financialPositionQuery'
import type { FinancialMetric } from '@/lib/financialPosition'
import { parseDateRangeParams } from '@/lib/businessAnalyticsDates'
import { fmtUsdDecimal, fmtInt, fmtPct } from '@/lib/businessAnalyticsFormat'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Financial Position | Admin' }

// 15N: read-only financial position & liquidity dashboard. "Financial Position" is
// point-in-time (as of now, Part B/3, Part R/44 — no fabricated historical
// balance-sheet dates); "Activity" below is flow over the selected period. Neither
// section is a GAAP statement — see PART Y label discipline in the milestone spec.

export default async function FinancialPositionPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>
}) {
  const params = await searchParams
  const { range, error } = parseDateRangeParams(params)
  const asOf = new Date()

  const [
    owned, ownedAging, consigned, liabilitySnapshot, approvalAttention,
    liabilityAging, overview, payoutFlow, buyerPayments,
  ] = await Promise.all([
    getOwnedInventoryPosition(),
    getOwnedInventoryAging(asOf),
    getConsignedInventoryHeld(),
    getPayoutLiabilitySnapshot(),
    getPayoutApprovalAttention(),
    getLiabilityAging(asOf),
    getOverviewMetrics(range),
    getPayoutFlow(range),
    getBuyerPaymentsCaptured(range),
  ])

  return (
    <div className="max-w-5xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Financial Position &amp; Liquidity</h1>
        <p className="text-sm text-gray-500 mt-1">
          Not a balance sheet, income statement, or statement of cash flows — an operational read of what we hold,
          owe, and collected, built strictly from data this system actually persists.
        </p>
      </div>

      {/* ── POSITION — as of now ────────────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline gap-2 mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Financial Position</h2>
          <span className="text-xs text-gray-400">as of {asOf.toLocaleString()}</span>
        </div>

        <SubSection title="Owned Inventory">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <Stat label="Owned inventory units" value={fmtInt(owned.ownedUnits)} />
            <Stat label="With exact item-level cost" value={fmtInt(owned.unitsWithCost)} />
            <Stat label="Without item-level cost allocation" value={fmtInt(owned.unitsWithoutCost)} />
            <MetricStat label="Cost coverage" metric={owned.costCoverage} kind="pct" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MetricStat label="Recorded allocated cost" metric={owned.costCoverage} kind="usd" />
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Recorded cost is exact ItemInstance-level purchase cost only. For a multi-item buyout batch, the agreement
            total is never attributed to remaining held units — once any unit from a batch has sold, no valid way
            exists to divide the total among the units that remain, so those units stay uncovered and are disclosed
            only through the coverage percentage above.
          </p>
        </SubSection>

        <SubSection title="Owned Inventory Aging">
          <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr><th className="text-left px-3 py-2">Age (days)</th><th className="text-left px-3 py-2">Units</th><th className="text-left px-3 py-2">Units w/ cost</th><th className="text-left px-3 py-2">Known cost tied up</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ownedAging.map((b) => (
                <tr key={b.key}>
                  <td className="px-3 py-2 text-gray-900">{b.key}</td>
                  <td className="px-3 py-2 text-gray-600">{fmtInt(b.units)}</td>
                  <td className="px-3 py-2 text-gray-600">{fmtInt(b.unitsWithCost)}</td>
                  <td className="px-3 py-2 text-gray-600">{b.unitsWithCost > 0 ? fmtUsdDecimal(b.knownCost) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-2">
            Acquisition-date proxy = item creation date (only meaningful for buyout/company-owned items — the moment they entered inventory).
          </p>
        </SubSection>

        <SubSection title="Consigned Inventory Held">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Physical units held" value={fmtInt(consigned.unitsHeld)} />
            <Stat label="Listed" value={fmtInt(consigned.listedUnits)} />
            <Stat label="Reserved" value={fmtInt(consigned.reservedUnits)} />
            <Stat label="Sold, awaiting payout" value={fmtInt(consigned.soldAwaitingPayout)} />
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Consigned inventory is never company-owned — excluded from Owned Inventory above.
          </p>
        </SubSection>

        <SubSection title="Seller Obligations">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
            <Stat label="Outstanding Seller Payout Liability" value={fmtUsdDecimal(liabilitySnapshot.outstanding)} href="/admin/seller-payouts" emphasize />
            <Stat label="Ready to pay" value={`${fmtUsdDecimal(approvalAttention.readyToPay)} (${fmtInt(approvalAttention.readyToPayCount)})`} />
            <Stat label="Pending 15F approval" value={`${fmtUsdDecimal(approvalAttention.pendingApproval)} (${fmtInt(approvalAttention.pendingApprovalCount)})`} href="/admin/approvals" />
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Amounts pending approval remain part of the outstanding liability — 15F approval status is workflow state, not a different economic obligation.
          </p>
          <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr><th className="text-left px-3 py-2">Liability age</th><th className="text-left px-3 py-2">Amount</th><th className="text-left px-3 py-2">Lines</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {liabilityAging.map((b) => (
                <tr key={b.key}><td className="px-3 py-2 text-gray-900">{b.key} days</td><td className="px-3 py-2 text-gray-600">{fmtUsdDecimal(b.amount)}</td><td className="px-3 py-2 text-gray-600">{fmtInt(b.count)}</td></tr>
              ))}
            </tbody>
          </table>
        </SubSection>

        <SubSection title="Liquidity Coverage">
          <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
            <tbody className="divide-y divide-gray-100">
              <tr><td className="px-3 py-2 text-gray-600 w-1/2">Cash / settlement balance</td><td className="px-3 py-2 text-amber-700 font-medium">Not available</td></tr>
              <tr><td className="px-3 py-2 text-gray-600">Seller payout liability</td><td className="px-3 py-2 text-green-700 font-medium">Available (above)</td></tr>
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-2">
            No bank/Stripe settlement balance is persisted in this system. Connect authoritative settlement/bank balance
            data to calculate available liquidity — GMV and completed orders are never substituted for cash.
          </p>
        </SubSection>
      </section>

      {/* ── ACTIVITY — selected period ──────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline gap-2 mb-1">
          <h2 className="text-lg font-semibold text-gray-900">Activity</h2>
          <span className="text-xs text-gray-400">{range.label}</span>
        </div>
        <p className="text-xs text-gray-400 mb-4">Changing this period does not change the current position above.</p>
        {error && <p className="text-xs text-amber-700 mb-3">{error}</p>}

        <PeriodFilter range={range} />

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4 mb-3">
          <Stat label="GMV" value={fmtUsdDecimal(overview.gmv)} />
          <Stat label="Units sold" value={fmtInt(overview.unitsSold)} />
          <Stat label="Buyer payments captured" value={`${fmtUsdDecimal(buyerPayments.amount)} (${fmtInt(buyerPayments.count)})`} />
          <Stat label="Seller payouts recorded paid" value={`${fmtUsdDecimal(payoutFlow.paidDuringPeriod)} (${fmtInt(payoutFlow.paidCount)})`} />
          <Stat
            label="Consignment commission"
            value={fmtUsdDecimal(overview.grossSpreadDetermined)}
            note={overview.grossSpreadUndeterminedItems > 0 ? `${overview.grossSpreadUndeterminedItems} item(s) undetermined` : undefined}
          />
          <Stat
            label="Known-cost buyout gross margin"
            value={fmtUsdDecimal(overview.grossMarginDetermined)}
            note={overview.grossMarginUndeterminedItems > 0 ? `${overview.grossMarginUndeterminedItems} item(s) unknown cost, excluded` : undefined}
          />
        </div>
        <p className="text-xs text-gray-400">
          GMV is gross merchandise value, not revenue. Consignment commission and buyout gross margin are different
          measures over different item populations — never blended, never called profit.
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Buyer payments captured and seller payouts paid are shown separately, never netted — payment-processor fees,
          refunds, shipping cost, and tax are not tracked in this data model.
        </p>
      </section>

      <section className="flex flex-wrap gap-3">
        <Link href="/admin/finance" className="text-sm text-blue-600 hover:underline">&larr; Finance overview</Link>
        <Link href="/admin/seller-payouts" className="text-sm text-blue-600 hover:underline">Payouts</Link>
        <Link href="/admin/reconciliation" className="text-sm text-blue-600 hover:underline">Reconciliation</Link>
        <Link href="/admin/analytics" className="text-sm text-blue-600 hover:underline">Business Analytics</Link>
      </section>
    </div>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{title}</h3>
      {children}
    </div>
  )
}

function Stat({ label, value, note, href, emphasize }: { label: string; value: string; note?: string; href?: string; emphasize?: boolean }) {
  const body = (
    <>
      <p className={`font-bold text-gray-900 tabular-nums ${emphasize ? 'text-2xl' : 'text-xl'}`}>{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-0.5">{note}</p>}
    </>
  )
  const cls = 'rounded-md border border-gray-200 bg-white p-4' + (href ? ' hover:bg-gray-50 transition-colors' : '')
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>
}

// Renders a FinancialMetric<Decimal> as either its dollar value or its coverage
// percent, always distinguishing available/partial/unavailable — never a bare "$0"
// or "0%" standing in for missing data (Part S/46).
function MetricStat({ label, metric, kind }: { label: string; metric: FinancialMetric<Prisma.Decimal>; kind: 'usd' | 'pct' }) {
  if (metric.status === 'unavailable') {
    return <Stat label={label} value="Not available" note={metric.reason} />
  }
  if (kind === 'usd') {
    return (
      <Stat
        label={label}
        value={fmtUsdDecimal(metric.value)}
        note={metric.status === 'partial' ? `${fmtPct(metric.coveragePct)} of units — do not read as total inventory cost` : undefined}
      />
    )
  }
  const pct = metric.status === 'partial' ? metric.coveragePct : 100
  return <Stat label={label} value={fmtPct(pct)} note={metric.status === 'partial' ? `${metric.knownUnits} of ${metric.totalUnits} units` : 'All units'} />
}

// Reuses exactly the presets parseDateRangeParams already supports (14B) — no
// second timezone/range convention invented for this page (Part J/28).
const PERIOD_OPTIONS: { key: string; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'all', label: 'All time' },
]

function PeriodFilter({ range }: { range: { preset: string } }) {
  const options = PERIOD_OPTIONS
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Link
          key={o.key}
          href={`/admin/finance/position?period=${o.key}`}
          className={`px-3 py-1.5 rounded-md text-sm border ${range.preset === o.key ? 'border-gray-900 text-gray-900 font-medium' : 'border-gray-200 text-gray-500 hover:text-gray-900'}`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  )
}
