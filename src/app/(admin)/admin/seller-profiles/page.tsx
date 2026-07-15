import Link from 'next/link'
import { prisma } from '@/lib/prisma'

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  active:    'bg-green-100 text-green-700',
  suspended: 'bg-red-100 text-red-700',
}

const STATUS_LABELS: Record<string, string> = {
  pending:   'Pending',
  active:    'Active',
  suspended: 'Suspended',
}

export default async function AdminSellerProfilesPage() {
  const sellers = await prisma.sellerProfile.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      profile: { select: { name: true, email: true } },
    },
  })

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Seller Profiles</h1>
        <Link
          href="/admin/seller-profiles/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          New Seller Profile
        </Link>
      </div>

      {sellers.length === 0 ? (
        <p className="text-sm text-gray-500">
          No seller profiles yet. Create one to enroll a customer as a seller.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Name / Display Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Commission</th>
                <th className="px-4 py-3 font-medium">Payout Method</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sellers.map((sp) => {
                const displayLabel = sp.displayName ?? sp.profile.name ?? '—'
                return (
                  <tr key={sp.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{displayLabel}</td>
                    <td className="px-4 py-3 text-gray-700">{sp.profile.email}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[sp.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {STATUS_LABELS[sp.status] ?? sp.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-gray-700">
                      {(sp.commissionRate * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {sp.payoutMethod ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {sp.createdAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/seller-profiles/${sp.id}`}
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
