import Link from 'next/link'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

// 15H Part F section 18 — lightweight Inventory domain hub. Read-only; links into
// the existing authoritative Items/Listings/Storage/Valuation/Reconciliation pages
// rather than duplicating their tables (Part J section 33). The only queries here
// are the same cheap status groupBy the old /admin homepage already ran.

export default async function InventoryHubPage() {
  const [itemCountRows, locationCount, listingCountRows] = await Promise.all([
    prisma.itemInstance.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.storageLocation.count(),
    prisma.listing.groupBy({ by: ['status'], _count: { _all: true } }),
  ])

  const itemCounts: Record<string, number> = {}
  for (const r of itemCountRows) itemCounts[r.status] = r._count._all
  const listingCounts: Record<string, number> = {}
  for (const r of listingCountRows) listingCounts[r.status] = r._count._all

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Inventory</h1>

      <Section title="Physical Items">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Available" count={itemCounts['available'] ?? 0} href="/admin/items?status=available" />
          <StatCard label="Reserved" count={itemCounts['reserved'] ?? 0} href="/admin/items?status=reserved" />
          <StatCard label="Sold" count={itemCounts['sold'] ?? 0} href="/admin/items?status=sold" />
          <StatCard label="Draft" count={itemCounts['draft'] ?? 0} href="/admin/items?status=draft" />
        </div>
        <Link href="/admin/items" className="mt-3 inline-block text-sm text-blue-600 hover:underline">
          Open Items →
        </Link>
      </Section>

      <Section title="Listings">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Active" count={listingCounts['active'] ?? 0} href="/admin/listings" />
          <StatCard label="Sold" count={listingCounts['sold'] ?? 0} href="/admin/listings" />
          <StatCard label="Archived" count={listingCounts['archived'] ?? 0} href="/admin/listings" />
        </div>
      </Section>

      <Section title="Tools">
        <div className="flex flex-wrap gap-3">
          <ToolLink href="/admin/locations" label="Storage" detail={`${locationCount} location${locationCount !== 1 ? 's' : ''}`} />
          <ToolLink href="/admin/valuation" label="Valuation / Pricing Opportunities" />
          <ToolLink href="/admin/reconciliation" label="Inventory Reconciliation" />
          <ToolLink href="/admin/resale-estimator" label="Resale Estimator" />
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

function StatCard({ label, count, href }: { label: string; count: number; href: string }) {
  return (
    <Link href={href} className="rounded-md border border-gray-200 bg-white p-4 hover:bg-gray-50 transition-colors">
      <p className="text-2xl font-bold text-gray-900 tabular-nums">{count}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </Link>
  )
}

function ToolLink({ href, label, detail }: { href: string; label: string; detail?: string }) {
  return (
    <Link href={href} className="rounded-md border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50 transition-colors">
      <p className="text-sm font-medium text-gray-900">{label}</p>
      {detail && <p className="text-xs text-gray-400 mt-0.5">{detail}</p>}
    </Link>
  )
}
