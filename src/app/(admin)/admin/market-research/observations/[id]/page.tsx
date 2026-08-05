import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getObservationById } from '@/lib/externalMarketResearchQuery'
import { unmatchObservation, restoreObservation } from '@/lib/actions/externalMarketResearch'
import { MatchForm } from '@/components/admin/market-research/MatchForm'
import { RejectForm } from '@/components/admin/market-research/RejectForm'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Observation Detail | Admin' }

const STATUS_COLORS: Record<string, string> = {
  unmatched: 'bg-yellow-100 text-yellow-800',
  matched:   'bg-green-100 text-green-800',
  rejected:  'bg-red-100 text-red-800',
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-2 border-b border-gray-100 last:border-0">
      <dt className="text-xs font-medium text-gray-500 self-start pt-0.5">{label}</dt>
      <dd className="col-span-2 text-sm text-gray-900">{value ?? <span className="text-gray-300">—</span>}</dd>
    </div>
  )
}

export default async function ObservationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const obs = await getObservationById(id)
  if (!obs) notFound()

  const isMatched   = obs.matchStatus === 'matched'
  const isRejected  = obs.matchStatus === 'rejected'
  const isUnmatched = obs.matchStatus === 'unmatched'

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <Link href="/admin/market-research/observations" className="text-sm text-gray-500 hover:text-gray-900">
          ← Observations
        </Link>
        <div className="flex items-center gap-3 mt-2">
          <h1 className="text-xl font-bold text-gray-900 truncate">{obs.title}</h1>
          <span className={`shrink-0 inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[obs.matchStatus] ?? 'bg-gray-100 text-gray-600'}`}>
            {obs.matchStatus}
          </span>
        </div>
      </div>

      {/* Core fields */}
      <div className="rounded-md border border-gray-200 bg-white px-6 py-4 mb-6">
        <dl>
          <Field label="Provider"          value={obs.provider} />
          <Field label="External ID"       value={obs.externalId} />
          <Field label="Observation type"  value={obs.observationType} />
          <Field label="Currency"          value={obs.currency} />
          <Field label="Price"             value={obs.price} />
          <Field label="Shipping price"    value={obs.shippingPrice} />
          <Field label="Total price"       value={obs.totalPrice} />
          <Field label="Sold at"           value={obs.soldAt?.toLocaleString()} />
          <Field label="Listed at"         value={obs.listedAt?.toLocaleString()} />
          <Field label="Observed at"       value={obs.observedAt.toLocaleString()} />
          <Field label="Condition"         value={obs.condition} />
          <Field label="Location"          value={obs.locationText} />
          <Field label="Fingerprint"       value={<code className="text-xs break-all">{obs.fingerprint}</code>} />
          <Field label="Import batch"      value={obs.importBatchId
            ? <Link href={`/admin/market-research`} className="text-blue-700 hover:underline text-xs font-mono">{obs.importBatchId}</Link>
            : null} />
          <Field label="Created"           value={obs.createdAt.toLocaleString()} />
          <Field label="Updated"           value={obs.updatedAt.toLocaleString()} />
        </dl>
      </div>

      {/* Source URL — admin only */}
      {obs.sourceUrl && (
        <div className="mb-6 rounded-md border border-gray-200 bg-white px-6 py-4">
          <p className="text-xs font-medium text-gray-500 mb-1">Source URL (admin only — do not share)</p>
          <a
            href={obs.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-700 hover:underline break-all"
          >
            {obs.sourceUrl}
          </a>
        </div>
      )}

      {/* Raw snapshot — admin only */}
      {obs.rawSnapshot != null && (
        <details className="mb-6">
          <summary className="text-sm font-medium text-gray-600 cursor-pointer">Raw snapshot (admin only)</summary>
          <pre className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-4 text-xs overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(obs.rawSnapshot, null, 2)}
          </pre>
        </details>
      )}

      {/* Match status section */}
      <div className="rounded-md border border-gray-200 bg-white px-6 py-5 mb-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Catalog match</h2>

        {isMatched && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              Matched to: <span className="font-medium">{obs.catalogModelName ?? obs.catalogModelId}</span>
              {obs.matchMethod && <span className="ml-2 text-xs text-gray-400">via {obs.matchMethod}</span>}
            </p>
            <form action={unmatchObservation.bind(null, obs.id, obs.updatedAt.toISOString())}>
              <button type="submit" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                Unmatch
              </button>
            </form>
          </div>
        )}

        {isUnmatched && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500">This observation is unmatched. Search the catalog to link it to a model.</p>
            <MatchForm observationId={obs.id} updatedAt={obs.updatedAt.toISOString()} />
          </div>
        )}

        {isRejected && (
          <div className="space-y-3">
            <p className="text-sm text-red-700">
              Rejected: <span className="font-medium">{obs.rejectionReason}</span>
            </p>
            <form action={restoreObservation.bind(null, obs.id, obs.updatedAt.toISOString())}>
              <button type="submit" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                Restore (unmatched)
              </button>
            </form>
          </div>
        )}

        {!isRejected && (
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs text-gray-500 mb-2">Reject this observation</p>
            <RejectForm observationId={obs.id} updatedAt={obs.updatedAt.toISOString()} />
          </div>
        )}
      </div>

      {/* Audit trail */}
      {obs.audits.length > 0 && (
        <div className="rounded-md border border-gray-200 bg-white px-6 py-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Audit trail</h2>
          <div className="space-y-2">
            {obs.audits.map(a => (
              <div key={a.id} className="text-xs text-gray-600">
                <span className="font-medium">{a.action}</span>
                {a.adminInfo && <span className="ml-2 text-gray-400">— {a.adminInfo}</span>}
                <span className="ml-2 text-gray-300">{a.createdAt.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
