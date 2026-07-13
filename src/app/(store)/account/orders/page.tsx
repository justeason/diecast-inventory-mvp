import type { Metadata } from 'next'
import { getBuyerSession } from '@/lib/buyerSession'
import { signOutBuyer } from '@/lib/actions/buyerAuth'
import { prisma } from '@/lib/prisma'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My Orders | CollectNTrades',
  robots: { index: false, follow: false },
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending:   'Pending review',
  paid:      'Paid',
  picking:   'Preparing',
  shipped:   'Shipped',
  complete:  'Complete',
  cancelled: 'Cancelled',
}

const ORDER_STATUS_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  paid:      'bg-blue-100 text-blue-700',
  picking:   'bg-purple-100 text-purple-700',
  shipped:   'bg-indigo-100 text-indigo-700',
  complete:  'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid:    'Payment not requested',
  requested: 'Payment requested',
  paid:      'Paid',
}

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid:    'bg-gray-100 text-gray-600',
  requested: 'bg-blue-100 text-blue-700',
  paid:      'bg-green-100 text-green-700',
}

export default async function BuyerOrdersPage() {
  const session = await getBuyerSession()

  // No valid session — show email request form
  if (!session) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">My Orders</h1>
        <p className="text-sm text-gray-500 mb-8">
          Enter your email address to receive a sign-in link and view your order history.
        </p>
        <BuyerOrderAccessForm />
      </div>
    )
  }

  // Session valid — load orders using only the server-side verified profileId.
  // customerProfileId is never sourced from request input.
  const orders = await prisma.order.findMany({
    where: { customerProfileId: session.profileId },
    orderBy: { createdAt: 'desc' },
    select: {
      id:                true,
      createdAt:         true,
      status:            true,
      paymentStatus:     true,
      notes:             true,
      estimatedShipping: true,
      orderItems: {
        select: {
          id:      true,
          price:   true,
          listing: { select: { title: true } },
        },
      },
    },
  })

  return (
    <div className="max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Orders</h1>
          <p className="text-sm text-gray-500 mt-1">
            {orders.length} order{orders.length !== 1 ? 's' : ''}
          </p>
        </div>
        <form action={signOutBuyer}>
          <button
            type="submit"
            className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            Sign out
          </button>
        </form>
      </div>

      {/* Empty state */}
      {orders.length === 0 && (
        <p className="text-sm text-gray-500">
          No orders yet. Once you place an order, it will appear here.
        </p>
      )}

      {/* Order cards */}
      <div className="space-y-6">
        {orders.map((order) => {
          const subtotal = order.orderItems.reduce((sum, oi) => sum + oi.price, 0)
          const hasShipping = order.estimatedShipping != null
          const total = subtotal + (order.estimatedShipping ?? 0)

          return (
            <div key={order.id} className="rounded-md border border-gray-200 bg-white overflow-hidden">

              {/* Card header: ID, date, status badges */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 bg-gray-50 border-b border-gray-200">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-gray-500">
                    {order.id.slice(0, 8)}&hellip;
                  </span>
                  <span className="text-xs text-gray-400">
                    {order.createdAt.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_COLORS[order.status] ?? 'bg-gray-100 text-gray-600'}`}
                  >
                    {ORDER_STATUS_LABELS[order.status] ?? order.status}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_COLORS[order.paymentStatus] ?? 'bg-gray-100 text-gray-600'}`}
                  >
                    {PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}
                  </span>
                </div>
              </div>

              {/* Item rows */}
              <div className="divide-y divide-gray-100">
                {order.orderItems.map((oi) => (
                  <div key={oi.id} className="flex justify-between items-center px-5 py-3 text-sm">
                    <span className="text-gray-900">{oi.listing.title}</span>
                    <span className="text-gray-700 font-medium tabular-nums ml-4 shrink-0">
                      ${oi.price.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Totals footer */}
              <div className="border-t border-gray-200 bg-gray-50 px-5 py-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Subtotal</span>
                  <span className="text-gray-700 tabular-nums">${subtotal.toFixed(2)}</span>
                </div>
                {hasShipping && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Est. Shipping</span>
                    <span className="text-gray-700 tabular-nums">
                      ${order.estimatedShipping!.toFixed(2)}
                    </span>
                  </div>
                )}
                {hasShipping && (
                  <div className="flex justify-between font-semibold border-t border-gray-200 pt-1">
                    <span className="text-gray-900">Est. Total</span>
                    <span className="text-gray-900 tabular-nums">${total.toFixed(2)}</span>
                  </div>
                )}
              </div>

              {/* Buyer notes (buyer-submitted, safe to display) */}
              {order.notes && (
                <div className="border-t border-gray-200 px-5 py-3 text-sm">
                  <span className="text-gray-500">Your notes: </span>
                  <span className="text-gray-700">{order.notes}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
