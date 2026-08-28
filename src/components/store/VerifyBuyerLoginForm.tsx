'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { verifyBuyerLoginToken } from '@/lib/actions/buyerAuth'

function SubmitButton({ hasReturnTo }: { hasReturnTo: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Verifying…' : hasReturnTo ? 'Continue →' : 'Sign In →'}
    </button>
  )
}

// 16M: `returnTo` is optional — omitted for the normal Orders sign-in flow (Part
// AE, byte-identical to before). When present, it is already server-validated
// (isSafeAccountReturnTo, in the parent page) before ever reaching this hidden
// field; verifyBuyerLoginToken re-validates it again itself before redirecting.
export function VerifyBuyerLoginForm({ token, returnTo }: { token: string; returnTo?: string }) {
  const [state, action] = useActionState(verifyBuyerLoginToken, { status: 'idle' })

  return (
    <form action={action} className="space-y-4">
      {/* Token submitted as hidden field — not displayed visibly in the UI */}
      <input type="hidden" name="token" value={token} />
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}

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

      <SubmitButton hasReturnTo={!!returnTo} />
    </form>
  )
}
