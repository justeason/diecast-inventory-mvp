'use client'

import { useActionState } from 'react'
import type { DuplicateActionState } from '@/lib/actions/catalogDuplicates'

type Props = {
  action: (_prev: DuplicateActionState, formData: FormData) => Promise<DuplicateActionState>
  pairKey: string
}

export function UnsuppressForm({ action, pairKey }: Props) {
  const [state, dispatch, pending] = useActionState(action, null)
  return (
    <form action={dispatch}>
      <input type="hidden" name="pairKey" value={pairKey} />
      {state?.errors?.form && (
        <p className="text-xs text-red-600 mb-1">{state.errors.form[0]}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="shrink-0 text-sm text-blue-600 hover:underline disabled:opacity-50"
      >
        Unsuppress
      </button>
    </form>
  )
}
