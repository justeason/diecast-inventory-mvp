import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import {
  getAlertStatusCounts, getFanoutStatusCounts,
  getOldestPendingAgeMs, getOldestPendingFanoutAgeMs, getRecentFailures,
} from '@/lib/buyerAlertsAdminQuery'
import { retryBuyerAlertEventAction, runBuyerAlertProcessorAction } from '@/lib/actions/adminBuyerAlerts'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Buyer Alerts | Admin' }

function fmtAge(ms: number): string {
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

export default async function AdminBuyerAlertsPage() {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  const [counts, fanoutCounts, oldestPendingMs, oldestPendingFanoutMs, failures] = await Promise.all([
    getAlertStatusCounts(),
    getFanoutStatusCounts(),
    getOldestPendingAgeMs(),
    getOldestPendingFanoutAgeMs(),
    getRecentFailures(),
  ])

  const STATUS_COLORS: Record<string, string> = {
    pending:          'text-amber-700  bg-amber-50  border-amber-200',
    processing:       'text-blue-700   bg-blue-50   border-blue-200',
    sending:          'text-blue-700   bg-blue-50   border-blue-200',
    sent:             'text-green-700  bg-green-50  border-green-200',
    complete:         'text-green-700  bg-green-50  border-green-200',
    failed:           'text-red-700    bg-red-50    border-red-200',
    suppressed:       'text-gray-500   bg-gray-50   border-gray-200',
    delivery_unknown: 'text-orange-700 bg-orange-50 border-orange-200',
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Buyer Alerts</h1>
          <p className="text-sm text-gray-500 mt-1">
            Wanted-model availability &amp; price-change alert delivery. No buyer email/name shown.
          </p>
        </div>
        <form action={runBuyerAlertProcessorAction}>
          <button
            type="submit"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
          >
            Process next batch
          </button>
        </form>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Fan-out jobs</h2>
        <p className="text-xs text-gray-500">
          One job per listing availability/price transition. A job is only durable proof
          that buyers still need to be notified — it does not itself send email.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Object.entries(fanoutCounts).map(([status, count]) => (
            <div key={status} className={`rounded-md border px-3 py-2.5 text-sm ${STATUS_COLORS[status] ?? ''}`}>
              <div className="capitalize font-medium">{status}</div>
              <div className="text-lg font-bold">{count}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500">
          Oldest pending job: {oldestPendingFanoutMs !== null ? fmtAge(oldestPendingFanoutMs) : 'none pending'}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Alert delivery</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {Object.entries(counts).map(([status, count]) => (
            <div key={status} className={`rounded-md border px-3 py-2.5 text-sm ${STATUS_COLORS[status] ?? ''}`}>
              <div className="font-medium">{status.replace('_', ' ')}</div>
              <div className="text-lg font-bold">{count}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500">
          Oldest pending: {oldestPendingMs !== null ? fmtAge(oldestPendingMs) : 'none pending'}.{' '}
          <span className="text-orange-700">delivery_unknown</span> means a local timeout or network
          error occurred after the request may have already reached the email provider — the outcome
          is genuinely ambiguous, not a confirmed failure. These rows are <strong>not</strong>
          retryable here (no verified provider idempotency-window duration to retry safely within) —
          they require manual review directly with the email provider.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Recent failures &amp; ambiguous deliveries</h2>
        {failures.length === 0 ? (
          <p className="text-sm text-gray-400">None.</p>
        ) : (
          <div className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100 text-sm">
            {failures.map(f => {
              const isAmbiguous = f.status === 'delivery_unknown'
              return (
                <div key={f.id} className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-gray-400 truncate">{f.id}</div>
                    <div className="text-gray-900">
                      {f.catalogModel.brand} {f.catalogModel.name}{f.catalogModel.year ? ` (${f.catalogModel.year})` : ''}
                    </div>
                    <div className="text-xs text-gray-500">
                      {f.alertType} · {f.createdAt.toLocaleString('en-US')} · {' '}
                      <span className={isAmbiguous ? 'text-orange-700 font-medium' : ''}>
                        {isAmbiguous ? 'ambiguous — manual review only' : 'failed'}
                      </span>
                      {' '}· {f.failureCode ?? 'unknown'}
                    </div>
                  </div>
                  {isAmbiguous ? (
                    <span className="text-xs text-gray-400 shrink-0">No retry — see note above</span>
                  ) : (
                    <form action={retryBuyerAlertEventAction.bind(null, f.id)}>
                      <button type="submit" className="text-xs font-medium text-gray-700 hover:text-gray-900 underline underline-offset-2 shrink-0">
                        Retry
                      </button>
                    </form>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
