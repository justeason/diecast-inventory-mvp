'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { updateOrderReviewFields, type OrderReviewActionState } from '@/lib/actions/orders'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Saving…' : 'Save'}
    </button>
  )
}

type Props = {
  orderId: string
  estimatedShipping: number | null
  adminNotes: string | null
  followUpNotes: string | null
}

export function OrderReviewForm({ orderId, estimatedShipping, adminNotes, followUpNotes }: Props) {
  const action = updateOrderReviewFields.bind(null, orderId)
  const [state, formAction] = useActionState<OrderReviewActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  return (
    <form action={formAction} className="space-y-4">
      {/* Estimated Shipping */}
      <div>
        <label htmlFor="estimatedShipping" className="block text-sm font-medium text-gray-700 mb-1">
          Estimated Shipping
        </label>
        <div className="flex items-center gap-1">
          <span className="text-sm text-gray-500">$</span>
          <input
            id="estimatedShipping"
            name="estimatedShipping"
            type="number"
            min="0"
            step="0.01"
            defaultValue={estimatedShipping ?? ''}
            placeholder="0.00"
            className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
        </div>
        {errors.estimatedShipping && (
          <p className="mt-1 text-xs text-red-600">{errors.estimatedShipping[0]}</p>
        )}
      </div>

      {/* Admin Notes */}
      <div>
        <label htmlFor="adminNotes" className="block text-sm font-medium text-gray-700 mb-1">
          Admin Notes{' '}
          <span className="text-xs font-normal text-gray-400">(internal — not shown to buyers)</span>
        </label>
        <textarea
          id="adminNotes"
          name="adminNotes"
          rows={3}
          defaultValue={adminNotes ?? ''}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {/* Follow-up Notes */}
      <div>
        <label htmlFor="followUpNotes" className="block text-sm font-medium text-gray-700 mb-1">
          Follow-up Notes
        </label>
        <textarea
          id="followUpNotes"
          name="followUpNotes"
          rows={3}
          defaultValue={followUpNotes ?? ''}
          placeholder="e.g. Contacted buyer 2026-06-30 — agreed on $8 shipping via PayPal"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {errors.form && <p className="text-sm text-red-600">{errors.form[0]}</p>}

      <SubmitButton />
    </form>
  )
}
