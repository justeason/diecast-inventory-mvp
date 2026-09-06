'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { loginWithPassword } from '@/lib/actions/customerCredential'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Signing in…' : 'Sign In'}
    </button>
  )
}

// 19A: `returnTo` follows the exact same optional/additive contract as
// BuyerOrderAccessForm's own prop — already server-validated by the parent page
// (isSafeAccountReturnTo) before it ever reaches this hidden field;
// loginWithPassword re-validates it again itself before redirecting.
export function PasswordSignInForm({ returnTo }: { returnTo?: string } = {}) {
  const [state, action] = useActionState(loginWithPassword, { status: 'idle' })

  return (
    <form action={action} className="space-y-4">
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}

      {state.status === 'error' && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.message}
        </p>
      )}

      <div>
        <label htmlFor="signin-identifier" className="block text-sm font-medium text-gray-700 mb-1">
          Email or @handle
        </label>
        <input
          id="signin-identifier"
          name="identifier"
          type="text"
          required
          autoComplete="username"
          placeholder="you@example.com or @handle"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <div>
        <label htmlFor="signin-password" className="block text-sm font-medium text-gray-700 mb-1">
          Password
        </label>
        <input
          id="signin-password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <SubmitButton />
    </form>
  )
}
