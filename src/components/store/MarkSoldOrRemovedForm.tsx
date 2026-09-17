'use client'

import { useActionState, useState } from 'react'
import { markCollectionItemDisposedAction, type OwnershipActionState } from '@/lib/actions/collectionOwnership'

const REASON_OPTIONS = [
  { value: 'external_sale', label: 'Sold elsewhere' },
  { value: 'gift', label: 'Gifted' },
  { value: 'trade', label: 'Traded' },
  { value: 'other_removal', label: 'Other removal' },
]

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-0.5 text-xs text-red-600">{message}</p>
}

// 26B §52-55: private removal action distinct from "Sell One" (the on-platform
// consignment/buyout flow, unchanged). Only "Sold elsewhere" collects
// proceeds — gift/trade/other removal never compute a realized loss. A
// per-mount idempotency token guards against duplicate submission (§55) —
// retrying the SAME submission (same token) is a no-op; reloading the page
// (a new submission intent) gets a fresh token.
export function MarkSoldOrRemovedForm({ collectionItemId }: { collectionItemId: string }) {
  const action = markCollectionItemDisposedAction.bind(null, collectionItemId)
  const [state, formAction, isPending] = useActionState<OwnershipActionState, FormData>(action, null)
  const errors = state?.errors ?? {}
  const [reason, setReason] = useState('external_sale')
  const [idempotencyToken] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
  )

  return (
    <details className="rounded-md border border-gray-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-medium text-gray-900">Mark Sold / Removed</summary>
      <form action={formAction} className="mt-4 space-y-3">
        <input type="hidden" name="idempotencyToken" value={idempotencyToken} />
        {errors.form && <p className="text-xs text-red-600">{errors.form[0]}</p>}

        <div className="flex flex-col gap-1">
          <label htmlFor="disposal-reason" className="text-xs font-medium text-gray-600">Reason</label>
          <select id="disposal-reason" name="disposalType" value={reason} onChange={(e) => setReason(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
            {REASON_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <FieldError message={errors.disposalType?.[0]} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="disposal-quantity" className="text-xs font-medium text-gray-600">Quantity</label>
            <input id="disposal-quantity" name="quantity" type="number" min="1" step="1" defaultValue={1}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
            <FieldError message={errors.quantity?.[0]} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="disposal-date" className="text-xs font-medium text-gray-600">Date</label>
            <input id="disposal-date" name="disposedAt" type="date" className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
        </div>

        {reason === 'external_sale' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="disposal-proceeds" className="text-xs font-medium text-gray-600">
              Total proceeds ($) <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input id="disposal-proceeds" name="netProceeds" type="number" min="0" step="0.01" placeholder="0.00"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm max-w-[10rem]" />
            <FieldError message={errors.netProceeds?.[0]} />
            <p className="text-xs text-gray-400">Total for the whole removed quantity, not per item.</p>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="disposal-notes" className="text-xs font-medium text-gray-600">Notes (optional)</label>
          <input id="disposal-notes" name="notes" type="text" className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
        </div>

        <button type="submit" disabled={isPending}
          className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50">
          {isPending ? 'Saving…' : 'Confirm Removal'}
        </button>
        <p className="text-xs text-gray-400">
          Recorded Realized Gain/Loss is based on recorded acquisition cost and known seller proceeds; not tax/accounting advice.
        </p>
      </form>
    </details>
  )
}
