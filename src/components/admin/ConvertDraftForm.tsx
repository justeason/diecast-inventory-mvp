'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Input } from '@/components/admin/ui/Input'
import type { ConvertActionState } from '@/lib/actions/intake'

type Props = {
  action: (prev: ConvertActionState, formData: FormData) => Promise<ConvertActionState>
}

function ConvertButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-green-700 px-5 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Converting…' : 'Convert to Item'}
    </button>
  )
}

export function ConvertDraftForm({ action }: Props) {
  const [state, formAction] = useActionState<ConvertActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  return (
    <form action={formAction} className="space-y-4">
      {errors.form && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {errors.form[0]}
        </p>
      )}
      <div className="max-w-xs">
        <Input
          label="SKU"
          name="sku"
          required
          placeholder="e.g. HW-2024-001"
          error={errors.sku?.[0]}
        />
      </div>
      <ConvertButton />
    </form>
  )
}
