import Link from 'next/link'
import { type Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { OrderFilterBar } from '@/components/admin/OrderFilterBar'
import { Pagination } from '@/components/shared/Pagination'

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

const VALID_STATUSES = new Set(['pending', 'paid', 'picking', 'shipped', 'complete', 'cancelled'])
const VALID_SORTS = new Set(['newest', 'oldest', 'status', 'total_desc', 'total_asc'])

const PAGE_SIZE = 25

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string; page?: string }>
}) {
  const { q: rawQ, status: rawStatus, sort: rawSort, page: rawPage } = await searchParams

  const q = rawQ?.trim() ?? ''
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : ''
  const sort = rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'newest'
  const requestedPage = Math.max(1, parseInt(rawPage ?? '1') || 1)

  // Build where clause
  const where: Prisma.OrderWhereInput = {}

  if (q) {
    where.OR = [
      { buyerName: { contains: q } },
      { buyerEmail: { contains: q } },
      { notes: { contains: q } },
      { orderItems: { some: { item: { sku: { contains: q } } } } },
      { orderItems: { some: { listing: { title: { contains: q } } } } },
    ]
  }

  if (status) where.status = status

  const isTotalSort = sort === 'total_desc' || sort === 'total_asc'

  // Prisma orderBy used for non-total sorts; total sorts are handled in JS after fetch
  const orderBy: Prisma.OrderOrderByWithRelationInput = isTotalSort
    ? { createdAt: 'desc' }
    : sort === 'oldest'
      ? { createdAt: 'asc' }
      : sort === 'status'
        ? { status: 'asc' }
        : { createdAt: 'desc' }

  // Step 3: count filtered results
  const filteredCount = await prisma.order.count({ where })

  // Steps 4–6: compute pages, clamp, skip
  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)
  const skip = (page - 1) * PAGE_SIZE

  // Step 7: fetch — for total sorts, fetch all filtered then slice in JS
  let orders: Array<{
    id: string
    buyerName: string
    buyerEmail: string
    buyerPhone: string | null
    status: string
    createdAt: Date
    notes: string | null
    orderItems: Array<{ price: number }>
    total: number
  }>

  if (isTotalSort) {
    const rawOrders = await prisma.order.findMany({
      where,
      include: { orderItems: { select: { price: true } } },
    })
    orders = rawOrders
      .map((o) => ({ ...o, total: o.orderItems.reduce((sum, oi) => sum + oi.price, 0) }))
      .sort((a, b) => (sort === 'total_desc' ? b.total - a.total : a.total - b.total))
      .slice(skip, skip + PAGE_SIZE)
  } else {
    const rawOrders = await prisma.order.findMany({
      where,
      orderBy,
      skip,
      take: PAGE_SIZE,
      include: { orderItems: { select: { price: true } } },
    })
    orders = rawOrders.map((o) => ({
      ...o,
      total: o.orderItems.reduce((sum, oi) => sum + oi.price, 0),
    }))
  }

  const paginationParams: Record<string, string> = {}
  if (q) paginationParams.q = q
  if (status) paginationParams.status = status
  if (sort !== 'newest') paginationParams.sort = sort

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
      </div>

      <OrderFilterBar q={q} status={status} sort={sort} />

      {orders.length === 0 ? (
        <p className="text-sm text-gray-500">
          {filteredCount === 0 && (q || status)
            ? 'No orders match the current filters.'
            : 'No orders yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Buyer</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium">Subtotal</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{order.buyerName}</td>
                  <td className="px-4 py-3 text-gray-700">{order.buyerEmail}</td>
                  <td className="px-4 py-3 text-gray-500">{order.buyerPhone ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{order.orderItems.length}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">${order.total.toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[order.status] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {STATUS_LABELS[order.status] ?? order.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {order.createdAt.toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/orders/${order.id}`}
                      className="text-blue-600 hover:underline text-sm"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        totalCount={filteredCount}
        pageSize={PAGE_SIZE}
        basePath="/admin/orders"
        params={paginationParams}
      />
    </>
  )
}
