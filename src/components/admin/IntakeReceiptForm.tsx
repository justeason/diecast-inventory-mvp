'use client'

import { useActionState } from 'react'
import { recordIntakeReceipt } from '@/lib/actions/intakeOperations'

type Props = {
  intakeId: string
  expectedQuantity?: number | null
}

export function IntakeReceiptForm({ intakeId, expectedQuantity }: Props) {
  const [state, action, pending] = useActionState(recordIntakeReceipt, null)

  const today = new Date().toISOString().split('T')[0]

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="intakeId" value={intakeId} />
      {state?.errors?.form && (
        <p className="text-sm text-red-600">{state.errors.form[0]}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Received Qty {expectedQuantity != null && <span className="text-gray-400">(expected: {expectedQuantity})</span>}
          </label>
          <input
            type="number"
            name="receivedQuantity"
            min="1"
            defaultValue={expectedQuantity ?? 1}
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {state?.errors?.receivedQuantity && (
            <p className="text-xs text-red-600 mt-1">{state.errors.receivedQuantity[0]}</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Date received</label>
          <input
            type="date"
            name="receivedAt"
            defaultValue={today}
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {state?.errors?.receivedAt && (
            <p className="text-xs text-red-600 mt-1">{state.errors.receivedAt[0]}</p>
          )}
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Received by</label>
        <input
          type="text"
          name="receivedBy"
          placeholder="Name or initials"
          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Receiving notes</label>
        <textarea
          name="receivingNotes"
          rows={2}
          placeholder="Condition on arrival, discrepancies…"
          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="px-4 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Record receipt'}
      </button>
    </form>
  )
}
