import Link from 'next/link'
import { searchExceptionQueue, getExceptionQueueSummary } from '@/lib/intakeExceptionQueueQuery'
import { EXCEPTION_LABELS, INTAKE_EXCEPTION_CODES, EXCEPTION_CATEGORY_LABELS, formatExceptionAge, type IntakeExceptionCode, type ExceptionCategory, type ExceptionAgeGroup } from '@/lib/intakeExceptions'
import { IntakeExceptionQueueTable } from '@/components/admin/IntakeExceptionQueueTable'

export const dynamic = 'force-dynamic'

const AGE_GROUPS: ExceptionAgeGroup[] = ['<1h', '1-24h', '1-3d', '>3d']
const AGE_GROUP_LABELS: Record<ExceptionAgeGroup, string> = { '<1h': '<1 hour', '1-24h': '1–24 hours', '1-3d': '1–3 days', '>3d': '>3 days' }

type SearchParams = {
  code?: string
  category?: string
  portfolioId?: string
  shipmentId?: string
  q?: string
  age?: string
  cursor?: string
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export default async function IntakeExceptionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const filter = {
    code: sp.code && (INTAKE_EXCEPTION_CODES as readonly string[]).includes(sp.code) ? (sp.code as IntakeExceptionCode) : null,
    category: sp.category as ExceptionCategory | undefined ?? null,
    portfolioId: sp.portfolioId ?? null,
    shipmentId: sp.shipmentId ?? null,
    ageGroup: sp.age && (AGE_GROUPS as readonly string[]).includes(sp.age) ? (sp.age as ExceptionAgeGroup) : null,
    q: sp.q ?? '',
  }

  const [summary, page] = await Promise.all([
    getExceptionQueueSummary({ portfolioId: filter.portfolioId, shipmentId: filter.shipmentId }),
    searchExceptionQueue(filter, sp.cursor ?? null),
  ])

  const now = new Date()
  const rows = page.items.map((r) => ({
    id: r.id, code: r.code, note: r.note, age: formatExceptionAge(r.createdAt, now),
    catalogLabel: r.catalogLabel, draftLabel: r.draftLabel, storageLabel: r.storageLabel,
    condition: r.condition, sellerLabel: r.sellerLabel, portfolioName: r.portfolioName,
    shipmentTrackingNumber: r.shipmentTrackingNumber, source: r.source,
  }))

  const baseParams = { code: sp.code, category: sp.category, portfolioId: sp.portfolioId, shipmentId: sp.shipmentId, q: sp.q, age: sp.age }

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold text-gray-900 mb-1">Intake Exceptions</h1>
      <p className="text-sm text-gray-500 mb-4">
        Physical items that could not be auto-converted by the bulk intake workbench. Normal items never appear here.
      </p>

      {/* Summary (section 5/30) — DB-side counts only. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
        {[
          ['Open exceptions', summary.open],
          ...INTAKE_EXCEPTION_CODES.map((c) => [EXCEPTION_LABELS[c], summary.byCode[c]] as const),
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-md border border-gray-200 bg-white p-3">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-lg font-semibold text-gray-900 tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      {summary.oldestCreatedAt && (
        <p className="mb-4 text-xs text-gray-500">Oldest open exception: {formatExceptionAge(summary.oldestCreatedAt, now)}</p>
      )}

      {/* Filters — plain GET links/form, no client JS needed for filtering itself. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Link href={`/admin/intake/exceptions${qs({ ...baseParams, code: undefined, category: undefined })}`}
          className={`rounded-md border px-2 py-1 ${!filter.code && !filter.category ? 'bg-gray-900 text-white' : 'border-gray-300'}`}>
          All
        </Link>
        {(['data_fixable', 'retryable', 'commercial_blocker'] as ExceptionCategory[]).map((cat) => (
          <Link key={cat} href={`/admin/intake/exceptions${qs({ ...baseParams, code: undefined, category: cat })}`}
            className={`rounded-md border px-2 py-1 ${filter.category === cat ? 'bg-gray-900 text-white' : 'border-gray-300'}`}>
            {EXCEPTION_CATEGORY_LABELS[cat]}
          </Link>
        ))}
        {INTAKE_EXCEPTION_CODES.map((c) => (
          <Link key={c} href={`/admin/intake/exceptions${qs({ ...baseParams, category: undefined, code: c })}`}
            className={`rounded-md border px-2 py-1 ${filter.code === c ? 'bg-gray-900 text-white' : 'border-gray-300'}`}>
            {EXCEPTION_LABELS[c]}
          </Link>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-400">Age:</span>
        <Link href={`/admin/intake/exceptions${qs({ ...baseParams, age: undefined })}`}
          className={`rounded-md border px-2 py-1 ${!filter.ageGroup ? 'bg-gray-900 text-white' : 'border-gray-300'}`}>
          Any
        </Link>
        {AGE_GROUPS.map((g) => (
          <Link key={g} href={`/admin/intake/exceptions${qs({ ...baseParams, age: g })}`}
            className={`rounded-md border px-2 py-1 ${filter.ageGroup === g ? 'bg-gray-900 text-white' : 'border-gray-300'}`}>
            {AGE_GROUP_LABELS[g]}
          </Link>
        ))}
      </div>

      <form method="get" className="mb-4 flex gap-2">
        {filter.portfolioId && <input type="hidden" name="portfolioId" value={filter.portfolioId} />}
        {filter.shipmentId && <input type="hidden" name="shipmentId" value={filter.shipmentId} />}
        <input type="text" name="q" defaultValue={filter.q} placeholder="Search draft id, shipment, portfolio, seller, model…"
          className="w-96 rounded-md border border-gray-300 px-3 py-1.5 text-sm" />
        <button type="submit" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm">Search</button>
      </form>

      {(filter.portfolioId || filter.shipmentId) && (
        <p className="mb-4 text-xs text-gray-500">
          Filtered to {filter.portfolioId ? `portfolio ${filter.portfolioId}` : ''}{filter.shipmentId ? `shipment ${filter.shipmentId}` : ''}.{' '}
          <Link href="/admin/intake/exceptions" className="text-blue-600 hover:underline">Clear</Link>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No open exceptions match this filter.</p>
      ) : (
        <>
          <IntakeExceptionQueueTable rows={rows} />
          {page.nextCursor && (
            <div className="mt-4">
              <Link href={`/admin/intake/exceptions${qs({ ...baseParams, cursor: page.nextCursor })}`} className="text-sm text-blue-600 hover:underline">
                Next page →
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  )
}
