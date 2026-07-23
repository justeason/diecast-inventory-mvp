'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  withdrawSellerSubmission,
  type SellerSubmissionActionState,
} from '@/lib/actions/sellerSubmissions'

type Props = {
  submissionId: string
}

function WithdrawButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Withdrawing…' : 'Withdraw request'}
    </button>
  )
}

export function WithdrawForm({ submissionId }: Props) {
  const [state, formAction] = useActionState<SellerSubmissionActionState, FormData>(
    withdrawSellerSubmission,
    null
  )

  return (
    <div className="space-y-2">
      {state?.errors?.form && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.errors.form[0]}
        </div>
      )}
      <p className="text-xs text-gray-500">
        You can withdraw this request while it is still pending or waiting for more information.
      </p>
      <form action={formAction}>
        <input type="hidden" name="submissionId" value={submissionId} />
        <WithdrawButton />
      </form>
    </div>
  )
}
