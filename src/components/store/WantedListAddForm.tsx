'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { CatalogModelSearch } from '@/components/shared/CatalogModelSearch'
import { addToWantedList, type WantedListActionState } from '@/lib/actions/wantedList'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Adding…' : 'Add to Wanted List'}
    </button>
  )
}

export function WantedListAddForm() {
  const [state, formAction] = useActionState<WantedListActionState, FormData>(addToWantedList, null)
  const errors = state && 'errors' in state ? state.errors : {}

  return (
    <form action={formAction} className="rounded-md border border-gray-200 bg-gray-50 px-4 py-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-900">Add a model</h2>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Catalog model</label>
        <CatalogModelSearch name="catalogModelId" placeholder="Search by brand, name, year…" />
        {errors.catalogModelId && (
          <p className="text-xs text-red-600">{errors.catalogModelId[0]}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="maxDesiredPrice" className="text-sm font-medium text-gray-700">
            Max price ($){' '}
            <span className="font-normal text-gray-400">(optional, private)</span>
          </label>
          <input
            id="maxDesiredPrice"
            name="maxDesiredPrice"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          {errors.maxDesiredPrice && (
            <p className="text-xs text-red-600">{errors.maxDesiredPrice[0]}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="wantedNotes" className="text-sm font-medium text-gray-700">
            Notes{' '}
            <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="wantedNotes"
            name="notes"
            type="text"
            placeholder="e.g. prefer loose"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
        </div>
      </div>

      {errors._form && (
        <p className="text-xs text-red-600">{errors._form[0]}</p>
      )}

      <SubmitButton />
    </form>
  )
}
