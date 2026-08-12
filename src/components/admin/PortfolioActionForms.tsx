'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { PortfolioActionState } from '@/lib/actions/sellerPortfolios'
import {
  addSubmissionToPortfolio,
  updatePortfolioAcceptedCount,
  cancelSellerPortfolio,
  completeSellerPortfolio,
} from '@/lib/actions/sellerPortfolios'

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
    >
      {pending ? 'Saving…' : label}
    </button>
  )
}

function FormError({ state }: { state: PortfolioActionState }) {
  const msg = state?.errors ? Object.values(state.errors)[0]?.[0] : null
  if (!msg) return null
  return <p className="mt-1 text-xs text-red-600">{msg}</p>
}

export function UpdateAcceptedCountForm({ portfolioId, defaultValue }: { portfolioId: string; defaultValue: number | null }) {
  const [state, formAction] = useActionState(updatePortfolioAcceptedCount.bind(null, portfolioId), null)
  return (
    <form action={formAction} className="flex items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Accepted quantity</label>
        <input
          type="text"
          inputMode="numeric"
          name="acceptedItemCount"
          defaultValue={defaultValue ?? ''}
          placeholder="e.g. 75"
          className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />
      </div>
      <SubmitButton label="Update" />
      <FormError state={state} />
    </form>
  )
}

export function AddSubmissionForm({ portfolioId, candidates }: { portfolioId: string; candidates: Array<{ id: string; label: string }> }) {
  const [state, formAction] = useActionState(addSubmissionToPortfolio.bind(null, portfolioId), null)
  if (candidates.length === 0) {
    return <p className="text-xs text-gray-400">No other unassigned submissions from this seller.</p>
  }
  return (
    <form action={formAction} className="flex items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Add submission</label>
        <select name="submissionId" className="w-64 rounded-md border border-gray-300 px-2 py-1.5 text-sm" defaultValue="">
          <option value="" disabled>Select a submission…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>
      <SubmitButton label="Add" />
      <FormError state={state} />
    </form>
  )
}

export function CancelPortfolioForm({ portfolioId }: { portfolioId: string }) {
  const [state, formAction] = useActionState(cancelSellerPortfolio.bind(null, portfolioId), null)
  return (
    <form action={formAction} className="flex items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Cancellation reason</label>
        <input name="reason" className="w-64 rounded-md border border-gray-300 px-2 py-1.5 text-sm" placeholder="Why is this portfolio being cancelled?" />
      </div>
      <button type="submit" className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
        Cancel portfolio
      </button>
      <FormError state={state} />
    </form>
  )
}

export function CompletePortfolioForm({ portfolioId }: { portfolioId: string }) {
  const [state, formAction] = useActionState(completeSellerPortfolio.bind(null, portfolioId), null)
  return (
    <form action={formAction}>
      <button type="submit" className="rounded-md border border-green-300 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50">
        Mark completed
      </button>
      <FormError state={state} />
    </form>
  )
}
