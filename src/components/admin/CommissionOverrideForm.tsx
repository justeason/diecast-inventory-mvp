'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  createSellerCommissionOverrideAction,
  endSellerCommissionOverrideAction,
  type CommissionPolicyActionState,
} from '@/lib/actions/commissionPolicies'

function SubmitButton({ label, confirmMessage }: { label: string; confirmMessage?: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => { if (confirmMessage && !confirm(confirmMessage)) e.preventDefault() }}
      className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
    >
      {pending ? 'Saving…' : label}
    </button>
  )
}

const inputCls = 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-900'

export function CreateSellerOverrideForm({ sellerProfileId }: { sellerProfileId: string }) {
  const action = createSellerCommissionOverrideAction.bind(null, sellerProfileId)
  const [state, formAction] = useActionState<CommissionPolicyActionState, FormData>(action, null)

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-semibold text-gray-700">New commission override</p>
      {state?.errors?._form && <p className="text-xs text-red-600">{state.errors._form[0]}</p>}
      {state?.approvalRequestId && (
        <p className="text-xs text-amber-700">
          Approval required — <a className="underline" href={`/admin/approvals/${state.approvalRequestId}`}>view request #{state.approvalRequestId}</a>
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Commission %<span className="text-gray-400 ml-1">optional</span></label>
          <input name="commissionPercent" type="text" placeholder="15" className={inputCls} />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Min. fee (USD)<span className="text-gray-400 ml-1">optional</span></label>
          <input name="minimumFeeAmount" type="text" placeholder="2.00" className={inputCls} />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Effective from</label>
          <input name="effectiveFrom" type="date" required className={inputCls} />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Effective to<span className="text-gray-400 ml-1">optional</span></label>
          <input name="effectiveTo" type="date" className={inputCls} />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-600 mb-1">Reason (required)</label>
        <textarea name="reason" rows={2} required className={inputCls} />
        {state?.errors?.reason && <p className="text-xs text-red-600 mt-1">{state.errors.reason[0]}</p>}
      </div>
      <SubmitButton label="Create override" confirmMessage="Create this seller-specific commission override?" />
    </form>
  )
}

export function EndSellerOverrideForm({ overrideId, sellerProfileId }: { overrideId: string; sellerProfileId: string }) {
  const action = endSellerCommissionOverrideAction.bind(null, overrideId, sellerProfileId)
  const [, formAction] = useActionState<CommissionPolicyActionState, FormData>(action, null)
  return (
    <form action={formAction}>
      <SubmitButton label="End now" confirmMessage="End this override effective immediately?" />
    </form>
  )
}
