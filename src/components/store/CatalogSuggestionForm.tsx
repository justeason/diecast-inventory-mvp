'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  submitCatalogSuggestion,
  cancelCatalogSuggestion,
  type CatalogSuggestionActionState,
} from '@/lib/actions/catalogSuggestions'

type LatestSuggestion = {
  id: string
  status: string
  adminNotes: string | null
}

type Props = {
  itemId: string
  brand: string | null
  name: string | null
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
  latestSuggestion: LatestSuggestion | null
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Submitting…' : 'Submit suggestion'}
    </button>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-0.5 text-xs text-red-600">{message}</p>
}

export function CatalogSuggestionForm({
  itemId,
  brand,
  name,
  series,
  year,
  color,
  scale,
  latestSuggestion,
}: Props) {
  const action = submitCatalogSuggestion.bind(null, itemId)
  const [state, formAction] = useActionState<CatalogSuggestionActionState, FormData>(action, null)
  const errors = state?.errors ?? {}

  const isPending   = latestSuggestion?.status === 'pending'
  const isRejected  = latestSuggestion?.status === 'rejected'
  const isDuplicate = latestSuggestion?.status === 'duplicate'

  const inputClass = (field: string) =>
    `w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
      errors[field] ? 'border-red-500' : 'border-gray-300'
    }`

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4 mb-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-2">Suggest a catalog model</h2>

      {isPending ? (
        <div className="space-y-3">
          <div className="rounded-md bg-yellow-50 border border-yellow-200 px-3 py-2 text-sm text-yellow-800">
            Catalog suggestion pending review.
          </div>
          <form action={cancelCatalogSuggestion.bind(null, latestSuggestion!.id)}>
            <button type="submit" className="text-sm text-gray-500 hover:text-gray-700 underline">
              Cancel suggestion
            </button>
          </form>
        </div>
      ) : (
        <>
          {isRejected && (
            <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              Your previous suggestion was declined.
              {latestSuggestion!.adminNotes && (
                <span className="block mt-0.5">{latestSuggestion!.adminNotes}</span>
              )}
            </div>
          )}
          {isDuplicate && (
            <div className="mb-3 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-700">
              Your previous suggestion was matched to an existing catalog model.
              {latestSuggestion!.adminNotes && (
                <span className="block mt-0.5">{latestSuggestion!.adminNotes}</span>
              )}
            </div>
          )}

          <p className="text-xs text-gray-500 mb-3">
            Can&apos;t find this model in our catalog? Submit a suggestion and we&apos;ll review it.
          </p>

          {errors.form && (
            <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {errors.form[0]}
            </div>
          )}

          <form action={formAction} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-700">Brand *</label>
                <input
                  name="brand"
                  type="text"
                  defaultValue={brand ?? ''}
                  placeholder="e.g. Hot Wheels"
                  className={inputClass('brand')}
                />
                <FieldError message={errors.brand?.[0]} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-700">Model name *</label>
                <input
                  name="name"
                  type="text"
                  defaultValue={name ?? ''}
                  placeholder="e.g. Ferrari 308 GTS"
                  className={inputClass('name')}
                />
                <FieldError message={errors.name?.[0]} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-700">Year</label>
                <input
                  name="year"
                  type="number"
                  min="1950"
                  max="2100"
                  defaultValue={year ?? ''}
                  placeholder="e.g. 1995"
                  className={inputClass('year')}
                />
                <FieldError message={errors.year?.[0]} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-700">Series</label>
                <input
                  name="series"
                  type="text"
                  defaultValue={series ?? ''}
                  placeholder="e.g. Treasure Hunt"
                  className={inputClass('series')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-700">Color</label>
                <input
                  name="color"
                  type="text"
                  defaultValue={color ?? ''}
                  placeholder="e.g. Red"
                  className={inputClass('color')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-700">Scale</label>
                <input
                  name="scale"
                  type="text"
                  defaultValue={scale ?? ''}
                  placeholder="e.g. 1:64"
                  className={inputClass('scale')}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">
                Anything we should know about this model?{' '}
                <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <textarea
                name="userNotes"
                rows={2}
                placeholder="e.g. Limited Chase variant, silver base"
                className={`${inputClass('userNotes')} resize-none`}
              />
            </div>

            <SubmitButton />
          </form>
        </>
      )}
    </div>
  )
}
