import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  picking: 'Picking',
  shipped: 'Shipped',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-blue-100 text-blue-700',
  picking: 'bg-purple-100 text-purple-700',
  shipped: 'bg-indigo-100 text-indigo-700',
  complete: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: 'Unpaid',
  requested: 'Requested',
  paid: 'Paid',
}

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: 'bg-yellow-100 text-yellow-700',
  requested: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
}

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const profile = await prisma.customerProfile.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      notes: true,
      createdAt: true,
      orders: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          estimatedShipping: true,
          createdAt: true,
          orderItems: { select: { price: true } },
        },
      },
    },
  })

  if (!profile) notFound()

  const totalOrders = profile.orders.length
  const paidOrders = profile.orders.filter((o) => o.paymentStatus === 'paid').length
  const completedOrders = profile.orders.filter((o) => o.status === 'complete').length
  const totalPaidAmount = profile.orders
    .filter((o) => o.paymentStatus === 'paid')
    .reduce((sum, o) => {
      const subtotal = o.orderItems.reduce((s, oi) => s + oi.price, 0)
      return sum + subtotal + (o.estimatedShipping ?? 0)
    }, 0)

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/customers" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Customers
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">
        {profile.name ?? profile.email}
      </h1>
      <p className="text-sm text-gray-500 mb-8">
        Customer since {profile.createdAt.toLocaleDateString()}
      </p>

      {/* Profile info */}
      <div className="mb-8 rounded-md border border-gray-200 bg-gray-50 p-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Profile</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="text-gray-500 w-16 shrink-0">Name</dt>
            <dd className="text-gray-900">{profile.name ?? '—'}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-16 shrink-0">Email</dt>
            <dd className="text-gray-900">{profile.email}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-16 shrink-0">Phone</dt>
            <dd className="text-gray-900">{profile.phone ?? '—'}</dd>
          </div>
          {profile.notes && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-16 shrink-0 align-top">Notes</dt>
              <dd className="text-gray-900">{profile.notes}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* Stats */}
      <div className="mb-8 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Orders" value={String(totalOrders)} />
        <StatCard label="Paid Orders" value={String(paidOrders)} />
        <StatCard label="Completed Orders" value={String(completedOrders)} />
        <StatCard label="Total Paid" value={`$${totalPaidAmount.toFixed(2)}`} />
      </div>

      {/* Orders table */}
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Orders</h2>
      {profile.orders.length === 0 ? (
        <p className="text-sm text-gray-500">No orders yet.</p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Order ID</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Payment</th>
                <th className="px-4 py-3 font-medium text-right">Subtotal</th>
                <th className="px-4 py-3 font-medium text-right">Shipping</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {profile.orders.map((o) => {
                const subtotal = o.orderItems.reduce((sum, oi) => sum + oi.price, 0)
                const shipping = o.estimatedShipping
                const total = subtotal + (shipping ?? 0)
                return (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      {o.id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {o.createdAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {ORDER_STATUS_LABELS[o.status] ?? o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_COLORS[o.paymentStatus] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {PAYMENT_STATUS_LABELS[o.paymentStatus] ?? o.paymentStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      ${subtotal.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-500">
                      {shipping !== null ? `$${shipping.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">
                      ${total.toFixed(2)}
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
    </>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-2xl font-bold tabular-nums text-gray-900">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </div>
  )
}
