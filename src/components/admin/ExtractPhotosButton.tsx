'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ExtractionActionState } from '@/lib/actions/intake'

type Props = {
  action: (prev: ExtractionActionState, formData: FormData) => Promise<ExtractionActionState>
}

function ExtractButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Extracting…' : 'Extract from Photos'}
    </button>
  )
}

export function ExtractPhotosButton({ action }: Props) {
  const [state, formAction] = useActionState<ExtractionActionState, FormData>(action, null)
  const error = state && 'error' in state ? state.error : null

  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-indigo-900 mb-1">AI Field Extraction</h3>
        <p className="text-xs text-indigo-700">
          Photo URLs are sent to Anthropic for analysis. Only blank fields will be filled; any
          field you have already entered is preserved.
        </p>
      </div>
      <form action={formAction}>
        <ExtractButton />
      </form>
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}
    </div>
  )
}
