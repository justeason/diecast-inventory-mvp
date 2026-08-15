'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { SellerAgreementActionState } from '@/lib/actions/sellerAgreements'

type LifecycleAction = (
  _prev: SellerAgreementActionState,
  formData: FormData,
) => Promise<SellerAgreementActionState>

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null
  return <p className="mt-1 text-xs text-red-600">{messages[0]}</p>
}

function PendingButton({
  label,
  pendingLabel,
  className,
}: {
  label: string
  pendingLabel: string
  className: string
}) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingLabel : label}
    </button>
  )
}

export function ProposeAgreementForm({ action }: { action: LifecycleAction }) {
  const [state, formAction] = useActionState(action, {})
  const e = state.errors ?? {}

  return (
    <form action={formAction}>
      <input type="hidden" name="_action" value="propose" />
      {(e._form || e.sellerTermsSummary) && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {e._form?.[0] ?? e.sellerTermsSummary?.[0]}
        </div>
      )}
      <PendingButton
        label="Propose to seller"
        pendingLabel="Proposing…"
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      />
    </form>
  )
}

export function RecordAcceptanceForm({ action }: { action: LifecycleAction }) {
  const [state, formAction] = useActionState(action, {})
  const e = state.errors ?? {}

  return (
    <form action={formAction} className="space-y-3">
      {e._form && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {e._form[0]}
        </div>
      )}
      {'approvalRequestId' in state && state.approvalRequestId && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Approval required —{' '}
          <a className="underline" href={`/admin/approvals/${state.approvalRequestId}`}>view request #{state.approvalRequestId}</a>
        </div>
      )}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Acceptance method <span className="text-red-500">*</span>
        </label>
        <select
          name="acceptanceMethod"
          defaultValue=""
          className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          <option value="" disabled>
            Select method…
          </option>
          <option value="email">Email confirmation</option>
          <option value="in_person">In person</option>
          <option value="platform">Platform (signed in-app)</option>
        </select>
        <FieldError messages={e.acceptanceMethod} />
      </div>
      <PendingButton
        label="Record acceptance"
        pendingLabel="Recording…"
        className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50 transition-colors"
      />
    </form>
  )
}

export function CancelAgreementForm({ action }: { action: LifecycleAction }) {
  const [state, formAction] = useActionState(action, {})
  const e = state.errors ?? {}

  return (
    <form action={formAction}>
      <input type="hidden" name="_action" value="cancel" />
      {e._form && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {e._form[0]}
        </div>
      )}
      <PendingButton
        label="Cancel agreement"
        pendingLabel="Cancelling…"
        className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
      />
    </form>
  )
}
