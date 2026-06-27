'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ConvertActionState } from '@/lib/actions/intake'

type Props = {
  action: (prev: ConvertActionState, formData: FormData) => Promise<ConvertActionState>
  suggestedSku?: string
  suggestedTitle?: string
  suggestedPrice?: number | null
}

function ConvertButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-green-700 px-5 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Converting…' : label}
    </button>
  )
}

export function ConvertDraftForm({ action, suggestedSku, suggestedTitle, suggestedPrice }: Props) {
  const [state, formAction] = useActionState<ConvertActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  const [sku, setSku] = useState('')
  const [createListing, setCreateListing] = useState(false)

  return (
    <form action={formAction} className="space-y-4">
      {errors.form && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {errors.form[0]}
        </p>
      )}

      {/* SKU input with suggestion */}
      <div className="max-w-xs space-y-1">
        <label htmlFor="sku" className="text-sm font-medium text-gray-700">
          SKU <span className="text-red-500">*</span>
        </label>
        {suggestedSku && (
          <p className="text-xs text-gray-500">
            Suggested:{' '}
            <button
              type="button"
              onClick={() => setSku(suggestedSku)}
              className="font-mono text-indigo-600 hover:underline focus:outline-none"
            >
              {suggestedSku}
            </button>
            <span className="ml-1 text-gray-400">(click to use)</span>
          </p>
        )}
        <input
          id="sku"
          name="sku"
          required
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="e.g. HW-0001"
          className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
            errors.sku ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {errors.sku && <p className="text-xs text-red-600">{errors.sku[0]}</p>}
      </div>

      {/* Create listing toggle */}
      <div className="flex items-center gap-2">
        <input
          id="createListing"
          name="createListing"
          type="checkbox"
          checked={createListing}
          onChange={(e) => setCreateListing(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 accent-gray-900"
        />
        <label htmlFor="createListing" className="text-sm text-gray-700 cursor-pointer">
          Create listing immediately
        </label>
      </div>

      {/* Listing fields — shown only when checkbox is checked */}
      {createListing && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-4 space-y-3">
          <div>
            <label htmlFor="listingTitle" className="block text-sm font-medium text-gray-700 mb-1">
              Listing title <span className="text-red-500">*</span>
            </label>
            <input
              id="listingTitle"
              name="listingTitle"
              type="text"
              defaultValue={suggestedTitle ?? ''}
              placeholder="e.g. Hot Wheels Ferrari 308 GTS (1994)"
              className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
                errors.listingTitle ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.listingTitle && (
              <p className="mt-0.5 text-xs text-red-600">{errors.listingTitle[0]}</p>
            )}
          </div>
          <div className="max-w-xs">
            <label htmlFor="listingPrice" className="block text-sm font-medium text-gray-700 mb-1">
              Listing price <span className="text-red-500">*</span>
            </label>
            <input
              id="listingPrice"
              name="listingPrice"
              type="number"
              step="0.01"
              min="0.01"
              defaultValue={suggestedPrice != null ? suggestedPrice.toString() : ''}
              placeholder="e.g. 12.50"
              className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
                errors.listingPrice ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.listingPrice && (
              <p className="mt-0.5 text-xs text-red-600">{errors.listingPrice[0]}</p>
            )}
          </div>
        </div>
      )}

      <ConvertButton label={createListing ? 'Convert and Create Listing' : 'Convert to Item'} />
    </form>
  )
}
