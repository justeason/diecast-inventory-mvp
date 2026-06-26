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
      <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
        Cancelled and complete are terminal actions. Use carefully.
      </p>
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
