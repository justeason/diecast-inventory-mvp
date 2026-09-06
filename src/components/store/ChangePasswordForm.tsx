'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { changePassword } from '@/lib/actions/customerCredential'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Saving…' : 'Change Password'}
    </button>
  )
}

// 19A section 10: when the current session is a magic-link sign-in within the
// last 15 minutes, the server action allows replacing the password without the
// old one (forgot-password recovery, no separate reset-token system) — the page
// computes this eligibility server-side (recentMagicLinkReauth) and passes only
// the resulting boolean here, never raw session internals.
export function ChangePasswordForm({ canSkipCurrentPassword }: { canSkipCurrentPassword: boolean }) {
  const [state, action] = useActionState(changePassword, null)

  return (
    <form action={action} className="space-y-4">
      {state?.errors?._form && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.errors._form[0]}
        </p>
      )}
      {state?.success && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Password changed. Other signed-in devices have been signed out.
        </p>
      )}

      {canSkipCurrentPassword ? (
        <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
          You recently signed in with a secure email link, so you can set a new password without
          entering your old one.
        </p>
      ) : (
        <div>
          <label htmlFor="change-password-current" className="block text-sm font-medium text-gray-700 mb-1">
            Current password
          </label>
          <input
            id="change-password-current"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          {state?.errors?.currentPassword && <p className="mt-1 text-sm text-red-600">{state.errors.currentPassword[0]}</p>}
        </div>
      )}

      <div>
        <label htmlFor="change-password-new" className="block text-sm font-medium text-gray-700 mb-1">
          New password
        </label>
        <input
          id="change-password-new"
          name="newPassword"
          type="password"
          required
          minLength={10}
          maxLength={128}
          autoComplete="new-password"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.newPassword && <p className="mt-1 text-sm text-red-600">{state.errors.newPassword[0]}</p>}
      </div>

      <div>
        <label htmlFor="change-password-confirm" className="block text-sm font-medium text-gray-700 mb-1">
          Confirm new password
        </label>
        <input
          id="change-password-confirm"
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
