'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  approveSuggestion,
  rejectSuggestion,
  markSuggestionDuplicate,
  type AdminSuggestionActionState,
} from '@/lib/actions/adminCatalogSuggestions'
import { CatalogModelSearch } from '@/components/shared/CatalogModelSearch'

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Saving…' : label}
    </button>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-0.5 text-xs text-red-600">{message}</p>
}

function inputCls(hasError: boolean) {
  return `w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
    hasError ? 'border-red-500' : 'border-gray-300'
  }`
}

// ─── Approve Form ─────────────────────────────────────────────────────────────

type ApproveFormProps = {
  suggestionId: string
  hasCollectionItem: boolean
  brand: string
  name: string
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
}

export function SuggestionApproveForm({
  suggestionId,
  hasCollectionItem,
  brand,
  name,
  series,
  year,
  color,
  scale,
}: ApproveFormProps) {
  const action = approveSuggestion.bind(null, suggestionId)
  const [state, formAction] = useActionState<AdminSuggestionActionState, FormData>(action, null)
  const errors = state?.errors ?? {}

  return (
    <div className="rounded-md border border-gray-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Approve as new catalog model</h3>

      {errors.form && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errors.form[0]}
        </div>
      )}

      <form action={formAction} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Brand *</label>
            <input
              name="brand"
              type="text"
              defaultValue={brand}
              className={inputCls(!!errors.brand)}
            />
            <FieldError message={errors.brand?.[0]} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Model name *</label>
            <input
              name="name"
              type="text"
              defaultValue={name}
              className={inputCls(!!errors.name)}
            />
            <FieldError message={errors.name?.[0]} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Year</label>
            <input
              name="year"
              type="number"
              min="1950"
              max="2100"
              defaultValue={year ?? ''}
              className={inputCls(!!errors.year)}
            />
            <FieldError message={errors.year?.[0]} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Series</label>
            <input
              name="series"
              type="text"
              defaultValue={series ?? ''}
              className={inputCls(false)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Color</label>
            <input
              name="color"
              type="text"
              defaultValue={color ?? ''}
              className={inputCls(false)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Scale</label>
            <input
              name="scale"
              type="text"
              defaultValue={scale ?? ''}
              className={inputCls(false)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">
            Admin notes <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <textarea
            name="adminNotes"
            rows={2}
            className={`${inputCls(false)} resize-none`}
          />
        </div>

        {hasCollectionItem && (
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              name="linkItem"
              type="checkbox"
              defaultChecked
              className="rounded border-gray-300"
            />
            Link submitter&apos;s collection item to the new catalog model
          </label>
        )}

        <SubmitButton label="Approve & Create Catalog Model" />
      </form>
    </div>
  )
}

// ─── Reject Form ──────────────────────────────────────────────────────────────

export function SuggestionRejectForm({ suggestionId }: { suggestionId: string }) {
  const action = rejectSuggestion.bind(null, suggestionId)
  const [state, formAction] = useActionState<AdminSuggestionActionState, FormData>(action, null)
  const errors = state?.errors ?? {}

  return (
    <div className="rounded-md border border-gray-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Reject suggestion</h3>

      {errors.form && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errors.form[0]}
        </div>
      )}

      <form action={formAction} className="space-y-4">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">
            Reason <span className="font-normal text-gray-400">(optional — shown to submitter)</span>
          </label>
          <textarea
            name="adminNotes"
            rows={2}
            placeholder="e.g. This model already exists under a different name"
            className={`${inputCls(false)} resize-none`}
          />
        </div>
        <SubmitButton label="Reject Suggestion" />
      </form>
    </div>
  )
}

// ─── Mark Duplicate Form ──────────────────────────────────────────────────────

type DuplicateFormProps = {
  suggestionId: string
  hasCollectionItem: boolean
}

export function SuggestionDuplicateForm({
  suggestionId,
  hasCollectionItem,
}: DuplicateFormProps) {
  const action = markSuggestionDuplicate.bind(null, suggestionId)
  const [state, formAction] = useActionState<AdminSuggestionActionState, FormData>(action, null)
  const errors = state?.errors ?? {}

  return (
    <div className="rounded-md border border-gray-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Mark as duplicate</h3>

      {errors.form && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errors.form[0]}
        </div>
      )}

      <form action={formAction} className="space-y-4">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Existing catalog model *</label>
          <p className="text-xs text-gray-400 mb-1">
            Search for the existing catalog model this suggestion duplicates.
          </p>
          <CatalogModelSearch name="existingCatalogId" />
          <FieldError message={errors.existingCatalogId?.[0]} />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">
            Admin notes <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <textarea
            name="adminNotes"
            rows={2}
            className={`${inputCls(false)} resize-none`}
          />
        </div>

        {hasCollectionItem && (
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              name="linkItem"
              type="checkbox"
              defaultChecked
              className="rounded border-gray-300"
            />
            Link submitter&apos;s collection item to the existing catalog model
          </label>
        )}

        <SubmitButton label="Mark as Duplicate" />
      </form>
    </div>
  )
}
