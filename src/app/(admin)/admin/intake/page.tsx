import Link from 'next/link'
import { prisma } from '@/lib/prisma'

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  converted: 'Converted',
  rejected: 'Rejected',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700',
  reviewed: 'bg-blue-100 text-blue-700',
  converted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

export default async function AdminIntakePage() {
  const drafts = await prisma.intakeDraft.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      brand: true,
      name: true,
      year: true,
      color: true,
      condition: true,
      cardedOrLoose: true,
      createdAt: true,
    },
  })

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Intake Drafts</h1>
        <Link
          href="/admin/intake/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
        >
          New Draft
        </Link>
      </div>

      {drafts.length === 0 ? (
        <p className="text-gray-500 text-sm">No intake drafts yet.</p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Model</th>
                <th className="px-4 py-3 font-medium">Condition</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {drafts.map((d) => {
                const modelStr = [d.brand, d.name, d.year?.toString(), d.color]
                  .filter(Boolean)
                  .join(' · ') || '(no model info)'
                return (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{modelStr}</td>
                    <td className="px-4 py-3 text-gray-500 capitalize">{d.condition ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500 capitalize">{d.cardedOrLoose ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[d.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {STATUS_LABELS[d.status] ?? d.status}
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
    </>
  )
}
