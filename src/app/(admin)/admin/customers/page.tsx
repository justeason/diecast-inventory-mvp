import Link from 'next/link'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export default async function AdminCustomersPage() {
  const profiles = await prisma.customerProfile.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      _count: { select: { orders: true } },
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  })

  // Sort by most recent order desc; profiles with no orders at end
  const sorted = [...profiles].sort((a, b) => {
    const aDate = a.orders[0]?.createdAt ?? null
    const bDate = b.orders[0]?.createdAt ?? null
    if (!aDate && !bDate) return 0
    if (!aDate) return 1
    if (!bDate) return -1
    return bDate.getTime() - aDate.getTime()
  })

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
        <span className="text-sm text-gray-500">{sorted.length} total</span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500">
          No customer profiles yet. They are created automatically when buyers place orders.
        </p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium text-right">Orders</th>
                <th className="px-4 py-3 font-medium">Last Order</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{p.name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{p.email}</td>
                  <td className="px-4 py-3 text-gray-500">{p.phone ?? '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {p._count.orders}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {p.orders[0]?.createdAt.toLocaleDateString() ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/customers/${p.id}`}
                      className="text-sm text-gray-600 hover:text-gray-900"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
