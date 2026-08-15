import Link from 'next/link'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { searchApprovalQueue, getApprovalQueueSummary, type ApprovalQueueFilter } from '@/lib/riskPolicyQuery'
import { RISK_ACTIONS, type RiskAction } from '@/lib/riskPolicy'

export const dynamic = 'force-dynamic'

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired', 'consumed']
const RISK_LEVELS = ['medium', 'high']

type SearchParams = { action?: string; riskLevel?: string; status?: string; targetType?: string; cursor?: string }

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

function ageOf(d: Date, now: Date): string {
  const ms = now.getTime() - d.getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return '<1h'
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const RISK_COLORS: Record<string, string> = { medium: 'bg-amber-100 text-amber-700', high: 'bg-red-100 text-red-700' }
const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700', approved: 'bg-green-100 text-green-700', rejected: 'bg-gray-200 text-gray-700',
  cancelled: 'bg-gray-100 text-gray-500', expired: 'bg-gray-100 text-gray-500', consumed: 'bg-blue-100 text-blue-700',
}

export default async function ApprovalsQueuePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!(await isAdminAuthenticated())) redirect('/admin/login')
  const sp = await searchParams

  const filter: ApprovalQueueFilter = {
    action: sp.action && (RISK_ACTIONS as readonly string[]).includes(sp.action) ? (sp.action as RiskAction) : null,
    riskLevel: sp.riskLevel === 'medium' || sp.riskLevel === 'high' ? sp.riskLevel : null,
    status: sp.status && STATUSES.includes(sp.status) ? sp.status : 'pending',
    targetType: sp.targetType || null,
  }

  const [summary, page] = await Promise.all([
    getApprovalQueueSummary(),
    searchApprovalQueue(filter, sp.cursor ?? null),
  ])

  const now = new Date()
  const baseParams = { action: sp.action, riskLevel: sp.riskLevel, status: sp.status, targetType: sp.targetType }

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold text-gray-900 mb-1">Approvals</h1>
      <p className="text-sm text-gray-500 mb-4">
        Risky actions the policy engine routed here instead of executing directly. Approving a request does not
        perform the action — the original workflow must be resumed to actually consume it.
      </p>

      <div className="flex gap-4 mb-4 text-sm">
        <span className="rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-amber-800">
          {summary.pending} pending ({summary.byRiskLevel.high} high, {summary.byRiskLevel.medium} medium)
        </span>
      </div>

      <form method="get" className="flex flex-wrap gap-3 mb-4 text-sm">
        <select name="status" defaultValue={filter.status ?? ''} className="rounded-md border border-gray-300 px-2 py-1.5">
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="riskLevel" defaultValue={filter.riskLevel ?? ''} className="rounded-md border border-gray-300 px-2 py-1.5">
          <option value="">All risk levels</option>
          {RISK_LEVELS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select name="action" defaultValue={filter.action ?? ''} className="rounded-md border border-gray-300 px-2 py-1.5">
          <option value="">All actions</option>
          {RISK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <button type="submit" className="rounded-md bg-gray-900 px-3 py-1.5 text-white">Filter</button>
      </form>

      <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="text-left px-3 py-2">Action</th>
            <th className="text-left px-3 py-2">Risk</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-left px-3 py-2">Target</th>
            <th className="text-left px-3 py-2">Reason</th>
            <th className="text-left px-3 py-2">Requested</th>
            <th className="text-left px-3 py-2">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {page.items.length === 0 && (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No approval requests match these filters.</td></tr>
          )}
          {page.items.map((r) => (
            <tr key={r.id} className="hover:bg-gray-50">
              <td className="px-3 py-2">
                <Link href={`/admin/approvals/${r.id}`} className="text-blue-600 hover:underline font-medium">{r.action}</Link>
              </td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs ${RISK_COLORS[r.riskLevel] ?? 'bg-gray-100 text-gray-600'}`}>{r.riskLevel}</span>
              </td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_COLORS[r.status] ?? 'bg-gray-100 text-gray-600'}`}>{r.status}</span>
              </td>
              <td className="px-3 py-2 text-gray-600">{r.targetType} · {r.targetId}</td>
              <td className="px-3 py-2 text-gray-600 max-w-xs truncate">{r.reasons[0] ?? ''}</td>
              <td className="px-3 py-2 text-gray-600">{r.requestedBy}</td>
              <td className="px-3 py-2 text-gray-600">{ageOf(r.requestedAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex justify-end">
        {page.nextCursor && (
          <Link href={qs({ ...baseParams, cursor: page.nextCursor })} className="text-sm text-blue-600 hover:underline">Next →</Link>
        )}
      </div>
    </div>
  )
}
