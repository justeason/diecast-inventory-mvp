'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { requestBuyerOrderLink } from '@/lib/actions/buyerAuth'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Sending…' : 'Send Link'}
    </button>
  )
}

export function BuyerOrderAccessForm() {
  const [state, action] = useActionState(requestBuyerOrderLink, { status: 'idle' })

  if (state.status === 'sent') {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-4 text-sm text-gray-700">
        If this email is associated with an order, we&rsquo;ll send a link.
        Check your inbox — the link expires in 15 minutes.
      </div>
    )
  }

  return (
    <form action={action} className="space-y-4">
      {state.status === 'error' && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.message}
        </p>
      )}

      <div>
        <label htmlFor="buyer-email" className="block text-sm font-medium text-gray-700 mb-1">
          Email Address
        </label>
        <input
          id="buyer-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="The email you used when ordering"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <SubmitButton />
    </form>
  )
}
