'use client'

// 15E: single-exception resolution — reuses 12E-A CatalogModelCombobox (no fourth
// catalog matcher), the existing storage search endpoint, and the same condition
// vocabulary used elsewhere. On success/still-open, calls the SAME resolveIntakeException
// action that bulk actions use, which itself delegates to convertIntakeDraft().

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CatalogModelCombobox } from '@/components/admin/CatalogModelCombobox'
import type { CatalogMatchResult } from '@/lib/catalogMatching'
import { resolveIntakeException } from '@/lib/actions/intakeExceptions'
import { EXCEPTION_CATEGORY, EXCEPTION_LABELS, type IntakeExceptionCode } from '@/lib/intakeExceptions'

const CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged']

export function IntakeExceptionResolveForm(props: {
  draftId: string
  code: string
  note: string | null
  catalogModelId: string | null
  catalogLabel: string | null
  storageLocationId: string | null
  storageLabel: string | null
  condition: string | null
  cardedOrLoose: string | null
}) {
  const router = useRouter()
  const [catalog, setCatalog] = useState<{ id: string; label: string } | null>(
    props.catalogModelId ? { id: props.catalogModelId, label: props.catalogLabel ?? '' } : null,
  )
  const [storageQuery, setStorageQuery] = useState(props.storageLabel ?? '')
  const [storageResolved, setStorageResolved] = useState<{ id: string; label: string } | null>(
    props.storageLocationId ? { id: props.storageLocationId, label: props.storageLabel ?? '' } : null,
  )
  const [storageMatches, setStorageMatches] = useState<{ id: string; label: string }[]>([])
  const [condition, setCondition] = useState(props.condition ?? '')
  const [cardedOrLoose, setCardedOrLoose] = useState(props.cardedOrLoose ?? '')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<
    | { kind: 'converted'; itemId: string; sku: string }
    | { kind: 'still_open'; code: string; note: string }
    | { kind: 'error'; message: string }
    | null
  >(null)

  const category = EXCEPTION_CATEGORY[props.code as IntakeExceptionCode]

  function searchStorage(q: string) {
    setStorageQuery(q)
    setStorageResolved(null)
    if (!q.trim()) { setStorageMatches([]); return }
    fetch(`/api/admin/storage-locations/search?q=${encodeURIComponent(q.trim())}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { id: string; label: string }[]) => {
        setStorageMatches(rows)
        const exact = rows.find((r) => r.label.toLowerCase() === q.trim().toLowerCase())
        if (exact) setStorageResolved(exact)
      })
      .catch(() => setStorageMatches([]))
  }

  async function handleRetry() {
    if (busy) return
    setBusy(true)
    const result = await resolveIntakeException({
      draftId: props.draftId,
      catalogModelId: catalog?.id ?? null,
      storageLocationId: storageResolved?.id ?? null,
      condition: condition || null,
      cardedOrLoose: cardedOrLoose || null,
    })
    setBusy(false)
    if (result.ok) {
      setOutcome({ kind: 'converted', itemId: result.itemId, sku: result.sku })
      router.refresh()
    } else if (result.stillOpen) {
      setOutcome({ kind: 'still_open', code: result.code, note: result.note })
    } else {
      setOutcome({ kind: 'error', message: result.error })
    }
  }

  if (outcome?.kind === 'converted') {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm">
        <p className="font-medium text-green-800">Resolved</p>
        <p className="mt-1 text-green-700">Created: {outcome.sku}</p>
        <Link href={`/admin/items/${outcome.itemId}`} className="mt-2 inline-block text-blue-600 hover:underline">View Item →</Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {outcome?.kind === 'still_open' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Still needs attention: {EXCEPTION_LABELS[outcome.code as IntakeExceptionCode] ?? outcome.code} — {outcome.note}
        </div>
      )}
      {outcome?.kind === 'error' && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{outcome.message}</div>
      )}

      {category === 'commercial_blocker' ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Physical item exceeds the quantity covered by the current intake/shipment context.</p>
          <p className="mt-1">Resolve the shipment/agreement discrepancy through its own workflow before retrying conversion here. 15E cannot amend the recorded received quantity, signed agreement quantity, or commission terms.</p>
          <button type="button" onClick={() => void handleRetry()} disabled={busy}
            className="mt-3 rounded-md border border-amber-400 px-3 py-1.5 text-xs font-medium disabled:opacity-40">
            {busy ? 'Retrying…' : 'Retry eligibility'}
          </button>
        </div>
      ) : (
        <>
          {(props.code === 'unknown_model' || category === 'data_fixable') && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Catalog model</label>
              {catalog ? (
                <div className="flex items-center justify-between rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm">
                  <span>{catalog.label}</span>
                  <button type="button" onClick={() => setCatalog(null)} className="text-xs text-gray-400 hover:text-gray-700">Change</button>
                </div>
              ) : (
                <CatalogModelCombobox
                  name="catalogModelId"
                  onSelect={(m: CatalogMatchResult | null) => setCatalog(m ? { id: m.id, label: `${m.brand} ${m.name}` } : null)}
                />
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Storage</label>
            <input type="text" value={storageQuery} onChange={(e) => searchStorage(e.target.value)}
              placeholder="Scan or search storage location…" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
            {storageResolved ? (
              <p className="mt-1 text-xs text-green-700">Resolved: {storageResolved.label}</p>
            ) : storageMatches.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-1">
                {storageMatches.slice(0, 8).map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => { setStorageResolved(m); setStorageQuery(m.label); setStorageMatches([]) }}
                      className="rounded-md border border-gray-200 px-2 py-0.5 text-xs hover:bg-gray-50">{m.label}</button>
                  </li>
                ))}
              </ul>
            ) : storageQuery.trim() ? (
              <p className="mt-1 text-xs text-red-600">No matching storage location.</p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Condition</label>
              <select value={condition} onChange={(e) => setCondition(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Carded / Loose</label>
              <select value={cardedOrLoose} onChange={(e) => setCardedOrLoose(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                <option value="carded">Carded</option>
                <option value="loose">Loose</option>
              </select>
            </div>
          </div>

          <button type="button" onClick={() => void handleRetry()} disabled={busy}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {busy ? 'Resolving…' : 'Resolve & Convert'}
          </button>
        </>
      )}
    </div>
  )
}
