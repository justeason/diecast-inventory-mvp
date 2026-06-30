'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { loginAdmin, type LoginState } from '@/lib/actions/auth'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Logging in…' : 'Log In'}
    </button>
  )
}

export default function AdminLoginPage() {
  const [error, formAction] = useActionState<LoginState, FormData>(loginAdmin, null)

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <h1 className="text-xl font-semibold text-gray-900 mb-6">Admin Login</h1>
          <form action={formAction} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoFocus
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <SubmitButton />
          </form>
        </div>
      </div>
    </div>
  )
}
