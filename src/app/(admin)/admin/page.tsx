import Link from 'next/link'
import { prisma } from '@/lib/prisma'

// ── Constants ────────────────────────────────────────────────────────────────

const INTAKE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  converted: 'Converted',
  rejected: 'Rejected',
}

const INTAKE_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700',
  reviewed: 'bg-blue-100 text-blue-700',
  converted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  picking: 'Picking',
  shipped: 'Shipped',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

// For inline rounded-full badges in tables
const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-blue-100 text-blue-700',
  picking: 'bg-indigo-100 text-indigo-700',
  shipped: 'bg-purple-100 text-purple-700',
  complete: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

// For the order pipeline row (with border)
const ORDER_PIPELINE_COLORS: Record<string, string> = {
  pending: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  paid: 'bg-blue-50 border-blue-200 text-blue-800',
  picking: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  shipped: 'bg-purple-50 border-purple-200 text-purple-800',
  complete: 'bg-green-50 border-green-200 text-green-800',
  cancelled: 'bg-red-50 border-red-200 text-red-800',
}

const LISTING_STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  sold: 'bg-gray-100 text-gray-600',
  archived: 'bg-gray-100 text-gray-500',
}

const ORDER_PIPELINE = ['pending', 'paid', 'picking', 'shipped', 'complete', 'cancelled'] as const

type CardColor = 'gray' | 'green' | 'yellow' | 'blue' | 'orange' | 'teal'

const CARD_STYLES: Record<CardColor, { wrapper: string; count: string }> = {
  gray: { wrapper: 'bg-gray-50 border-gray-200', count: 'text-gray-900' },
  green: { wrapper: 'bg-green-50 border-green-200', count: 'text-green-800' },
  yellow: { wrapper: 'bg-yellow-50 border-yellow-200', count: 'text-yellow-800' },
  blue: { wrapper: 'bg-blue-50 border-blue-200', count: 'text-blue-800' },
  orange: { wrapper: 'bg-orange-50 border-orange-200', count: 'text-orange-800' },
  teal: { wrapper: 'bg-teal-50 border-teal-200', count: 'text-teal-800' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toCounts(rows: Array<{ status: string; _count: { _all: number } }>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) {
    result[row.status] = row._count._all
  }
  return result
}

function sumPrices(items: Array<{ price: number }>): number {
  return items.reduce((acc, i) => acc + i.price, 0)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminDashboardPage() {
  const [
    itemCountRows,
    listingCountRows,
    orderCountRows,
    draftCountRows,
    catalogCount,
    locationCount,
    recentDrafts,
    recentOrders,
    recentListings,
  ] = await Promise.all([
    prisma.itemInstance.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.listing.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.intakeDraft.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.catalogModel.count(),
    prisma.storageLocation.count(),
    prisma.intakeDraft.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        brand: true,
        name: true,
        year: true,
        color: true,
        createdAt: true,
      },
    }),
    prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        buyerName: true,
        buyerEmail: true,
        createdAt: true,
        orderItems: { select: { price: true } },
      },
    }),
    prisma.listing.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        title: true,
        price: true,
        createdAt: true,
        item: { select: { sku: true } },
      },
    }),
  ])

  const itemCounts = toCounts(itemCountRows)
  const listingCounts = toCounts(listingCountRows)
  const orderCounts = toCounts(orderCountRows)
  const draftCounts = toCounts(draftCountRows)

  const totalItems = Object.values(itemCounts).reduce((sum, n) => sum + n, 0)
  const activeListings = listingCounts['active'] ?? 0

  const setupSteps = [
    {
      label: 'Create a storage location',
      href: '/admin/locations/new',
      done: locationCount >= 1,
      count: locationCount,
    },
    {
      label: 'Create a catalog model',
      href: '/admin/catalog/new',
      done: catalogCount >= 1,
      count: catalogCount,
    },
    {
      label: 'Create your first item',
      href: '/admin/items/new',
      done: totalItems >= 1,
      count: totalItems,
    },
    {
      label: 'Create your first listing',
      href: '/admin/listings/new',
      done: activeListings >= 1,
      count: activeListings,
    },
  ]

  const showSetup =
    locationCount === 0 || catalogCount === 0 || totalItems === 0 || activeListings === 0

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>

      {/* Production Setup */}
      {showSetup && (
        <section className="mb-8 rounded-md border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-semibold text-amber-900 mb-1">Production Setup</h2>
          <p className="text-sm text-amber-700 mb-4">
            This is your production database. All data created here is real and permanent. Complete
            the steps below to initialize your store.
          </p>
          <ol className="space-y-2 mb-5">
            {setupSteps.map((step) => (
              <li key={step.href} className="flex items-center gap-3 text-sm">
                {step.done ? (
                  <>
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-white text-xs font-bold shrink-0">
                      ✓
                    </span>
                    <span className="text-gray-500 line-through">{step.label}</span>
                    <span className="text-xs text-gray-400">({step.count})</span>
                  </>
                ) : (
                  <>
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-gray-300 shrink-0" />
                    <Link href={step.href} className="text-gray-900 font-medium hover:underline">
                      {step.label} →
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ol>
          <div className="border-t border-amber-200 pt-4 flex flex-wrap gap-4">
            <Link href="/browse" className="text-sm text-gray-600 hover:text-gray-900">
              Test buyer browse page →
            </Link>
            <Link href="/browse" className="text-sm text-gray-600 hover:text-gray-900">
              Test an order request →
            </Link>
          </div>
        </section>
      )}

      {/* Quick Actions */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Quick Actions
        </h2>
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'New Draft', href: '/admin/intake/new' },
            { label: 'Intake List', href: '/admin/intake' },
            { label: 'New Catalog', href: '/admin/catalog/new' },
            { label: 'New Item', href: '/admin/items/new' },
            { label: 'New Listing', href: '/admin/listings/new' },
            { label: 'Orders', href: '/admin/orders' },
            { label: 'Analytics', href: '/admin/analytics' },
          ].map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              {a.label}
            </Link>
          ))}
        </div>
      </section>

      {/* Summary Cards — Inventory */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Inventory
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SummaryCard label="Total Items" count={totalItems} href="/admin/items" color="gray" />
          <SummaryCard
            label="Available"
            count={itemCounts['available'] ?? 0}
            href="/admin/items"
            color="green"
          />
          <SummaryCard
            label="Reserved"
            count={itemCounts['reserved'] ?? 0}
            href="/admin/items"
            color="yellow"
          />
          <SummaryCard
            label="Sold"
            count={itemCounts['sold'] ?? 0}
            href="/admin/items"
            color="blue"
          />
        </div>
      </section>

      {/* Summary Cards — Listings, Orders, Intake */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Listings &amp; Intake
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SummaryCard
            label="Active Listings"
            count={listingCounts['active'] ?? 0}
            href="/admin/listings"
            color="green"
          />
          <SummaryCard
            label="Pending Orders"
            count={orderCounts['pending'] ?? 0}
            href="/admin/orders"
            color="yellow"
          />
          <SummaryCard
            label="Drafts to Review"
            count={draftCounts['draft'] ?? 0}
            href="/admin/intake?status=draft"
            color="orange"
          />
          <SummaryCard
            label="Converted Drafts"
            count={draftCounts['converted'] ?? 0}
            href="/admin/intake?status=converted"
            color="teal"
          />
        </div>
      </section>

      {/* Order Pipeline */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Order Pipeline
        </h2>
        <div className="flex flex-wrap gap-3">
          {ORDER_PIPELINE.map((s) => (
            <div
              key={s}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${ORDER_PIPELINE_COLORS[s]}`}
            >
              <span className="font-medium">{ORDER_STATUS_LABELS[s]}</span>
              <span className="font-bold tabular-nums">{orderCounts[s] ?? 0}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Recent Activity */}
      <div className="space-y-8">
        {/* Recent Intake Drafts */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Recent Intake Drafts
            </h2>
            <Link href="/admin/intake" className="text-xs text-gray-400 hover:text-gray-700">
              View all →
            </Link>
          </div>
          {recentDrafts.length === 0 ? (
            <p className="text-sm text-gray-500">None yet.</p>
          ) : (
            <div className="rounded-md border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-gray-500">
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recentDrafts.map((d) => {
                    const model =
                      [d.brand, d.name, d.year?.toString(), d.color].filter(Boolean).join(' · ') ||
                      '(no model info)'
                    return (
                      <tr key={d.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-gray-900">{model}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${INTAKE_STATUS_COLORS[d.status] ?? 'bg-gray-100 text-gray-600'}`}
                          >
                            {INTAKE_STATUS_LABELS[d.status] ?? d.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs">
                          {d.createdAt.toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            href={`/admin/intake/${d.id}/edit`}
                            className="text-sm text-gray-600 hover:text-gray-900"
                          >
                            {d.status === 'converted' || d.status === 'rejected' ? 'View' : 'Edit →'}
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Orders */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Recent Orders
            </h2>
            <Link href="/admin/orders" className="text-xs text-gray-400 hover:text-gray-700">
              View all →
            </Link>
          </div>
          {recentOrders.length === 0 ? (
            <p className="text-sm text-gray-500">None yet.</p>
          ) : (
            <div className="rounded-md border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-gray-500">
                    <th className="px-4 py-3 font-medium">Buyer</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Total</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recentOrders.map((o) => {
                    const buyer = o.buyerName.trim() || o.buyerEmail || 'Unknown buyer'
                    const total = sumPrices(o.orderItems)
                    return (
                      <tr key={o.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-gray-900">{buyer}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-100 text-gray-600'}`}
                          >
                            {ORDER_STATUS_LABELS[o.status] ?? o.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-700 font-mono text-xs">
                          ${total.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs">
                          {o.createdAt.toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            href={`/admin/orders/${o.id}`}
                            className="text-sm text-gray-600 hover:text-gray-900"
                          >
                            View →
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Listings */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Recent Listings
            </h2>
            <Link href="/admin/listings" className="text-xs text-gray-400 hover:text-gray-700">
              View all →
            </Link>
          </div>
          {recentListings.length === 0 ? (
            <p className="text-sm text-gray-500">None yet.</p>
          ) : (
            <div className="rounded-md border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-gray-500">
                    <th className="px-4 py-3 font-medium">Title</th>
                    <th className="px-4 py-3 font-medium">SKU</th>
                    <th className="px-4 py-3 font-medium">Price</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recentListings.map((l) => (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-900">{l.title}</td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                        {l.item?.sku ?? 'No SKU'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 font-mono text-xs">
                        ${l.price.toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${LISTING_STATUS_COLORS[l.status] ?? 'bg-gray-100 text-gray-600'}`}
                        >
                          {l.status.charAt(0).toUpperCase() + l.status.slice(1)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {l.createdAt.toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/admin/listings/${l.id}/edit`}
                          className="text-sm text-gray-600 hover:text-gray-900"
                        >
                          Edit →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Data Export */}
      <section className="mt-8 rounded-md border border-gray-200 bg-white p-5">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Data Export
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Download a CSV snapshot of any table. Each export is generated fresh from the database.
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Catalog Models', href: '/admin/export/catalog' },
            { label: 'Storage Locations', href: '/admin/export/locations' },
            { label: 'Items', href: '/admin/export/items' },
            { label: 'Listings', href: '/admin/export/listings' },
            { label: 'Orders', href: '/admin/export/orders' },
            { label: 'Order Items', href: '/admin/export/order-items' },
            { label: 'Intake Drafts', href: '/admin/export/intake' },
            { label: 'Photos', href: '/admin/export/photos' },
          ].map((e) => (
            <a
              key={e.href}
              href={e.href}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              {e.label} ↓
            </a>
          ))}
        </div>
      </section>
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  count,
  href,
  color,
}: {
  label: string
  count: number
  href: string
  color: CardColor
}) {
  const { wrapper, count: countColor } = CARD_STYLES[color]
  return (
    <Link
      href={href}
      className={`rounded-md border p-4 ${wrapper} hover:opacity-80 transition-opacity`}
    >
      <p className={`text-3xl font-bold tabular-nums ${countColor}`}>{count}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </Link>
  )
}
