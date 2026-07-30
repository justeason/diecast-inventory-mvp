'use client'

import { useActionState } from 'react'
import type { DuplicateActionState } from '@/lib/actions/catalogDuplicates'

type Props = {
  action: (_prev: DuplicateActionState, formData: FormData) => Promise<DuplicateActionState>
  idA: string
  idB: string
  pairKey: string
}

export function SuppressPairForm({ action, idA, idB, pairKey }: Props) {
  const [state, dispatch, pending] = useActionState(action, null)
  return (
    <form action={dispatch}>
      <input type="hidden" name="idA" value={idA} />
      <input type="hidden" name="idB" value={idB} />
      <input type="hidden" name="pairKey" value={pairKey} />
      {state?.errors?.form && (
        <p className="text-xs text-red-600 mb-1">{state.errors.form[0]}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="px-4 py-2 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        Keep both (suppress this pair)
      </button>
    </form>
  )
}
