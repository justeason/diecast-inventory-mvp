'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { setPassword } from '@/lib/actions/customerCredential'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Saving…' : 'Set Password'}
    </button>
  )
}

// 19A: authenticated-session-only — no old password field, since no
// CustomerCredential exists yet for this profile (see setPassword's own guard).
export function SetPasswordForm() {
  const [state, action] = useActionState(setPassword, null)

  return (
    <form action={action} className="space-y-4">
      {state?.errors?._form && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.errors._form[0]}
        </p>
      )}
      {state?.success && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Password set.
        </p>
      )}

      <div>
        <label htmlFor="set-password" className="block text-sm font-medium text-gray-700 mb-1">
          New password
        </label>
        <input
          id="set-password"
          name="password"
          type="password"
          required
          minLength={10}
          maxLength={128}
          autoComplete="new-password"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.password && <p className="mt-1 text-sm text-red-600">{state.errors.password[0]}</p>}
      </div>

      <div>
        <label htmlFor="set-password-confirm" className="block text-sm font-medium text-gray-700 mb-1">
          Confirm password
        </label>
        <input
          id="set-password-confirm"
          name="confirmPassword"
          type="password"
          required
          minLength={10}
          maxLength={128}
          autoComplete="new-password"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.confirmPassword && <p className="mt-1 text-sm text-red-600">{state.errors.confirmPassword[0]}</p>}
      </div>

      <SubmitButton />
    </form>
  )
}
