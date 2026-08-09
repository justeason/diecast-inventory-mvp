import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { listCommissionPolicies, getCommissionPolicyDetail } from '@/lib/commissionPolicyQuery'
import { CreateCommissionPolicyForm, EndDatePolicyForm } from '@/components/admin/CommissionPolicyForm'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Commission Policies | Admin' }

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
function pct(bps: number): string {
  const p = bps / 100
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(2)}%`
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700',
  active: 'bg-green-100 text-green-700',
  ended: 'bg-gray-100 text-gray-500',
}

export default async function CommissionPoliciesPage() {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const policies = await listCommissionPolicies()
  const activePolicy = policies.find(p => p.status === 'active')
  const activeDetail = activePolicy ? await getCommissionPolicyDetail(activePolicy.id) : null

  return (
    <div className="max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Commission Policies</h1>
        <p className="text-sm text-gray-500 mt-1">
          Consignment agreements automatically resolve commission from the active policy. Admins
          only need to intervene for exceptions.
        </p>
      </div>

      {/* Active policy summary — section 13 example layout */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Active policy</h2>
        {!activeDetail ? (
          <p className="text-sm text-amber-700 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
            No active commission policy configured. New consignment agreements will require a manual override.
          </p>
        ) : (
          <div className="rounded-md border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-3 mb-3">
              <h3 className="text-lg font-semibold text-gray-900">{activeDetail.name}</h3>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[activeDetail.status]}`}>
                {activeDetail.status}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-4 text-sm mb-4">
              <div>
                <dt className="text-gray-500 text-xs">Default commission</dt>
                <dd className="text-gray-900 font-medium">{pct(activeDetail.defaultCommissionBps)}</dd>
              </div>
              <div>
                <dt className="text-gray-500 text-xs">Minimum per sold item</dt>
                <dd className="text-gray-900 font-medium">{usd(activeDetail.minimumFeeCents)}</dd>
              </div>
              <div>
                <dt className="text-gray-500 text-xs">Effective from</dt>
                <dd className="text-gray-900">{activeDetail.effectiveFrom.toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-gray-500 text-xs">Effective to</dt>
                <dd className="text-gray-900">{activeDetail.effectiveTo ? activeDetail.effectiveTo.toLocaleDateString() : 'Open-ended'}</dd>
              </div>
            </dl>
            {activeDetail.tiers.length > 0 && (
              <div className="mb-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Volume tiers</p>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {activeDetail.tiers.map((t, i) => {
                      const next = activeDetail.tiers[i + 1]
                      const range = next ? `${t.minItems}–${next.minItems - 1}` : `${t.minItems}+`
                      return (
                        <tr key={t.id}>
                          <td className="py-1 text-gray-700">{range} items</td>
                          <td className="py-1 text-gray-900 font-medium">{pct(t.commissionBps)}</td>
                          <td className="py-1 text-gray-500">
                            {t.minimumFeeCents !== null ? `min ${usd(t.minimumFeeCents)}` : 'default min. fee'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <EndDatePolicyForm policyId={activeDetail.id} />
          </div>
        )}
      </section>

      {/* All policies (history/versions) */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">All policy versions</h2>
        {policies.length === 0 ? (
          <p className="text-sm text-gray-500">No policies configured yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Default</th>
                  <th className="px-4 py-2 font-medium">Min. fee</th>
                  <th className="px-4 py-2 font-medium">Tiers</th>
                  <th className="px-4 py-2 font-medium">Effective</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {policies.map(p => (
                  <tr key={p.id}>
                    <td className="px-4 py-2 text-gray-900">{p.name}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[p.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{pct(p.defaultCommissionBps)}</td>
                    <td className="px-4 py-2 tabular-nums">{usd(p.minimumFeeCents)}</td>
                    <td className="px-4 py-2 tabular-nums">{p.tierCount}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">
                      {p.effectiveFrom.toLocaleDateString()}
                      {p.effectiveTo ? ` – ${p.effectiveTo.toLocaleDateString()}` : ' – open'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Create new (future) policy version */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Create policy version</h2>
        <p className="text-xs text-gray-500 mb-3">
          Policy changes are prospective only — creating a new version never alters commission terms
          already snapshotted on signed agreements.
        </p>
        <CreateCommissionPolicyForm />
      </section>

      <p className="text-xs text-gray-400">
        Seller-specific overrides are managed from each seller&apos;s profile page.
      </p>
    </div>
  )
}
