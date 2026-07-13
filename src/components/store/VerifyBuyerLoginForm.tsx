'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { verifyBuyerLoginToken } from '@/lib/actions/buyerAuth'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Verifying…' : 'View My Orders →'}
    </button>
  )
}

export function VerifyBuyerLoginForm({ token }: { token: string }) {
  const [state, action] = useActionState(verifyBuyerLoginToken, { status: 'idle' })

  return (
    <form action={action} className="space-y-4">
      {/* Token submitted as hidden field — not displayed visibly in the UI */}
      <input type="hidden" name="token" value={token} />

      {state.status === 'error' && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p className="mb-2">{state.message}</p>
          <Link
            href="/account/orders"
            className="font-medium underline underline-offset-2 hover:text-red-900"
          >
            Request a new link
          </Link>
        </div>
      )}

      <SubmitButton />
    </form>
  )
}
