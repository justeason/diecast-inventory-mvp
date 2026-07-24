'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  updateSellerSubmissionStatus,
  type SellerSubmissionActionState,
} from '@/lib/actions/sellerSubmissions'

const ADMIN_STATUS_OPTIONS = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'under_review', label: 'Under review' },
  { value: 'needs_info', label: 'Needs info' },
  { value: 'approved_for_intake', label: 'Approved for intake' },
  { value: 'declined', label: 'Declined' },
] as const

type Props = {
  submissionId: string
  currentStatus: string
  currentAdminNotes: string | null
  currentUserMessage: string | null
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Saving…' : 'Save status'}
    </button>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-1 text-xs text-red-600">{message}</p>
}

function inputCls(hasError: boolean) {
  return `w-full rounded-md border px-3 py-2 text-sm ${hasError ? 'border-red-500' : 'border-gray-300'}`
}

export function SellerSubmissionStatusForm({
  submissionId,
  currentStatus,
  currentAdminNotes,
  currentUserMessage,
}: Props) {
  const action = updateSellerSubmissionStatus.bind(null, submissionId)
  const [state, formAction] = useActionState<SellerSubmissionActionState, FormData>(action, null)
  const errors = state?.errors ?? {}

  return (
    <form action={formAction} className="space-y-5">
      {errors.form?.[0] && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errors.form[0]}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
        <select
          name="status"
          defaultValue={currentStatus}
          className={inputCls(!!errors.status?.[0])}
        >
          {ADMIN_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <FieldError message={errors.status?.[0]} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Admin notes{' '}
          <span className="font-normal text-gray-400">(internal only, never shown to seller)</span>
        </label>
        <textarea
          name="adminNotes"
          defaultValue={currentAdminNotes ?? ''}
          rows={4}
          maxLength={2000}
          className={inputCls(!!errors.adminNotes?.[0])}
          placeholder="Internal notes…"
        />
        <FieldError message={errors.adminNotes?.[0]} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Message to seller{' '}
          <span className="font-normal text-gray-400">
            (shown to seller when status is Needs info or Declined)
          </span>
        </label>
        <textarea
          name="userMessage"
          defaultValue={currentUserMessage ?? ''}
          rows={4}
          maxLength={1000}
          className={inputCls(!!errors.userMessage?.[0])}
          placeholder="Message shown to the seller…"
        />
        <FieldError message={errors.userMessage?.[0]} />
      </div>

      <SubmitButton />
    </form>
  )
}
