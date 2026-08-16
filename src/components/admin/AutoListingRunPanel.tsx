'use client'

// 15K Part H: explicit, click-triggered Preview and Run — never automatic. Mirrors
// ItemBulkTable's convention of calling a server action directly from a button
// handler (no form/useActionState needed for these two read/one-shot actions).
import { useState } from 'react'
import Link from 'next/link'
import {
  previewAutoListingCandidatesAction, runAutoListingBatchAction,
} from '@/lib/actions/autoListing'
import type { AutoListPreviewRow } from '@/lib/autoListingExecution'
import type { AutoListingRunResult } from '@/lib/autoListingExecution'

export function AutoListingRunPanel({ enabled }: { enabled: boolean }) {
  const [previewItems, setPreviewItems] = useState<AutoListPreviewRow[] | null>(null)
  const [previewCursor, setPreviewCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'run' | null>(null)
  const [lastRun, setLastRun] = useState<AutoListingRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handlePreview() {
    setBusy('preview'); setError(null)
    const result = await previewAutoListingCandidatesAction(null)
    setBusy(null)
    if (!result.ok) { setError(result.error); return }
    setPreviewItems(result.items)
    setPreviewCursor(result.nextCursor)
  }

  async function handleRun(cursor: string | null) {
    setBusy('run'); setError(null)
    const result = await runAutoListingBatchAction(cursor)
    setBusy(null)
    if (!result.ok) { setError(result.error); return }
    setLastRun(result.result)
    setPreviewItems(null) // preview state is stale the instant a run has executed
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600 rounded-md border border-red-200 bg-red-50 px-3 py-2">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button" disabled={!enabled || busy !== null} onClick={handlePreview}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {busy === 'preview' ? 'Loading…' : 'Preview next eligible items'}
        </button>
        <button
          type="button" disabled={!enabled || busy !== null} onClick={() => handleRun(null)}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
        >
          {busy === 'run' ? 'Running…' : 'Run Auto-Listing'}
        </button>
        {!enabled && <span className="text-xs text-gray-400">Enable the policy below to preview or run.</span>}
      </div>

      {previewItems && (
        <div className="rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr><th className="px-3 py-2 font-medium">SKU</th><th className="px-3 py-2 font-medium">Catalog</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {previewItems.length === 0 && (
                <tr><td colSpan={2} className="px-3 py-3 text-gray-400">No ready candidates right now.</td></tr>
              )}
              {previewItems.map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2 font-mono text-xs"><Link href={`/admin/items/${i.id}`} className="hover:underline">{i.sku}</Link></td>
                  <td className="px-3 py-2">{i.brand} – {i.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {previewCursor && <p className="px-3 py-2 text-xs text-gray-400">More eligible items exist beyond this preview page.</p>}
        </div>
      )}

      {lastRun && (
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          <p className="font-medium text-gray-900 mb-1">Run complete</p>
          <p className="text-gray-600">
            {lastRun.processed} processed · {lastRun.listed} listed · {lastRun.reviewRequired} need review ·{' '}
            {lastRun.denied} denied · {lastRun.alreadyListed} already listed · {lastRun.stale} stale · {lastRun.failed} failed
          </p>
          {!lastRun.sourceExhausted && lastRun.nextCursor && (
            <button
              type="button" disabled={busy !== null} onClick={() => handleRun(lastRun.nextCursor)}
              className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              Continue Auto-Listing →
            </button>
          )}
          {lastRun.sourceExhausted && <p className="mt-2 text-xs text-gray-400">No more eligible candidates.</p>}
        </div>
      )}
    </div>
  )
}
