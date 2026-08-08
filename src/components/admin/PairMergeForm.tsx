'use client'

import { useActionState, useState } from 'react'
import type { MergeActionState } from '@/lib/actions/catalog'

type Props = {
  action: (_prev: MergeActionState, formData: FormData) => Promise<MergeActionState>
  canonicalId: string
  duplicateId: string
  canonicalLabel: string
  expectedImpactSnapshot?: string
}

export function PairMergeForm({ action, canonicalId, duplicateId, canonicalLabel, expectedImpactSnapshot }: Props) {
  const [state, dispatch, pending] = useActionState(action, null)
  const [confirm, setConfirm] = useState('')
  const ready = confirm === 'MERGE'

  return (
    <form action={dispatch} className="space-y-4">
      <input type="hidden" name="canonicalId" value={canonicalId} />
      <input type="hidden" name="duplicateId" value={duplicateId} />
      {expectedImpactSnapshot && (
        <input type="hidden" name="expectedImpactSnapshot" value={expectedImpactSnapshot} />
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Type <strong>MERGE</strong> to confirm
        </label>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="MERGE"
          className="w-48 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {state?.errors?.form && (
        <p className="text-sm text-red-600">{state.errors.form[0]}</p>
      )}

      <button
        type="submit"
        disabled={!ready || pending}
        className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {pending ? 'Merging…' : `Merge into "${canonicalLabel}"`}
      </button>
    </form>
  )
}
