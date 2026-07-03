import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'

export const metadata: Metadata = {
  title: 'Order Status | CollectNTrades',
  robots: { index: false, follow: false },
}

const STATUS_LABELS: Record<string, string> = {
  pending:   'Pending',
  paid:      'Paid',
  picking:   'Picking',
  shipped:   'Shipped',
  complete:  'Complete',
  cancelled: 'Cancelled',
}

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  paid:      'bg-blue-100 text-blue-700',
  picking:   'bg-purple-100 text-purple-700',
  shipped:   'bg-indigo-100 text-indigo-700',
  complete:  'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

const STATUS_DESCRIPTIONS: Record<string, string> = {
  pending:   'Your order request has been received and is awaiting review.',
  paid:      'Payment has been confirmed. We are getting your items ready.',
  picking:   'Your items are being prepared for shipment.',
  shipped:   'Your order has been shipped or is ready for pickup.',
  complete:  'Your order is complete. Thank you!',
  cancelled: 'This order has been cancelled.',
}

function LookupForm({ orderId, email }: { orderId?: string; email?: string }) {
  return (
    <form action="/order-status" method="GET" className="space-y-4">
      <div>
        <label htmlFor="orderId" className="block text-sm font-medium text-gray-700 mb-1">
          Order ID
        </label>
        <input
          id="orderId"
          name="orderId"
          type="text"
          required
          defaultValue={orderId ?? ''}
          placeholder="Paste your order ID here"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <p className="mt-1 text-xs text-gray-400">
          Found in your order confirmation page after submitting a request.
        </p>
      </div>

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
          Email Address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          defaultValue={email ?? ''}
          placeholder="The email you used when ordering"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <button
        type="submit"
        className="rounded-md bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
      >
        Look Up Order
      </button>
    </form>
  )
}

export default async function OrderStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string; email?: string }>
}) {
  const { orderId: rawOrderId, email: rawEmail } = await searchParams

  const orderId = rawOrderId?.trim() ?? ''
  const email   = rawEmail?.trim()   ?? ''

  // Show blank form if no params submitted yet.
  const hasQuery = orderId !== '' && email !== ''

  let order: {
    buyerName: string
    status: string
    notes: string | null
    estimatedShipping: number | null
    createdAt: Date
    orderItems: Array<{ price: number; listing: { title: string } }>
  } | null = null

  if (hasQuery) {
    order = await prisma.order.findFirst({
      where: {
        id: orderId,
        buyerEmail: { equals: email, mode: 'insensitive' },
      },
      select: {
        buyerName:        true,
        status:           true,
        notes:            true,
        estimatedShipping: true,
        createdAt:        true,
        orderItems: {
          select: {
            price:   true,
            listing: { select: { title: true } },
          },
        },
      },
    })
  }

  const notFound = hasQuery && order === null

  const subtotal = order
    ? order.orderItems.reduce((sum, oi) => sum + oi.price, 0)
    : 0
  const hasShipping = order?.estimatedShipping != null
  const total = hasShipping ? subtotal + order!.estimatedShipping! : null

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Order Status</h1>
      <p className="text-sm text-gray-500 mb-8">
        Enter your order ID and email address to check the status of your order request.
      </p>

      {/* Always show the form — pre-filled on error, blank on first load, blank after success */}
      {!order && (
        <>
          <LookupForm orderId={notFound ? orderId : undefined} email={notFound ? email : undefined} />

          {notFound && (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              No matching order found. Please check your order ID and email address.
            </p>
          )}
        </>
      )}

      {/* Results */}
      {order && (
        <div className="space-y-6">
          {/* Status badge */}
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[order.status] ?? 'bg-gray-100 text-gray-600'}`}
            >
              {STATUS_LABELS[order.status] ?? order.status}
            </span>
          </div>

          {STATUS_DESCRIPTIONS[order.status] && (
            <p className="text-sm text-gray-700">
              {STATUS_DESCRIPTIONS[order.status]}
            </p>
          )}

          {/* Order summary */}
          <div className="rounded-md border border-gray-200 bg-gray-50 px-5 py-4 space-y-2 text-sm">
            <div className="flex gap-3">
              <span className="text-gray-500 w-28 shrink-0">Name</span>
              <span className="text-gray-900 font-medium">{order.buyerName}</span>
            </div>
            <div className="flex gap-3">
              <span className="text-gray-500 w-28 shrink-0">Submitted</span>
              <span className="text-gray-900">
                {order.createdAt.toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-gray-500 w-28 shrink-0">Items</span>
              <span className="text-gray-900">{order.orderItems.length}</span>
            </div>
            {order.notes && (
              <div className="flex gap-3">
                <span className="text-gray-500 w-28 shrink-0 align-top">Your Notes</span>
                <span className="text-gray-900">{order.notes}</span>
              </div>
            )}
          </div>

          {/* Item list */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Items</h2>
            <div className="rounded-md border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {order.orderItems.map((oi, i) => (
                    <tr key={i} className="bg-white">
                      <td className="px-4 py-3 text-gray-900">{oi.listing.title}</td>
                      <td className="px-4 py-3 text-right text-gray-700 font-medium whitespace-nowrap">
                        ${oi.price.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t border-gray-200">
                  <tr>
                    <td className="px-4 py-2 text-sm text-gray-500">Subtotal</td>
                    <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">
                      ${subtotal.toFixed(2)}
                    </td>
                  </tr>
                  {hasShipping && (
                    <tr>
                      <td className="px-4 py-2 text-sm text-gray-500">Est. Shipping</td>
                      <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">
                        ${order.estimatedShipping!.toFixed(2)}
                      </td>
                    </tr>
                  )}
                  {total !== null && (
                    <tr className="border-t border-gray-200">
                      <td className="px-4 py-2 text-sm font-semibold text-gray-900">Est. Total</td>
                      <td className="px-4 py-2 text-right text-sm font-bold text-gray-900">
                        ${total.toFixed(2)}
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
          </div>

          <p className="text-xs text-gray-400">
            This is an order request — not a confirmed purchase. We will contact you to
            confirm availability, payment, and shipping.
          </p>

          <a
            href="/order-status"
            className="inline-block text-sm text-gray-500 hover:text-gray-900"
          >
            ← Look up another order
          </a>
        </div>
      )}
    </div>
  )
}
