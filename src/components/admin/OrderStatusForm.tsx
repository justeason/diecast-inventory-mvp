'use client'

import { useActionState } from 'react'
import { updateOrderStatus, type OrderStatusActionState } from '@/lib/actions/orders'

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'picking', label: 'Picking' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
]

type Props = {
  orderId: string
  currentStatus: string
}

export function OrderStatusForm({ orderId, currentStatus }: Props) {
  const action = updateOrderStatus.bind(null, orderId)
  const [state, formAction, isPending] = useActionState<OrderStatusActionState, FormData>(
    action,
    null
  )

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 space-y-1.5">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Status meanings</p>
        <p><strong className="text-gray-900">Pending</strong> — Order request received. Awaiting your confirmation; no payment yet.</p>
        <p><strong className="text-gray-900">Paid</strong> — Payment confirmed manually. Items remain reserved.</p>
        <p><strong className="text-gray-900">Picking</strong> — Preparing and pulling items from storage.</p>
        <p><strong className="text-gray-900">Shipped</strong> — Shipped or handed off to buyer.</p>
      </div>
      <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 space-y-1">
        <p className="text-xs font-medium text-amber-600 uppercase tracking-wide mb-2">Irreversible actions</p>
        <p><strong>Complete</strong> — Marks reserved items as sold and closes their listings. Cannot be undone.</p>
        <p><strong>Cancelled</strong> — Releases reserved items back to available. Listings remain active.</p>
      </div>
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <select
          name="status"
          defaultValue={currentStatus}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? 'Saving…' : 'Update Status'}
        </button>
        {state && 'errors' in state && state.errors.form && (
          <p className="text-sm text-red-600">{state.errors.form[0]}</p>
        )}
      </form>
    </div>
  )
}
