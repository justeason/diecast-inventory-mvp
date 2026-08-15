import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { listRiskPolicyVersions } from '@/lib/riskPolicyQuery'
import { RiskPolicyForm } from '@/components/admin/RiskPolicyForm'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Risk Policies | Admin' }

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
function pct(bps: number): string {
  const p = bps / 100
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(2)}%`
}

export default async function RiskPoliciesPage() {
  if (!(await isAdminAuthenticated())) redirect('/admin/login')

  const versions = await listRiskPolicyVersions()
  const now = new Date()
  const effective = versions.find((v) => v.effectiveFrom <= now) ?? null

  return (
    <div className="max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Risk Policies</h1>
        <p className="text-sm text-gray-500 mt-1">
          Structured, versioned, effective-dated thresholds that drive the risk gate (src/lib/riskPolicy.ts).
          Every save creates a new version — existing versions are never edited, so past approval requests
          always stay interpretable against the exact snapshot they were evaluated under.
        </p>
      </div>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Effective policy</h2>
        {!effective ? (
          <p className="text-sm text-amber-700 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
            No effective policy version found — this should not happen; the initial migration seeds version 1.
          </p>
        ) : (
          <div className="rounded-md border border-gray-200 bg-white p-5 text-sm">
            <div className="flex items-center gap-3 mb-3">
              <span className="font-semibold text-gray-900">Version {effective.version}</span>
              <span className="text-xs text-gray-400">effective {effective.effectiveFrom.toLocaleString()}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
              <dt className="text-gray-500">High-value review threshold</dt>
              <dd className="text-gray-900">{usd(effective.highValueReviewThresholdCents)}</dd>
              <dt className="text-gray-500">Very-high-value threshold</dt>
              <dd className="text-gray-900">{usd(effective.veryHighValueThresholdCents)}</dd>
              <dt className="text-gray-500">Payout approval threshold</dt>
              <dd className="text-gray-900">{usd(effective.payoutApprovalThresholdCents)}</dd>
              <dt className="text-gray-500">Price deviation tolerance</dt>
              <dd className="text-gray-900">{pct(effective.priceDeviationToleranceBps)}</dd>
              <dt className="text-gray-500">Destructive actions require approval</dt>
              <dd className="text-gray-900">{effective.destructiveActionsRequireApproval ? 'Yes' : 'No'}</dd>
              <dt className="text-gray-500">Commercial overrides require approval</dt>
              <dd className="text-gray-900">{effective.commercialOverridesRequireApproval ? 'Yes' : 'No'}</dd>
            </dl>
            {effective.notes && <p className="mt-3 text-xs text-gray-500">{effective.notes}</p>}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Publish a new version</h2>
        <p className="text-xs text-gray-500 mb-3">
          Takes effect at the date/time you choose (default: now). Cannot be dated at or before the currently
          active version&apos;s effective date — this is what keeps &quot;the&quot; active version unambiguous.
        </p>
        <RiskPolicyForm />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Version history</h2>
        <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="text-left px-3 py-2">Version</th>
              <th className="text-left px-3 py-2">Effective from</th>
              <th className="text-left px-3 py-2">High-value</th>
              <th className="text-left px-3 py-2">Very-high-value</th>
              <th className="text-left px-3 py-2">Payout threshold</th>
              <th className="text-left px-3 py-2">Price tolerance</th>
              <th className="text-left px-3 py-2">Created by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {versions.map((v) => (
              <tr key={v.id} className={v.id === effective?.id ? 'bg-green-50' : undefined}>
                <td className="px-3 py-2 font-medium text-gray-900">{v.version}</td>
                <td className="px-3 py-2 text-gray-600">{v.effectiveFrom.toLocaleString()}</td>
                <td className="px-3 py-2 text-gray-600">{usd(v.highValueReviewThresholdCents)}</td>
                <td className="px-3 py-2 text-gray-600">{usd(v.veryHighValueThresholdCents)}</td>
                <td className="px-3 py-2 text-gray-600">{usd(v.payoutApprovalThresholdCents)}</td>
                <td className="px-3 py-2 text-gray-600">{pct(v.priceDeviationToleranceBps)}</td>
                <td className="px-3 py-2 text-gray-600">{v.createdBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
