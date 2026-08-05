'use client'

import { useActionState } from 'react'
import { rejectObservation, type MatchActionState } from '@/lib/actions/externalMarketResearch'

export function RejectForm({ observationId, updatedAt }: { observationId: string; updatedAt: string }) {
  const action = rejectObservation.bind(null, observationId)
  const [state, formAction, isPending] = useActionState<MatchActionState, FormData>(action, null)

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="updatedAt" value={updatedAt} />
      <label className="block text-xs font-medium text-gray-600">Rejection reason</label>
      <textarea
        name="rejectionReason"
        rows={2}
        maxLength={500}
        placeholder="Describe why this observation is being rejected…"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        required
      />
      {state?.errors?.['rejectionReason']?.map(e => (
        <p key={e} className="text-xs text-red-600">{e}</p>
      ))}
      {state?.errors?.['form']?.map(e => (
        <p key={e} className="text-xs text-red-600">{e}</p>
      ))}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50 transition-colors"
      >
        {isPending ? 'Rejecting…' : 'Reject observation'}
      </button>
    </form>
  )
}
