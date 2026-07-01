'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ConvertActionState } from '@/lib/actions/intake'

type CatalogModelSummary = {
  id: string
  brand: string
  name: string
  year: number | null
  series: string | null
  color: string | null
  scale: string | null
}

type Props = {
  action: (prev: ConvertActionState, formData: FormData) => Promise<ConvertActionState>
  suggestedSku?: string
  suggestedTitle?: string
  suggestedPrice?: number | null
  exactCatalogMatch?: CatalogModelSummary | null
  similarCatalogModels?: CatalogModelSummary[]
}

function formatModel(m: CatalogModelSummary): string {
  return [m.brand, m.name, m.year?.toString(), m.series, m.color, m.scale]
    .filter(Boolean)
    .join(' · ')
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

export function ConvertDraftForm({
  action,
  suggestedSku,
  suggestedTitle,
  suggestedPrice,
  exactCatalogMatch,
  similarCatalogModels = [],
}: Props) {
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

      {/* Catalog model match status */}
      {exactCatalogMatch ? (
        /* Case A: exact match — will reuse, no choice needed */
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm">
          <p className="font-medium text-green-800 mb-0.5">✓ Will reuse existing catalog model</p>
          <p className="text-green-700 font-mono text-xs">{formatModel(exactCatalogMatch)}</p>
          <input type="hidden" name="catalogModelId" value={exactCatalogMatch.id} />
        </div>
      ) : similarCatalogModels.length > 0 ? (
        /* Case B: no exact match but similar models exist — let admin choose */
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm space-y-3">
          <p className="font-medium text-amber-800">
            ⚠ No exact match — will create a new catalog model unless you select one below.
          </p>
          <div className="space-y-2">
            {similarCatalogModels.map((m) => (
              <label key={m.id} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="catalogModelId"
                  value={m.id}
                  className="mt-0.5 accent-amber-700"
                />
                <span className="text-amber-900 font-mono text-xs">{formatModel(m)}</span>
              </label>
            ))}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="catalogModelId"
                value=""
                defaultChecked
                className="mt-0.5 accent-amber-700"
              />
              <span className="text-amber-900 font-medium">Create a new catalog model</span>
            </label>
          </div>
        </div>
      ) : (
        /* Case C: no match, no similar — will create new */
        <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
          <p className="text-gray-500">○ No existing catalog model found — a new one will be created.</p>
          <input type="hidden" name="catalogModelId" value="" />
        </div>
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
