'use client'

// 15I: bulk-select table for the Items list. Mirrors the IntakeExceptionQueueTable
// convention (same selection/confirm/result pattern) — but this operates on
// ItemInstance via executeBulkItemAction, a completely separate engine from 15E's
// IntakeDraft resolution. An IntakeDraft exception is not yet an ItemInstance.

import { useState } from 'react'
import Link from 'next/link'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { CatalogModelCombobox } from '@/components/admin/CatalogModelCombobox'
import type { CatalogMatchResult } from '@/lib/catalogMatching'
import { executeBulkItemAction, type BulkItemActionResult, type BulkItemRowResult } from '@/lib/actions/itemBulkActions'

export type ItemBulkRow = {
  id: string
  sku: string
  brand: string
  name: string
  status: string
  condition: string
  locationLabel: string | null
  listingStatus: string | null
  listPrice: number | null
  photoUrl: string | null
}

const CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged']
const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint', near_mint: 'Near Mint', good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
}
const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', available: 'Available', reserved: 'Reserved', sold: 'Sold', not_for_sale: 'Not for Sale',
}
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  available: 'bg-green-100 text-green-700',
  reserved: 'bg-yellow-100 text-yellow-700',
  sold: 'bg-blue-100 text-blue-700',
  not_for_sale: 'bg-red-100 text-red-700',
}
const LISTING_STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700', sold: 'bg-blue-100 text-blue-700', archived: 'bg-gray-100 text-gray-600',
}
const LISTING_STATUS_LABELS: Record<string, string> = { active: 'Active', sold: 'Sold', archived: 'Archived' }

const OUTCOME_LABELS: Record<BulkItemRowResult['outcome'], string> = {
  updated: 'Updated', unchanged: 'Already set', approval_required: 'Approval required',
  denied: 'Denied', not_found: 'Not found', validation_failed: 'Failed',
}

export function ItemBulkTable({ items }: { items: ItemBulkRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [storageQuery, setStorageQuery] = useState('')
  const [storageMatches, setStorageMatches] = useState<{ id: string; label: string }[]>([])
  const [storageResolved, setStorageResolved] = useState<{ id: string; label: string } | null>(null)
  const [condition, setCondition] = useState('')
  const [catalogTarget, setCatalogTarget] = useState<CatalogMatchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<'storage' | 'condition' | 'catalog' | null>(null)
  const [lastResult, setLastResult] = useState<BulkItemActionResult | null>(null)

  const skuById = new Map(items.map((i) => [i.id, i.sku]))
  const allChecked = items.length > 0 && items.every((i) => selected.has(i.id))

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(items.map((i) => i.id)))
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

  async function runBulk(input: { storageLocationId?: string; condition?: string; catalogId?: string }) {
    if (selected.size === 0 || busy) return
    setBusy(true)
    setConfirming(null)
    const itemIds = [...selected]
    const result = input.storageLocationId
      ? await executeBulkItemAction({ action: 'set_storage', itemIds, storageLocationId: input.storageLocationId })
      : input.condition
      ? await executeBulkItemAction({ action: 'set_condition', itemIds, condition: input.condition })
      : await executeBulkItemAction({ action: 'assign_catalog', itemIds, catalogId: input.catalogId! })
    setBusy(false)
    setLastResult(result)
    if (result.ok) setSelected(new Set())
  }

  return (
    <div>
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 mb-3 rounded-md border border-gray-300 bg-white p-3 shadow-sm text-sm space-y-2">
          <p className="font-medium text-gray-900">{selected.size} item{selected.size !== 1 ? 's' : ''} selected</p>
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
              Set Storage
            </button>

            <select value={condition} onChange={(e) => setCondition(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-xs">
              <option value="">Condition…</option>
              {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABELS[c]}</option>)}
            </select>
            <button type="button" disabled={!condition || busy} onClick={() => setConfirming('condition')}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium disabled:opacity-40">
              Set Condition
            </button>

            <div className="w-56">
              <CatalogModelCombobox name="bulkCatalogTarget" onSelect={setCatalogTarget} placeholder="Catalog correction…" />
            </div>
            <button type="button" disabled={!catalogTarget || busy} onClick={() => setConfirming('catalog')}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium disabled:opacity-40">
              Catalog Correction
            </button>

            <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-gray-500 hover:text-gray-800">
              Clear selection
            </button>
          </div>

          {confirming && (
            <div className={`rounded-md border p-2 text-xs ${confirming === 'catalog' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              {confirming === 'storage' && (
                <p className="mb-1">Set storage to <strong>{storageResolved?.label}</strong> for {selected.size} item(s). Each item will be evaluated individually.</p>
              )}
              {confirming === 'condition' && (
                <p className="mb-1">Set condition to <strong>{CONDITION_LABELS[condition]}</strong> for {selected.size} item(s). Each item will be evaluated individually.</p>
              )}
              {confirming === 'catalog' && (
                <>
                  <p className="mb-1 font-medium">
                    You are confirming these {selected.size} selected physical items are the same model: <strong>{catalogTarget?.brand} {catalogTarget?.name}</strong>.
                  </p>
                  <p className="mb-1">Some items may require risk approval before the change takes effect.</p>
                </>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (confirming === 'storage') void runBulk({ storageLocationId: storageResolved!.id })
                    else if (confirming === 'condition') void runBulk({ condition })
                    else void runBulk({ catalogId: catalogTarget!.id })
                  }}
                  className="rounded-md bg-amber-700 px-2 py-1 font-medium text-white"
                >
                  {confirming === 'catalog' ? 'Confirm catalog correction' : 'Apply'}
                </button>
                <button type="button" onClick={() => setConfirming(null)} className="text-amber-700 underline">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {lastResult?.ok && (
        <div className="mb-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
          <p className="font-medium text-gray-900">
            {lastResult.succeeded} updated · {lastResult.unchanged} already set · {lastResult.approvalRequired} need approval · {lastResult.failed} failed
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
            {lastResult.results.filter((r) => r.outcome !== 'updated' && r.outcome !== 'unchanged').map((r) => (
              <li key={r.itemId}>
                {skuById.get(r.itemId) ?? r.itemId}: {OUTCOME_LABELS[r.outcome]}
                {'reason' in r && r.reason ? ` — ${r.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {lastResult && !lastResult.ok && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{lastResult.error}</div>
      )}

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-gray-500">
              <th className="px-2 py-3"><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
              <th className="px-4 py-3 font-medium w-14"></th>
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Catalog</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Condition</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">List Price</th>
              <th className="px-4 py-3 font-medium">Listing</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-gray-50">
                <td className="px-2 py-3"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleOne(item.id)} /></td>
                <td className="px-4 py-3">
                  <PhotoThumbnail photoUrl={item.photoUrl} alt={item.sku} size="sm" />
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  <Link href={`/admin/items/${item.id}`} className="hover:underline">{item.sku}</Link>
                </td>
                <td className="px-4 py-3">{item.brand} – {item.name}</td>
                <td className="px-4 py-3 text-gray-500">{item.locationLabel ?? '—'}</td>
                <td className="px-4 py-3 text-gray-500">{CONDITION_LABELS[item.condition] ?? item.condition}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {STATUS_LABELS[item.status] ?? item.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{item.listPrice != null ? `$${item.listPrice.toFixed(2)}` : '—'}</td>
                <td className="px-4 py-3">
                  {item.listingStatus ? (
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${LISTING_STATUS_COLORS[item.listingStatus] ?? 'bg-gray-100 text-gray-600'}`}>
                      {LISTING_STATUS_LABELS[item.listingStatus] ?? item.listingStatus}
                    </span>
                  ) : item.status === 'available' ? (
                    <Link href={`/admin/listings/new?itemId=${item.id}`} className="text-blue-600 hover:underline text-sm">List →</Link>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/admin/items/${item.id}`} className="text-blue-600 hover:underline text-sm">View</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
