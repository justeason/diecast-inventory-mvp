import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getOutstandingLiability } from '@/lib/businessAnalyticsQuery'
import { fmtUsdDecimal } from '@/lib/businessAnalyticsFormat'
import { getExceptionQueueSummary } from '@/lib/intakeExceptionQueueQuery'

export const dynamic = 'force-dynamic'

// 15H Part F section 19 — lightweight Sellers domain hub. Seller Portfolio is the
// primary operational entry point (SellerSubmission is a supporting intake record,
// not the mental center of seller ops — see Part F). Read-only; only cheap stored-
// status groupBy/counts, no per-portfolio stage hydration on this page (that's what
// the bounded needs_attention scan on /admin/seller-portfolios itself is for).

export default async function SellersHubPage() {
  const [portfolioCountRows, sellerProfileCountRows, exceptionSummary, outstandingLiability] = await Promise.all([
    prisma.sellerPortfolio.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.sellerProfile.groupBy({ by: ['status'], _count: { _all: true } }),
    getExceptionQueueSummary({}),
    getOutstandingLiability(),
  ])
  const openExceptions = exceptionSummary.open

  const portfolioCounts: Record<string, number> = {}
  for (const r of portfolioCountRows) portfolioCounts[r.status] = r._count._all
  const sellerCounts: Record<string, number> = {}
  for (const r of sellerProfileCountRows) sellerCounts[r.status] = r._count._all

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Sellers</h1>

      <div className="mb-8">
        <Link
          href="/admin/seller-portfolios"
          className="inline-block rounded-md bg-gray-900 text-white px-4 py-2 text-sm font-medium hover:bg-gray-800"
        >
          Open Seller Portfolios →
        </Link>
      </div>

      <Section title="Portfolios (by status)">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Draft" count={portfolioCounts['draft'] ?? 0} href="/admin/seller-portfolios" />
          <StatCard label="Open" count={portfolioCounts['open'] ?? 0} href="/admin/seller-portfolios" />
          <StatCard label="Completed" count={portfolioCounts['completed'] ?? 0} href="/admin/seller-portfolios" />
          <StatCard label="Needs attention" count={undefined} href="/admin/seller-portfolios?filter=needs_attention" note="Review" />
        </div>
      </Section>

      <Section title="Seller Profiles">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Active" count={sellerCounts['active'] ?? 0} href="/admin/seller-profiles" />
          <StatCard label="Pending" count={sellerCounts['pending'] ?? 0} href="/admin/seller-profiles" />
          <StatCard label="Suspended" count={sellerCounts['suspended'] ?? 0} href="/admin/seller-profiles" />
        </div>
      </Section>

      <Section title="Signals">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Open intake exceptions" count={openExceptions} href="/admin/intake/exceptions" />
          <StatCard label="Outstanding payout liability" count={undefined} href="/admin/seller-payouts" note={fmtUsdDecimal(outstandingLiability)} />
        </div>
      </Section>

      <Section title="Other tools">
        <div className="flex flex-wrap gap-3">
          <ToolLink href="/admin/seller-submissions" label="Submissions (intake source records)" />
          <ToolLink href="/admin/commission-policies" label="Commission Policies" />
          <ToolLink href="/admin/seller-lifecycle" label="Lifecycle Cases (legacy)" />
        </div>
      </Section>
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

function StatCard({ label, count, href, note }: { label: string; count: number | undefined; href: string; note?: string }) {
  return (
    <Link href={href} className="rounded-md border border-gray-200 bg-white p-4 hover:bg-gray-50 transition-colors">
      <p className="text-2xl font-bold text-gray-900 tabular-nums">{count !== undefined ? count : note}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </Link>
  )
}

function ToolLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="rounded-md border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50 transition-colors">
      <p className="text-sm font-medium text-gray-900">{label}</p>
    </Link>
  )
}
