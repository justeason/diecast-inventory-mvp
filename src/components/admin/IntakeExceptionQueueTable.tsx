'use client'

// 15E: bulk-select table for the intake exception queue. Bulk corrections apply the
// SAME correction to every selected row via resolveIntakeException (through
// bulkResolveIntakeExceptions) — no batch logic is duplicated; each row still goes
// through the one shared convertIntakeDraft() primitive independently.

import { useState } from 'react'
import Link from 'next/link'
import {
  bulkResolveIntakeExceptions,
  type BulkResolveRowResult,
} from '@/lib/actions/intakeExceptions'
import { EXCEPTION_LABELS, type IntakeExceptionCode } from '@/lib/intakeExceptions'

export type QueueRowProps = {
  id: string
  code: string
  note: string | null
  age: string
  catalogLabel: string | null
  draftLabel: string
  storageLabel: string | null
  condition: string | null
  sellerLabel: string | null
  portfolioName: string | null
  shipmentTrackingNumber: string | null
  source: 'workbench' | 'manual'
}

const CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged']

function ExceptionBadge({ code }: { code: string }) {
  return (
    <span className="inline-block rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
      {EXCEPTION_LABELS[code as IntakeExceptionCode] ?? code}
    </span>
  )
}

export function IntakeExceptionQueueTable({ rows }: { rows: QueueRowProps[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [storageQuery, setStorageQuery] = useState('')
  const [storageMatches, setStorageMatches] = useState<{ id: string; label: string }[]>([])
  const [storageResolved, setStorageResolved] = useState<{ id: string; label: string } | null>(null)
  const [condition, setCondition] = useState('')
  const [cardedOrLoose, setCardedOrLoose] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastResults, setLastResults] = useState<BulkResolveRowResult[] | null>(null)
  const [confirming, setConfirming] = useState<'storage' | 'condition' | 'retry' | null>(null)

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  async function runBulk(corrections: { storageLocationId?: string; condition?: string; cardedOrLoose?: string }) {
    if (selected.size === 0 || busy) return
    setBusy(true)
    setConfirming(null)
    const result = await bulkResolveIntakeExceptions({ draftIds: [...selected], ...corrections })
    setBusy(false)
    if (result.ok) {
      setLastResults(result.results)
      setSelected(new Set())
    }
  }

  return (
    <div>
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 mb-3 rounded-md border border-gray-300 bg-white p-3 shadow-sm text-sm space-y-2">
          <p className="font-medium text-gray-900">{selected.size} selected</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text" value={storageQuery} onChange={(e) => searchStorage(e.target.value)}
              placeholder="Scan/search storage…" className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            />
            {storageMatches.length > 0 && !storageResolved && (
              <div className="flex gap-1">
                {storageMatches.slice(0, 5).map((m) => (
                  <button key={m.id} type="button" onClick={() => { setStorageResolved(m); setStorageQuery(m.label); setStorageMatches([]) }}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-xs hover:bg-gray-50">
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            <button type="button" disabled={!storageResolved || busy} onClick={() => setConfirming('storage')}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium disabled:opacity-40">
              Set storage
            </button>

            <select value={condition} onChange={(e) => setCondition(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-xs">
              <option value="">Condition…</option>
              {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={cardedOrLoose} onChange={(e) => setCardedOrLoose(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-xs">
              <option value="">Carded/Loose…</option>
              <option value="carded">Carded</option>
              <option value="loose">Loose</option>
            </select>
            <button type="button" disabled={!condition || !cardedOrLoose || busy} onClick={() => setConfirming('condition')}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium disabled:opacity-40">
              Set condition
            </button>

            <button type="button" disabled={busy} onClick={() => setConfirming('retry')}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium disabled:opacity-40">
              Retry selected
            </button>
          </div>

          {confirming && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <p className="mb-1">
                {confirming === 'storage' && <>Set storage <strong>{storageResolved?.label}</strong> for {selected.size} item(s) and retry conversion.</>}
                {confirming === 'condition' && <>Set condition <strong>{condition}/{cardedOrLoose}</strong> for {selected.size} item(s) and retry conversion.</>}
                {confirming === 'retry' && <>Retry conversion for {selected.size} item(s) with their current fields.</>}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (confirming === 'storage') void runBulk({ storageLocationId: storageResolved!.id })
                    else if (confirming === 'condition') void runBulk({ condition, cardedOrLoose })
                    else void runBulk({})
                  }}
                  className="rounded-md bg-amber-700 px-2 py-1 font-medium text-white"
                >
                  Confirm
                </button>
                <button type="button" onClick={() => setConfirming(null)} className="text-amber-700 underline">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {lastResults && (
        <div className="mb-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
          <p className="font-medium text-gray-900">
            {lastResults.filter((r) => r.outcome === 'converted' || r.outcome === 'already_resolved').length} converted ·{' '}
            {lastResults.filter((r) => r.outcome !== 'converted' && r.outcome !== 'already_resolved').length} still need attention
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
            {lastResults.filter((r) => r.outcome === 'still_open' || r.outcome === 'error').map((r) => (
              <li key={r.draftId}>{r.draftId}: {r.outcome === 'still_open' ? r.note : r.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-left text-gray-500">
            <tr>
              <th className="px-2 py-2"><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
              <th className="px-3 py-2 font-medium">Age</th>
              <th className="px-3 py-2 font-medium">Exception</th>
              <th className="px-3 py-2 font-medium">Item / draft</th>
              <th className="px-3 py-2 font-medium">Seller</th>
              <th className="px-3 py-2 font-medium">Portfolio</th>
              <th className="px-3 py-2 font-medium">Shipment</th>
              <th className="px-3 py-2 font-medium">Storage</th>
              <th className="px-3 py-2 font-medium">Condition</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-2"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} /></td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{r.age}</td>
                <td className="px-3 py-2"><ExceptionBadge code={r.code} /></td>
                <td className="px-3 py-2 text-gray-900">{r.catalogLabel ?? r.draftLabel}</td>
                <td className="px-3 py-2 text-gray-600">{r.sellerLabel ?? '—'}</td>
                <td className="px-3 py-2 text-gray-600">{r.portfolioName ?? '—'}</td>
                <td className="px-3 py-2 text-gray-600">{r.shipmentTrackingNumber ?? '—'}</td>
                <td className="px-3 py-2 text-gray-600">{r.storageLabel ?? '—'}</td>
                <td className="px-3 py-2 text-gray-600">{r.condition ?? '—'}</td>
                <td className="px-3 py-2 text-gray-500">{r.source}</td>
                <td className="px-3 py-2">
                  <Link href={`/admin/intake/exceptions/${r.id}`} className="text-blue-600 hover:underline">Resolve →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
