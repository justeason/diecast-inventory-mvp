'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  approveRiskApprovalRequest,
  rejectRiskApprovalRequest,
  cancelRiskApprovalRequest,
  type RiskApprovalActionState,
} from '@/lib/actions/riskApprovals'

function SubmitButton({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? 'Saving…' : label}
    </button>
  )
}

// 15F-review section 23: this system has exactly one shared admin credential — there
// is no way to prove the requester and the approver are different people. This form
// deliberately does NOT claim four-eyes / separation-of-duties; both requestedBy and
// approvedBy/rejectedBy are honestly recorded as the literal string "admin".
export function RiskApprovalDecisionForm({ id, noteRequired }: { id: string; noteRequired: boolean }) {
  const approveAction = approveRiskApprovalRequest.bind(null, id)
  const rejectAction = rejectRiskApprovalRequest.bind(null, id)
  const cancelAction = cancelRiskApprovalRequest.bind(null, id)
  const [approveState, approveFormAction] = useActionState<RiskApprovalActionState, FormData>(approveAction, null)
  const [rejectState, rejectFormAction] = useActionState<RiskApprovalActionState, FormData>(rejectAction, null)
  const [, cancelFormAction] = useActionState<RiskApprovalActionState, FormData>(cancelAction, null)

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        This system provides explicit approval gating but not person-level segregation of duties — the same
        shared admin credential may both request and decide.
      </p>

      <form action={approveFormAction} className="space-y-2 rounded-md border border-green-200 bg-green-50 p-4">
        <label className="block text-sm font-medium text-gray-700">
          Decision note {noteRequired && <span className="text-red-500">*</span>}
        </label>
        <textarea name="decisionNote" rows={2} className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
        {approveState?.errors?.decisionNote && <p className="text-xs text-red-600">{approveState.errors.decisionNote[0]}</p>}
        {approveState?.errors?._form && <p className="text-xs text-red-600">{approveState.errors._form[0]}</p>}
        <SubmitButton label="Approve" className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50" />
      </form>

      <form action={rejectFormAction} className="space-y-2 rounded-md border border-red-200 bg-red-50 p-4">
        <label className="block text-sm font-medium text-gray-700">Decision note (required to reject)</label>
        <textarea name="decisionNote" rows={2} className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
        {rejectState?.errors?.decisionNote && <p className="text-xs text-red-600">{rejectState.errors.decisionNote[0]}</p>}
        {rejectState?.errors?._form && <p className="text-xs text-red-600">{rejectState.errors._form[0]}</p>}
        <SubmitButton label="Reject" className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50" />
      </form>

      <form action={cancelFormAction}>
        <SubmitButton label="Cancel request" className="text-sm text-gray-500 hover:text-gray-800 underline" />
      </form>
    </div>
  )
}
