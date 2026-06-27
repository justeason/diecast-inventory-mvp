import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { OrderStatusForm } from '@/components/admin/OrderStatusForm'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
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

export default async function AdminOrderDetailPage({
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
              cardedOrLoose: true,
              condition: true,
              catalog: {
                select: { brand: true, name: true, year: true, series: true, color: true },
              },
              location: { select: { label: true } },
              photos: { where: { type: 'front' }, take: 1, select: { url: true } },
            },
          },
        },
      },
    },
  })

  if (!order) notFound()

  const subtotal = order.orderItems.reduce((sum, oi) => sum + oi.price, 0)

  const pickingList = [...order.orderItems].sort((a, b) => {
    const la = a.item.location?.label ?? '￿'
    const lb = b.item.location?.label ?? '￿'
    return la.localeCompare(lb)
  })

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/orders" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Orders
        </Link>
      </div>

      {/* Order header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Order Details</h1>
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

      {/* Buyer info + order meta */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8 rounded-md border border-gray-200 bg-gray-50 p-6">
        <div className="space-y-2 text-sm">
          <h2 className="font-semibold text-gray-900 mb-3">Buyer</h2>
          <p>
            <span className="text-gray-500 w-16 inline-block">Name</span>
            <span className="font-medium text-gray-900">{order.buyerName}</span>
          </p>
          <p>
            <span className="text-gray-500 w-16 inline-block">Email</span>
            <span className="text-gray-900">{order.buyerEmail}</span>
          </p>
          <p>
            <span className="text-gray-500 w-16 inline-block">Phone</span>
            <span className="text-gray-900">{order.buyerPhone ?? '—'}</span>
          </p>
          {order.notes && (
            <p>
              <span className="text-gray-500 w-16 inline-block align-top">Notes</span>
              <span className="text-gray-900">{order.notes}</span>
            </p>
          )}
        </div>

        <div className="space-y-2 text-sm">
          <h2 className="font-semibold text-gray-900 mb-3">Summary</h2>
          <p>
            <span className="text-gray-500 w-20 inline-block">Items</span>
            <span className="text-gray-900">{order.orderItems.length}</span>
          </p>
          <p>
            <span className="text-gray-500 w-20 inline-block">Subtotal</span>
            <span className="font-medium text-gray-900">${subtotal.toFixed(2)}</span>
          </p>
          <p>
            <span className="text-gray-500 w-20 inline-block">Status</span>
            <span className="text-gray-900">{STATUS_LABELS[order.status] ?? order.status}</span>
          </p>
          <p>
            <span className="text-gray-500 w-20 inline-block">Created</span>
            <span className="text-gray-900">{order.createdAt.toLocaleDateString()}</span>
          </p>
        </div>
      </div>

      {/* Order items */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Items</h2>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium w-14"></th>
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Listing</th>
                <th className="px-4 py-3 font-medium">Catalog</th>
                <th className="px-4 py-3 font-medium">Condition</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium text-right">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {order.orderItems.map((oi) => {
                const { catalog } = oi.item
                const catalogStr = [
                  `${catalog.brand} ${catalog.name}`,
                  catalog.year?.toString(),
                  catalog.series,
                  catalog.color,
                ]
                  .filter(Boolean)
                  .join(' · ')

                return (
                  <tr key={oi.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <PhotoThumbnail
                        photoUrl={oi.item.photos[0]?.url ?? null}
                        alt={oi.listing.title}
                        size="sm"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{oi.item.sku}</td>
                    <td className="px-4 py-3 text-gray-900">{oi.listing.title}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{catalogStr}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {CONDITION_LABELS[oi.item.condition] ?? oi.item.condition}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {oi.item.cardedOrLoose === 'carded' ? 'Carded' : 'Loose'}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {oi.item.location?.label ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      ${oi.price.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Picking list */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Picking List</h2>
        <p className="text-xs text-gray-500 mb-3">Sorted by storage location. Items without a location appear last.</p>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium w-14"></th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Item</th>
                <th className="px-4 py-3 font-medium">Condition</th>
                <th className="px-4 py-3 font-medium">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pickingList.map((oi) => (
                <tr key={oi.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <PhotoThumbnail
                      photoUrl={oi.item.photos[0]?.url ?? null}
                      alt={oi.listing.title}
                      size="sm"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-700">
                    {oi.item.location?.label ?? <span className="text-gray-400">No location</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{oi.item.sku}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {oi.item.catalog.brand} {oi.item.catalog.name}
                    {oi.item.catalog.year ? ` (${oi.item.catalog.year})` : ''}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {CONDITION_LABELS[oi.item.condition] ?? oi.item.condition}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {oi.item.cardedOrLoose === 'carded' ? 'Carded' : 'Loose'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Status update */}
      <div className="border-t border-gray-200 pt-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Update Status</h2>
        <OrderStatusForm orderId={order.id} currentStatus={order.status} />
      </div>
    </>
  )
}
