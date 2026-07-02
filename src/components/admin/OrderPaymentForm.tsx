'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { updateOrderPayment, type OrderPaymentActionState } from '@/lib/actions/orders'

const PAYMENT_STATUS_OPTIONS = [
  { value: 'unpaid',    label: 'Unpaid' },
  { value: 'requested', label: 'Payment Requested' },
  { value: 'paid',      label: 'Paid' },
]

const PAYMENT_METHOD_SUGGESTIONS = ['Zelle', 'Venmo', 'PayPal F&F', 'Cash', 'Other']

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Saving…' : 'Save Payment Info'}
    </button>
  )
}

function toDateInputValue(date: Date | null): string {
  if (!date) return ''
  return date.toISOString().slice(0, 10)
}

type Props = {
  orderId: string
  paymentStatus: string
  paymentMethod: string | null
  paymentReference: string | null
  paymentLink: string | null
  paymentRequestedAt: Date | null
  paidAt: Date | null
}

export function OrderPaymentForm({
  orderId,
  paymentStatus,
  paymentMethod,
  paymentReference,
  paymentLink,
  paymentRequestedAt,
  paidAt,
}: Props) {
  const action = updateOrderPayment.bind(null, orderId)
  const [state, formAction] = useActionState<OrderPaymentActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  return (
    <form action={formAction} className="space-y-4">
      {/* Payment Status */}
      <div>
        <label htmlFor="paymentStatus" className="block text-sm font-medium text-gray-700 mb-1">
          Payment Status
        </label>
        <select
          id="paymentStatus"
          name="paymentStatus"
          defaultValue={paymentStatus}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {PAYMENT_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {errors.paymentStatus && (
          <p className="mt-1 text-xs text-red-600">{errors.paymentStatus[0]}</p>
        )}
      </div>

      {/* Payment Method */}
      <div>
        <label htmlFor="paymentMethod" className="block text-sm font-medium text-gray-700 mb-1">
          Payment Method
        </label>
        <input
          id="paymentMethod"
          name="paymentMethod"
          type="text"
          list="payment-method-suggestions"
          defaultValue={paymentMethod ?? ''}
          placeholder="e.g. Zelle, Venmo, PayPal F&F"
          className="w-60 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <datalist id="payment-method-suggestions">
          {PAYMENT_METHOD_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      {/* Payment Reference */}
      <div>
        <label htmlFor="paymentReference" className="block text-sm font-medium text-gray-700 mb-1">
          Payment Reference{' '}
          <span className="text-xs font-normal text-gray-400">(transaction ID, confirmation, note)</span>
        </label>
        <input
          id="paymentReference"
          name="paymentReference"
          type="text"
          defaultValue={paymentReference ?? ''}
          placeholder="e.g. Venmo #1234567, Zelle confirmation"
          className="w-full max-w-md rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {/* Payment Link */}
      <div>
        <label htmlFor="paymentLink" className="block text-sm font-medium text-gray-700 mb-1">
          Payment Link{' '}
          <span className="text-xs font-normal text-gray-400">(paste a payment URL to send buyer)</span>
        </label>
        <input
          id="paymentLink"
          name="paymentLink"
          type="text"
          defaultValue={paymentLink ?? ''}
          placeholder="e.g. https://venmo.com/u/yourname"
          className="w-full max-w-md rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {/* Dates */}
      <div className="flex flex-wrap gap-6">
        <div>
          <label htmlFor="paymentRequestedAt" className="block text-sm font-medium text-gray-700 mb-1">
            Payment Requested Date
          </label>
          <input
            id="paymentRequestedAt"
            name="paymentRequestedAt"
            type="date"
            defaultValue={toDateInputValue(paymentRequestedAt)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          {errors.paymentRequestedAt && (
            <p className="mt-1 text-xs text-red-600">{errors.paymentRequestedAt[0]}</p>
          )}
        </div>

        <div>
          <label htmlFor="paidAt" className="block text-sm font-medium text-gray-700 mb-1">
            Paid Date
          </label>
          <input
            id="paidAt"
            name="paidAt"
            type="date"
            defaultValue={toDateInputValue(paidAt)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          {errors.paidAt && (
            <p className="mt-1 text-xs text-red-600">{errors.paidAt[0]}</p>
          )}
        </div>
      </div>

      {errors.form && <p className="text-sm text-red-600">{errors.form[0]}</p>}

      <SubmitButton />
    </form>
  )
}
