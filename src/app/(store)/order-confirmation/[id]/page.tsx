import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'

export const metadata: Metadata = {
  title: 'Order Confirmation | CollectNTrades',
  robots: { index: false, follow: false },
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  picking: 'Picking',
  shipped: 'Shipped',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-blue-100 text-blue-700',
  picking: 'bg-purple-100 text-purple-700',
  shipped: 'bg-indigo-100 text-indigo-700',
  complete: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      orderItems: {
        include: {
          listing: { select: { title: true } },
          item: {
            select: {
              sku: true,
              photos: { where: { type: 'front' }, take: 1, select: { url: true } },
            },
          },
        },
      },
    },
  })

  if (!order) notFound()

  const subtotal = order.orderItems.reduce((sum, oi) => sum + oi.price, 0)

  return (
    <>
      <div className="mb-6">
        <Link href="/browse" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Browse
        </Link>
      </div>

      <div className="max-w-2xl">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Order Confirmation</h1>
            <p className="text-sm text-gray-500 mt-1">
              Submitted {order.createdAt.toLocaleDateString()}
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[order.status] ?? 'bg-gray-100 text-gray-600'}`}
          >
            {STATUS_LABELS[order.status] ?? order.status}
          </span>
        </div>

        {/* Request notice */}
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 mb-6">
          <strong>This is an order request, not a confirmed purchase.</strong> We will contact
          you to confirm availability and arrange payment and shipping.
        </div>

        {/* Order ID */}
        <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm mb-6">
          <p className="text-gray-500 mb-1">Order ID</p>
          <p className="font-mono text-xs break-all text-gray-900 mb-2">{order.id}</p>
          <p className="text-xs text-gray-400">
            Save this order ID. You can use it with your email to check your order status at{' '}
            <a href="/order-status" className="underline hover:text-gray-600">
              collectntrades.com/order-status
            </a>
            .
          </p>
        </div>

        {/* Items */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Items</h2>
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-medium w-14"></th>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium text-right">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {order.orderItems.map((oi) => (
                  <tr key={oi.id}>
                    <td className="px-4 py-3">
                      <PhotoThumbnail
                        photoUrl={oi.item.photos[0]?.url ?? null}
                        alt={oi.listing.title}
                        size="sm"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{oi.listing.title}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{oi.item.sku}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      ${oi.price.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-gray-200 bg-gray-50">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-right font-semibold text-gray-900">
                    Subtotal
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    ${subtotal.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Buyer contact info */}
        <div className="rounded-md border border-gray-200 bg-gray-50 p-6 mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Your Contact Information</h2>
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-3">
              <dt className="text-gray-500 w-16 shrink-0">Name</dt>
              <dd className="text-gray-900 font-medium">{order.buyerName}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="text-gray-500 w-16 shrink-0">Email</dt>
              <dd className="text-gray-900">{order.buyerEmail}</dd>
            </div>
            {order.buyerPhone && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-16 shrink-0">Phone</dt>
                <dd className="text-gray-900">{order.buyerPhone}</dd>
              </div>
            )}
            {order.notes && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-16 shrink-0">Notes</dt>
                <dd className="text-gray-900">{order.notes}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Next steps */}
        <div className="rounded-md border border-gray-200 px-4 py-4 text-sm text-gray-700 mb-8">
          <h2 className="font-semibold text-gray-900 mb-2">What happens next?</h2>
          <ol className="space-y-1.5 list-decimal list-inside text-gray-600">
            <li>We will review your request and confirm item availability.</li>
            <li>
              We will contact you at <strong>{order.buyerEmail}</strong> to confirm the
              order and arrange payment.
            </li>
            <li>
              Once we agree on payment and shipping details, we&apos;ll get your items on their
              way.
            </li>
          </ol>
        </div>

        {/* CTA */}
        <Link
          href="/browse"
          className="text-sm font-medium text-gray-900 hover:underline underline-offset-2"
        >
          ← Continue browsing
        </Link>
      </div>
    </>
  )
}
