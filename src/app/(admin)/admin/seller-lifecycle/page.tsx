import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { sellerSafeCaseLabel } from '@/lib/sellerLifecycle'

export const dynamic = 'force-dynamic'

const CASE_STATUS_COLORS: Record<string, string> = {
  open: 'bg-yellow-100 text-yellow-700',
  action_required: 'bg-red-100 text-red-700',
  resolved: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
}

function submissionTitle(s: { brand: string | null; name: string | null }): string {
  return [s.brand, s.name].filter(Boolean).join(' ') || 'Untitled item'
}

export default async function SellerLifecyclePage() {
  const [openCases, recentEvents, openCaseCount, totalEvents] = await Promise.all([
    prisma.sellerLifecycleCase.findMany({
      where: { status: { in: ['open', 'action_required'] } },
      orderBy: { openedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        caseType: true,
        status: true,
        openedAt: true,
        sellerVisible: true,
        sellerSubmission: {
          select: {
            id: true,
            brand: true,
            name: true,
            profile: { select: { name: true, email: true } },
          },
        },
      },
    }),
    prisma.sellerLifecycleEvent.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 20,
      select: {
        id: true,
        eventType: true,
        sellerVisible: true,
        sellerTitle: true,
        adminDescription: true,
        occurredAt: true,
        sellerSubmissionId: true,
      },
    }),
    prisma.sellerLifecycleCase.count({ where: { status: { in: ['open', 'action_required'] } } }),
    prisma.sellerLifecycleEvent.count(),
  ])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Seller lifecycle</h1>
      <p className="text-sm text-gray-500 mb-6">
        Open cases needing attention and recent lifecycle activity across seller transactions.
      </p>

      {/* Stats */}
      <div className="flex gap-4 mb-8">
        <div className="rounded-md border border-gray-200 bg-white px-5 py-3">
          <p className="text-xs text-gray-500">Open cases</p>
          <p className="text-2xl font-semibold text-gray-900">{openCaseCount}</p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white px-5 py-3">
          <p className="text-xs text-gray-500">Total events</p>
          <p className="text-2xl font-semibold text-gray-900">{totalEvents}</p>
        </div>
      </div>

      {/* Attention breakdown by case type */}
      {openCases.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {Object.entries(
            openCases.reduce<Record<string, number>>((acc, c) => {
              acc[c.caseType] = (acc[c.caseType] ?? 0) + 1
              return acc
            }, {}),
          ).map(([type, count]) => (
            <span
              key={type}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700"
            >
              {type}
              <span className="text-gray-400">{count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Reconciliation reminders — complex joins surfaced as notes, not live queries */}
      <div className="mb-8 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 space-y-1">
        <p className="font-semibold">Manual reconciliation reminders</p>
        <p>
          Check for items marked returned (case has a returned date) that still have an active
          listing — the listing should be archived so it cannot sell.
        </p>
        <p>
          Check for orders that are no longer complete but still have unpaid seller payout lines —
          those lines are not revised automatically and may need to be held or voided.
        </p>
      </div>

      {/* Needs attention */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Needs attention</h2>
        {openCases.length === 0 ? (
          <p className="text-sm text-gray-500">No open cases.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-3 py-2 font-medium">Seller</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Case type</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Opened</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {openCases.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-700">
                      {c.sellerSubmission.profile.name ?? c.sellerSubmission.profile.email}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{submissionTitle(c.sellerSubmission)}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {c.sellerVisible ? sellerSafeCaseLabel(c.caseType) : c.caseType}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          CASE_STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-400">
                      {c.openedAt.toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <Link href={`/admin/seller-cases/${c.id}`} className="text-blue-600 hover:underline">
                        View case
                      </Link>
                      {' · '}
                      <Link
                        href={`/admin/seller-submissions/${c.sellerSubmission.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        Submission
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent events */}
      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Recent lifecycle events</h2>
        {recentEvents.length === 0 ? (
          <p className="text-sm text-gray-500">No events yet.</p>
        ) : (
          <div className="space-y-2">
            {recentEvents.map((e) => (
              <div
                key={e.id}
                className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm flex items-start justify-between gap-4"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">{e.sellerTitle ?? e.eventType}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {e.adminDescription ?? e.eventType}
                  </p>
                  <Link
                    href={`/admin/seller-submissions/${e.sellerSubmissionId}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    View submission
                  </Link>
                </div>
                <p className="text-xs text-gray-400 shrink-0">{e.occurredAt.toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
