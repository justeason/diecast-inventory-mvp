'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { MergeActionState } from '@/lib/actions/catalog'

type ModelSummary = {
  id: string
  brand: string
  name: string
  year: number | null
  series: string | null
  color: string | null
  scale: string | null
  notes: string | null
  itemCount: number
  listingCount: number
  createdAt: string
}

type Props = {
  action: (prev: MergeActionState, formData: FormData) => Promise<MergeActionState>
  models: ModelSummary[]
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="rounded-md bg-red-700 px-5 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Merging…' : 'Merge →'}
    </button>
  )
}

export function CatalogMergeForm({ action, models }: Props) {
  const [state, formAction] = useActionState<MergeActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  const [canonicalId,  setCanonicalId]  = useState('')
  const [duplicateIds, setDuplicateIds] = useState<Set<string>>(new Set())
  const [confirmed,    setConfirmed]    = useState(false)

  function handleCanonicalChange(id: string) {
    setCanonicalId(id)
    setDuplicateIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setConfirmed(false)
  }

  function handleDuplicateToggle(id: string, checked: boolean) {
    if (id === canonicalId) return
    setDuplicateIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id); else next.delete(id)
      return next
    })
    setConfirmed(false)
  }

  const dupeItemCount    = models.filter((m) => duplicateIds.has(m.id)).reduce((n, m) => n + m.itemCount, 0)
  const dupeListingCount = models.filter((m) => duplicateIds.has(m.id)).reduce((n, m) => n + m.listingCount, 0)
  const canSubmit        = canonicalId !== '' && duplicateIds.size > 0 && confirmed

  return (
    <form action={formAction} className="space-y-6 max-w-4xl">
      {errors.form && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {errors.form[0]}
        </p>
      )}

      {/* Hidden inputs carry the actual form values */}
      <input type="hidden" name="canonicalId" value={canonicalId} />
      {[...duplicateIds].map((id) => (
        <input key={id} type="hidden" name="duplicateId" value={id} />
      ))}

      {/* Model selection table */}
      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-xs text-gray-500">
              <th className="px-3 py-3 font-medium">Keep</th>
              <th className="px-3 py-3 font-medium">Merge</th>
              <th className="px-3 py-3 font-medium">Year</th>
              <th className="px-3 py-3 font-medium">Color</th>
              <th className="px-3 py-3 font-medium">Series</th>
              <th className="px-3 py-3 font-medium">Scale</th>
              <th className="px-3 py-3 font-medium">Notes</th>
              <th className="px-3 py-3 font-medium">Items</th>
              <th className="px-3 py-3 font-medium">Listings</th>
              <th className="px-3 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {models.map((model) => {
              const isCanonical = canonicalId === model.id
              const isDuplicate = duplicateIds.has(model.id)
              return (
                <tr
                  key={model.id}
                  className={
                    isCanonical ? 'bg-green-50' :
                    isDuplicate ? 'bg-red-50'   : ''
                  }
                >
                  <td className="px-3 py-3 text-center">
                    <input
                      type="radio"
                      name="_keep"
                      checked={isCanonical}
                      onChange={() => handleCanonicalChange(model.id)}
                      aria-label={`Keep ${model.year ?? 'unknown year'} ${model.color ?? ''}`}
                      className="accent-green-700"
                    />
                  </td>
                  <td className="px-3 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={isDuplicate}
                      disabled={isCanonical}
                      onChange={(e) => handleDuplicateToggle(model.id, e.target.checked)}
                      aria-label={`Merge ${model.year ?? 'unknown year'} ${model.color ?? ''}`}
                      className="accent-red-700 disabled:opacity-30"
                    />
                  </td>
                  <td className="px-3 py-3 text-gray-700">{model.year    ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-700">{model.color   ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-700">{model.series  ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-700">{model.scale   ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-500 text-xs max-w-[140px] truncate">
                    {model.notes ?? '—'}
                  </td>
                  <td className="px-3 py-3 text-gray-700">{model.itemCount}</td>
                  <td className="px-3 py-3 text-gray-700">{model.listingCount}</td>
                  <td className="px-3 py-3 text-gray-400 text-xs whitespace-nowrap">
                    {new Date(model.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        <span className="inline-block w-3 h-3 rounded-sm bg-green-100 border border-green-300 mr-1 align-middle" />
        Green = kept (canonical).{' '}
        <span className="inline-block w-3 h-3 rounded-sm bg-red-100 border border-red-300 mr-1 align-middle" />
        Red = will be merged and deleted. Only the canonical model's fields are preserved —
        copy any useful notes from duplicate rows before merging.
      </p>

      {/* Irreversible warning — only shown once canonical + duplicates are selected */}
      {canonicalId !== '' && duplicateIds.size > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-4 text-sm space-y-3">
          <p className="font-semibold text-red-800">This merge is irreversible.</p>
          <ul className="list-disc list-inside text-red-700 space-y-1">
            <li>
              {dupeItemCount} item{dupeItemCount !== 1 ? 's' : ''} will be reassigned to the canonical model
            </li>
            {dupeListingCount > 0 && (
              <li>
                {dupeListingCount} listing{dupeListingCount !== 1 ? 's' : ''} will be affected (via their items — no status change)
              </li>
            )}
            <li>
              {duplicateIds.size} catalog model{duplicateIds.size !== 1 ? 's' : ''} will be permanently deleted
            </li>
          </ul>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="rounded border-red-300 accent-red-700"
            />
            <span className="text-red-800 font-medium">
              I understand this merge is permanent and cannot be undone
            </span>
          </label>
        </div>
      )}

      <div className="flex items-center gap-4">
        <SubmitButton disabled={!canSubmit} />
        <a href="/admin/catalog/duplicates" className="text-sm text-gray-500 hover:text-gray-700">
          Cancel
        </a>
      </div>
    </form>
  )
}
