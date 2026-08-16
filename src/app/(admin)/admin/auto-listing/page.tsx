import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { getEffectiveAutoListingPolicy, listAutoListingPolicyVersions } from '@/lib/autoListingPolicyQuery'
import { listRecentAutoListingRuns } from '@/lib/autoListingExecution'
import { listNeedsManualReview } from '@/lib/autoListingReview'
import { AutoListingPolicyForm } from '@/components/admin/AutoListingPolicyForm'
import { AutoListingRunPanel } from '@/components/admin/AutoListingRunPanel'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Auto-Listing | Admin' }

function pct(bps: number): string {
  const p = bps / 10000 * 100
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(2)}%`
}

const REASON_LABELS: Record<string, string> = {
  policy_disabled: 'Policy disabled', reactivation_requires_manual_review: 'Reactivation (manual only)',
  pricing_ask_only: 'Ask-only pricing', pricing_evidence_missing: 'No pricing evidence',
  pricing_confidence_below_policy: 'Confidence below policy minimum', pricing_range_invalid: 'Invalid pricing range',
  required_listing_field_missing: 'Missing required field', readiness_changed: 'Readiness changed before execution',
  risk_approval_required: 'Requires risk approval', risk_denied: 'Denied by risk policy',
  already_listed: 'Already listed', concurrent_state_change: 'State changed concurrently', execution_failed: 'Execution failed',
}

export default async function AutoListingPage() {
  if (!(await isAdminAuthenticated())) redirect('/admin/login')

  const [policy, versions, recentRuns, needsReview] = await Promise.all([
    getEffectiveAutoListingPolicy(),
    listAutoListingPolicyVersions(),
    listRecentAutoListingRuns(),
    listNeedsManualReview(),
  ])

  return (
    <div className="max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Auto-Listing</h1>
        <p className="text-sm text-gray-500 mt-1">
          Lists 15J-ready items automatically only when pricing is strong, 15F risk allows it, and current state is
          still safe at execution time. Everything else stays unlisted with an explicit reason. No scheduler — every
          listing here comes from an admin explicitly running a batch.
        </p>
      </div>

      <section>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Status</h2>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${policy?.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
            {policy?.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        {policy && (
          <p className="text-sm text-gray-600">
            Version {policy.version} · minimum confidence <strong>{policy.minimumPricingConfidence}</strong> · price position <strong>{pct(policy.pricePositionBps)}</strong> of range
          </p>
        )}
        <div className="mt-4">
          <AutoListingRunPanel enabled={!!policy?.enabled} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Recent Runs</h2>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-gray-400">No runs yet.</p>
        ) : (
          <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">Started</th>
                <th className="text-left px-3 py-2">Policy</th>
                <th className="text-left px-3 py-2">Requested by</th>
                <th className="text-left px-3 py-2">Listed</th>
                <th className="text-left px-3 py-2">Review</th>
                <th className="text-left px-3 py-2">Denied</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recentRuns.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-gray-600">{r.startedAt.toLocaleString()}</td>
                  <td className="px-3 py-2 text-gray-600">v{r.policyVersion}</td>
                  <td className="px-3 py-2 text-gray-600">{r.requestedBy}</td>
                  <td className="px-3 py-2 text-gray-900">{r.counts.listed ?? 0}</td>
                  <td className="px-3 py-2 text-gray-900">{r.counts.review_required ?? 0}</td>
                  <td className="px-3 py-2 text-gray-900">{r.counts.denied ?? 0}</td>
                  <td className="px-3 py-2 text-gray-500">
                    {!r.completedAt ? 'Running…' : r.sourceExhausted ? 'Complete' : 'More candidates remain'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Needs Manual Review</h2>
        {needsReview.items.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing needs manual review.</p>
        ) : (
          <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">Item</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-left px-3 py-2">Proposed price</th>
                <th className="text-left px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {needsReview.items.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2 font-mono text-xs">
                    {a.item ? <Link href={`/admin/items/${a.itemId}`} className="hover:underline">{a.item.sku}</Link> : a.itemId}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{REASON_LABELS[a.reasonCode] ?? a.reasonCode}</td>
                  <td className="px-3 py-2 text-gray-600">{a.proposedPriceCents != null ? `$${(a.proposedPriceCents / 100).toFixed(2)}` : '—'}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/items/${a.itemId}`} className="text-blue-600 hover:underline">View Item →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Publish a new policy version</h2>
        <p className="text-xs text-gray-500 mb-3">
          Takes effect at the date/time you choose (default: now). Every save creates a new version — existing
          versions are never edited, so a completed run always stays interpretable against the exact policy it used.
        </p>
        <AutoListingPolicyForm currentlyEnabled={policy?.enabled ?? false} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Version history</h2>
        <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="text-left px-3 py-2">Version</th>
              <th className="text-left px-3 py-2">Effective from</th>
              <th className="text-left px-3 py-2">Enabled</th>
              <th className="text-left px-3 py-2">Min confidence</th>
              <th className="text-left px-3 py-2">Price position</th>
              <th className="text-left px-3 py-2">Created by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {versions.map((v) => (
              <tr key={v.id} className={v.id === policy?.id ? 'bg-green-50' : undefined}>
                <td className="px-3 py-2 font-medium text-gray-900">{v.version}</td>
                <td className="px-3 py-2 text-gray-600">{v.effectiveFrom.toLocaleString()}</td>
                <td className="px-3 py-2 text-gray-600">{v.enabled ? 'Yes' : 'No'}</td>
                <td className="px-3 py-2 text-gray-600">{v.minimumPricingConfidence}</td>
                <td className="px-3 py-2 text-gray-600">{pct(v.pricePositionBps)}</td>
                <td className="px-3 py-2 text-gray-600">{v.createdBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
