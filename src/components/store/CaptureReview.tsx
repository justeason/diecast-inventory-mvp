'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  removeCaptureItem,
  updateCaptureItem,
  submitCaptureSession,
  cancelCaptureSession,
  type CaptureItemResult,
  type CaptureSessionResult,
  type SubmitItemResult,
} from '@/lib/actions/mobileCapture'

type Props = {
  session: CaptureSessionResult
}

export function CaptureReview({ session: initial }: Props) {
  const router  = useRouter()
  const [items,     setItems]     = useState<CaptureItemResult[]>(initial.items)
  const [submitting,setSubmitting]= useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [results,   setResults]   = useState<SubmitItemResult[] | null>(null)
  const [error,         setError]         = useState<string | null>(null)
  const [removing,      setRemoving]      = useState<string | null>(null)
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const [cancelWorking, setCancelWorking] = useState(false)
  const [cancelError,   setCancelError]   = useState<string | null>(null)

  const destination = initial.destination
  const sessionId   = initial.id

  async function handleRemove(itemId: string) {
    setRemoving(itemId)
    const res = await removeCaptureItem(itemId, sessionId)
    setRemoving(null)
    if (!res.ok) { setError(res.error); return }
    setItems(prev => prev.filter(i => i.id !== itemId))
  }

  async function handleQuantityChange(item: CaptureItemResult, qty: number) {
    if (qty < 1 || qty > 999) return
    const res = await updateCaptureItem(item.id, sessionId, { quantity: qty }, item.updatedAt)
    if (!res.ok) { setError(res.error); return }
    setItems(prev => prev.map(i => i.id === item.id ? res.data : i))
  }

  async function handleSubmit() {
    if (items.length === 0) return
    setSubmitting(true)
    setError(null)
    const res = await submitCaptureSession(sessionId)
    setSubmitting(false)
    if (!res.ok) { setError(res.error); return }

    setResults(res.data.results)
    setSubmitted(res.data.submitted)

    if (res.data.submitted) {
      // All items converted — redirect to appropriate destination
      setTimeout(() => {
        router.push(destination === 'collection' ? '/account/collection' : '/account/sell')
      }, 2000)
    } else {
      // Partial failure — remove successfully converted items from list
      const failedIds = new Set(res.data.results.filter(r => !r.ok).map(r => r.itemId))
      setItems(prev => prev.filter(i => failedIds.has(i.id)))
    }
  }

  async function handleCancelSession() {
    setCancelWorking(true)
    setCancelError(null)
    const res = await cancelCaptureSession(sessionId)
    setCancelWorking(false)
    if (!res.ok) { setCancelError(res.error); return }
    router.push('/account')
  }

  const itemResult = (id: string) => results?.find(r => r.itemId === id)

  if (submitted && results?.every(r => r.ok)) {
    return (
      <div className="py-12 text-center">
        <div className="text-4xl mb-4">✓</div>
        <p className="font-semibold text-gray-900">All items submitted!</p>
        <p className="text-sm text-gray-500 mt-1">Redirecting…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">
          Review {destination === 'collection' ? 'Collection' : 'Sale'} Queue
        </h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/account/capture')}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            + Add more
          </button>
          {!results && !cancelConfirm && (
            <button
              onClick={() => setCancelConfirm(true)}
              className="text-sm text-gray-400 hover:text-red-600"
            >
              Cancel batch
            </button>
          )}
        </div>
      </div>

      {cancelConfirm && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
          <p className="text-sm font-medium text-red-800">
            Cancel this batch? All {items.length} item{items.length !== 1 ? 's' : ''} will be discarded.
          </p>
          {cancelError && <p className="text-xs text-red-600">{cancelError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleCancelSession}
              disabled={cancelWorking}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {cancelWorking ? 'Cancelling…' : 'Yes, cancel batch'}
            </button>
            <button
              onClick={() => { setCancelConfirm(false); setCancelError(null) }}
              disabled={cancelWorking}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Keep items
            </button>
          </div>
        </div>
      )}

      {items.length === 0 && !submitted && (
        <p className="text-sm text-gray-500">Your queue is empty.</p>
      )}

      <ul className="divide-y divide-gray-100">
        {items.map(item => {
          const res = itemResult(item.id)
          return (
            <li key={item.id} className="py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {item.brand} {item.name}{item.year ? ` (${item.year})` : ''}
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <label className="text-xs text-gray-500">Qty</label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={item.quantity}
                    onChange={e => handleQuantityChange(item, parseInt(e.target.value, 10) || 1)}
                    className="w-16 rounded border border-gray-200 px-2 py-0.5 text-xs"
                    disabled={submitting || !!results}
                  />
                  {item.condition && (
                    <span className="text-xs text-gray-500 capitalize">
                      {item.condition.replace('_', ' ')}
                    </span>
                  )}
                  {item.acquisitionDate && (
                    <span className="text-xs text-gray-400">
                      {new Date(item.acquisitionDate).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {res && !res.ok && (
                  <p className="text-xs text-red-600 mt-1">{res.error}</p>
                )}
                {res?.ok && (
                  <p className="text-xs text-green-600 mt-1">Submitted</p>
                )}
              </div>
              {!results && (
                <button
                  onClick={() => handleRemove(item.id)}
                  disabled={removing === item.id || submitting}
                  className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40 shrink-0 mt-1"
                >
                  {removing === item.id ? '…' : 'Remove'}
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!results && items.length > 0 && (
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting
            ? 'Submitting…'
            : `Submit ${items.length} item${items.length !== 1 ? 's' : ''} to ${destination === 'collection' ? 'collection' : 'sell queue'}`
          }
        </button>
      )}

      {results && !submitted && (
        <p className="text-sm text-amber-700 bg-amber-50 rounded-lg p-3">
          Some items could not be submitted. Remove or fix them and try again.
        </p>
      )}
    </div>
  )
}
