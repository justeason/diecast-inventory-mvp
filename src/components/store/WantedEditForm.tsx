'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { updateWantedListEntry, type WantedListActionState } from '@/lib/actions/wantedList'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Saving…' : 'Save'}
    </button>
  )
}

type Props = {
  id: string
  defaultMaxPrice: string
  defaultNotes: string
}

export function WantedEditForm({ id, defaultMaxPrice, defaultNotes }: Props) {
  const action = updateWantedListEntry.bind(null, id)
  const [state, formAction] = useActionState<WantedListActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  return (
    <form action={formAction} className="space-y-4">
      {errors._form && (
        <p className="text-xs text-red-600">{errors._form[0]}</p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="edit-maxDesiredPrice" className="text-sm font-medium text-gray-700">
          Max price ($){' '}
          <span className="font-normal text-gray-400">(optional, private, must be &gt; 0)</span>
        </label>
        <input
          id="edit-maxDesiredPrice"
          name="maxDesiredPrice"
          type="number"
          min="0.01"
          step="0.01"
          defaultValue={defaultMaxPrice}
          placeholder="0.00"
          className="max-w-[12rem] rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {errors.maxDesiredPrice && (
          <p className="text-xs text-red-600">{errors.maxDesiredPrice[0]}</p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="edit-notes" className="text-sm font-medium text-gray-700">
          Notes{' '}
          <span className="font-normal text-gray-400">(optional, max 500 chars)</span>
        </label>
        <input
          id="edit-notes"
          name="notes"
          type="text"
          maxLength={500}
          defaultValue={defaultNotes}
          placeholder="e.g. prefer loose"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {errors.notes && (
          <p className="text-xs text-red-600">{errors.notes[0]}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton />
        <Link
          href="/account/wanted"
          className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
