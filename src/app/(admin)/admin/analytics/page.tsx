import Link from 'next/link'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

// ─── Labels ───────────────────────────────────────────────────────────────────

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending:   'Pending',
  paid:      'Paid',
  picking:   'Picking',
  shipped:   'Shipped',
  complete:  'Complete',
  cancelled: 'Cancelled',
}

const ORDER_STATUS_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  paid:      'bg-blue-100 text-blue-700',
  picking:   'bg-indigo-100 text-indigo-700',
  shipped:   'bg-purple-100 text-purple-700',
  complete:  'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid:    'Unpaid',
  requested: 'Requested',
  paid:      'Confirmed',
}

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid:    'bg-yellow-100 text-yellow-700',
  requested: 'bg-orange-100 text-orange-700',
  paid:      'bg-green-100 text-green-700',
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type MetricColor = 'gray' | 'green' | 'yellow' | 'blue' | 'orange' | 'teal'

const METRIC_STYLES: Record<MetricColor, string> = {
  gray:   'bg-gray-50 border-gray-200',
  green:  'bg-green-50 border-green-200',
  yellow: 'bg-yellow-50 border-yellow-200',
  blue:   'bg-blue-50 border-blue-200',
  orange: 'bg-orange-50 border-orange-200',
  teal:   'bg-teal-50 border-teal-200',
}

function MetricCard({
  label,
  value,
  color = 'gray',
  note,
}: {
  label: string
  value: string
  color?: MetricColor
  note?: string
}) {
  return (
    <div className={`rounded-md border p-4 ${METRIC_STYLES[color]}`}>
      <p className="text-2xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-500 mt-1.5">{label}</p>
      {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
    </div>
  )
}

function SectionHeader({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{title}</h2>
      {note && <p className="text-xs text-gray-400 mt-0.5">{note}</p>}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AdminAnalyticsPage() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [
    completedOrders,
    inProgressOrders,
    activeListingAgg,
    soldListingAgg,
    paymentCountRows,
    attentionOrders,
    recentCompleted,
    costBasisAgg,
    totalItemCount,
  ] = await Promise.all([
    // Revenue: complete orders with item prices + shipping
    prisma.order.findMany({
      where: { status: 'complete' },
      select: {
        estimatedShipping: true,
        orderItems: { select: { price: true } },
      },
    }),

    // In-progress orders (paid/picking/shipped)
    prisma.order.findMany({
      where: { status: { in: ['paid', 'picking', 'shipped'] } },
      select: { orderItems: { select: { price: true } } },
    }),

    // Active listing aggregate value
    prisma.listing.aggregate({
      where: { status: 'active' },
      _sum: { price: true },
      _count: { _all: true },
    }),

    // Sold listing aggregate value
    prisma.listing.aggregate({
      where: { status: 'sold' },
      _sum: { price: true },
      _count: { _all: true },
    }),

    // Payment status counts (non-cancelled orders only)
    prisma.order.groupBy({
      by: ['paymentStatus'],
      where: { status: { notIn: ['cancelled'] } },
      _count: { _all: true },
    }),

    // Orders needing attention (same logic as 8Q digest)
    prisma.order.findMany({
      where: {
        status: { notIn: ['complete', 'cancelled'] },
        OR: [
          { createdAt: { gte: twentyFourHoursAgo } },
          { status: 'pending' },
          { paymentStatus: { in: ['unpaid', 'requested'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        buyerName: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        orderItems: { select: { price: true } },
      },
    }),

    // Recently completed orders
    prisma.order.findMany({
      where: { status: 'complete' },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        buyerName: true,
        estimatedShipping: true,
        updatedAt: true,
        orderItems: { select: { price: true } },
      },
    }),

    // Item cost basis (purchase price) — partial coverage expected
    prisma.itemInstance.aggregate({
      where: { purchasePrice: { not: null } },
      _sum: { purchasePrice: true },
      _count: { _all: true },
    }),

    prisma.itemInstance.count(),
  ])

  // ── Derived metrics ──────────────────────────────────────────────────────────

  const revenue = completedOrders.reduce((sum, o) => {
    const subtotal = o.orderItems.reduce((s, oi) => s + oi.price, 0)
    return sum + subtotal + (o.estimatedShipping ?? 0)
  }, 0)
  const completedCount = completedOrders.length
  const avgOrderValue  = completedCount > 0 ? revenue / completedCount : 0

  const inProgressValue = inProgressOrders.reduce(
    (sum, o) => sum + o.orderItems.reduce((s, oi) => s + oi.price, 0),
    0
  )

  const activeListingValue = activeListingAgg._sum.price ?? 0
  const activeListingCount = activeListingAgg._count._all
  const soldListingValue   = soldListingAgg._sum.price ?? 0
  const soldListingCount   = soldListingAgg._count._all

  const paymentCounts: Record<string, number> = {}
  for (const row of paymentCountRows) {
    paymentCounts[row.paymentStatus] = row._count._all
  }

  const hasCostBasis    = costBasisAgg._count._all > 0
  const totalCostBasis  = costBasisAgg._sum.purchasePrice ?? 0
  const costBasisCount  = costBasisAgg._count._all

  const $ = (n: number) => `$${n.toFixed(2)}`

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Sales &amp; Analytics</h1>
        <p className="text-sm text-gray-500 mt-1">All-time totals. Admin use only.</p>
      </div>

      {/* ── Revenue ──────────────────────────────────────────────────────────── */}
      <section className="mb-8">
        <SectionHeader
          title="Revenue"
          note="Completed orders only. Estimated shipping included where entered; excluded otherwise."
        />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <MetricCard label="Completed Revenue"  value={$(revenue)}        color="green" />
          <MetricCard label="Avg Order Value"     value={$(avgOrderValue)}  color="gray" />
          <MetricCard label="Completed Orders"    value={String(completedCount)} color="blue" />
          <MetricCard
            label="In-Progress Value"
            value={$(inProgressValue)}
            color="yellow"
            note="Paid / picking / shipped — not yet complete"
          />
        </div>
      </section>

      {/* ── Listing Value ─────────────────────────────────────────────────────── */}
      <section className="mb-8">
        <SectionHeader title="Listing Value" note="Based on listing prices, not purchase cost." />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <MetricCard label="Active Listing Value" value={$(activeListingValue)} color="teal" />
          <MetricCard label="Sold Listing Value"   value={$(soldListingValue)}   color="gray" />
          <MetricCard label="Active Listings"      value={String(activeListingCount)} color="green" />
          <MetricCard label="Sold Listings"        value={String(soldListingCount)}   color="gray" />
        </div>
      </section>

      {/* ── Payment Tracking ─────────────────────────────────────────────────── */}
      <section className="mb-8">
        <SectionHeader title="Payment Tracking" note="Non-cancelled orders only." />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <MetricCard
            label="Unpaid"
            value={String(paymentCounts['unpaid'] ?? 0)}
            color="yellow"
          />
          <MetricCard
            label="Payment Requested"
            value={String(paymentCounts['requested'] ?? 0)}
            color="orange"
          />
          <MetricCard
            label="Payment Confirmed"
            value={String(paymentCounts['paid'] ?? 0)}
            color="green"
          />
        </div>
      </section>

      {/* ── Item Cost Basis (conditional) ────────────────────────────────────── */}
      {hasCostBasis && (
        <section className="mb-8">
          <SectionHeader title="Item Cost Basis" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard
              label="Total Cost Basis"
              value={$(totalCostBasis)}
              color="gray"
              note={`${costBasisCount} of ${totalItemCount} items have a purchase price`}
            />
          </div>
        </section>
      )}

      {/* ── Orders Needing Attention ─────────────────────────────────────────── */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <SectionHeader
            title="Orders Needing Attention"
            note="New (last 24 h), pending, or with unresolved payment."
          />
          <Link href="/admin/orders" className="text-xs text-gray-400 hover:text-gray-700">
            View all →
          </Link>
        </div>
        {attentionOrders.length === 0 ? (
          <p className="text-sm text-gray-500 rounded-md border border-green-200 bg-green-50 px-4 py-3">
            No orders need attention right now.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Buyer</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Payment</th>
                  <th className="px-4 py-3 font-medium">Subtotal</th>
                  <th className="px-4 py-3 font-medium">Submitted</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {attentionOrders.map((o) => {
                  const subtotal = o.orderItems.reduce((s, oi) => s + oi.price, 0)
                  return (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{o.buyerName}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {ORDER_STATUS_LABELS[o.status] ?? o.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_COLORS[o.paymentStatus] ?? 'bg-gray-100 text-gray-600'}`}>
                          {PAYMENT_STATUS_LABELS[o.paymentStatus] ?? o.paymentStatus}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">
                        {$(subtotal)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
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

      {/* ── Recently Completed Orders ─────────────────────────────────────────── */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <SectionHeader
            title="Recently Completed Orders"
            note="Sorted by last updated — most recently completed first."
          />
          <Link
            href="/admin/orders?status=complete"
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            View all →
          </Link>
        </div>
        {recentCompleted.length === 0 ? (
          <p className="text-sm text-gray-500">No completed orders yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Buyer</th>
                  <th className="px-4 py-3 font-medium">Items</th>
                  <th className="px-4 py-3 font-medium">Subtotal</th>
                  <th className="px-4 py-3 font-medium">Shipping</th>
                  <th className="px-4 py-3 font-medium">Total</th>
                  <th className="px-4 py-3 font-medium">Completed</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recentCompleted.map((o) => {
                  const subtotal = o.orderItems.reduce((s, oi) => s + oi.price, 0)
                  const shipping = o.estimatedShipping ?? null
                  const total    = shipping !== null ? subtotal + shipping : null
                  return (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{o.buyerName}</td>
                      <td className="px-4 py-3 text-gray-500">{o.orderItems.length}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">
                        {$(subtotal)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">
                        {shipping !== null ? $(shipping) : '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">
                        {total !== null ? $(total) : $(subtotal)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {o.updatedAt.toLocaleDateString()}
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
    </>
  )
}
