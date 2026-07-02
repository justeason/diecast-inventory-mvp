'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'
import type { IntakeActionState } from '@/lib/actions/intake'

const CONDITION_OPTIONS = [
  { value: 'mint', label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
]

const CARDED_LOOSE_OPTIONS = [
  { value: 'carded', label: 'Carded (on card)' },
  { value: 'loose', label: 'Loose (off card)' },
]

type DraftValues = {
  frontPhotoUrl?: string | null
  backPhotoUrl?: string | null
  brand?: string | null
  name?: string | null
  year?: number | null
  series?: string | null
  color?: string | null
  scale?: string | null
  cardedOrLoose?: string | null
  condition?: string | null
  conditionNotes?: string | null
  listPrice?: number | null
  storageLocation?: string | null
  notes?: string | null
}

type Props = {
  action: (prev: IntakeActionState, formData: FormData) => Promise<IntakeActionState>
  defaultValues?: DraftValues
  submitLabel?: string
  showCreateAnother?: boolean
  showPhotoInputs?: boolean
}

function SubmitButtons({
  primaryLabel,
  showCreateAnother,
}: {
  primaryLabel: string
  showCreateAnother?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="submit"
        name="_action"
        value="save"
        disabled={pending}
        className="rounded-md bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
      >
        {pending ? 'Saving…' : primaryLabel}
      </button>
      {showCreateAnother && (
        <button
          type="submit"
          name="_action"
          value="create-another"
          disabled={pending}
          className="rounded-md border border-gray-300 bg-white px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {pending ? 'Saving…' : 'Save and Create Another'}
        </button>
      )}
    </div>
  )
}

export function IntakeDraftForm({
  action,
  defaultValues,
  submitLabel = 'Save Draft',
  showCreateAnother,
  showPhotoInputs,
}: Props) {
  const [state, formAction] = useActionState<IntakeActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  return (
    <form action={formAction} className="space-y-6">
      {errors.form && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {errors.form[0]}
        </p>
      )}

      {/* Photos — file inputs in create mode, URL fields in edit mode */}
      {showPhotoInputs ? (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-1">Photos</h3>
          <p className="text-xs text-gray-500 mb-3">Optional — JPEG, PNG, or WebP, max 5 MB each.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">Front Photo</label>
              <input
                type="file"
                name="photo_front"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="text-sm text-gray-600 file:mr-2 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 cursor-pointer"
              />
              {errors.photo_front && (
                <p className="mt-0.5 text-xs text-red-600">{errors.photo_front[0]}</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">Back Photo</label>
              <input
                type="file"
                name="photo_back"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="text-sm text-gray-600 file:mr-2 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 cursor-pointer"
              />
              {errors.photo_back && (
                <p className="mt-0.5 text-xs text-red-600">{errors.photo_back[0]}</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Photos (URLs)</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Front Photo URL"
              name="frontPhotoUrl"
              type="url"
              defaultValue={defaultValues?.frontPhotoUrl ?? ''}
              placeholder="https://..."
              error={errors.frontPhotoUrl?.[0]}
            />
            <Input
              label="Back Photo URL"
              name="backPhotoUrl"
              type="url"
              defaultValue={defaultValues?.backPhotoUrl ?? ''}
              placeholder="https://..."
              error={errors.backPhotoUrl?.[0]}
            />
          </div>
        </div>
      )}

      {/* Model info */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Model Information</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Brand"
            name="brand"
            defaultValue={defaultValues?.brand ?? ''}
            placeholder="e.g. Hot Wheels"
            error={errors.brand?.[0]}
          />
          <Input
            label="Name"
            name="name"
            defaultValue={defaultValues?.name ?? ''}
            placeholder="e.g. Ferrari 308 GTS"
            error={errors.name?.[0]}
          />
          <Input
            label="Year"
            name="year"
            type="number"
            defaultValue={defaultValues?.year?.toString() ?? ''}
            placeholder="e.g. 1995"
            error={errors.year?.[0]}
          />
          <Input
            label="Series"
            name="series"
            defaultValue={defaultValues?.series ?? ''}
            placeholder="e.g. Treasure Hunt"
            error={errors.series?.[0]}
          />
          <Input
            label="Color"
            name="color"
            defaultValue={defaultValues?.color ?? ''}
            placeholder="e.g. Red"
            error={errors.color?.[0]}
          />
          <Input
            label="Scale"
            name="scale"
            defaultValue={defaultValues?.scale ?? ''}
            placeholder="e.g. 1:64"
            error={errors.scale?.[0]}
          />
        </div>
      </div>

      {/* Physical details */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Physical Details</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Type"
            name="cardedOrLoose"
            options={CARDED_LOOSE_OPTIONS}
            placeholder="— Select type —"
            defaultValue={defaultValues?.cardedOrLoose ?? ''}
            error={errors.cardedOrLoose?.[0]}
          />
          <Select
            label="Condition"
            name="condition"
            options={CONDITION_OPTIONS}
            placeholder="— Select condition —"
            defaultValue={defaultValues?.condition ?? ''}
            error={errors.condition?.[0]}
          />
          <div className="sm:col-span-2">
            <Input
              label="Condition Notes"
              name="conditionNotes"
              defaultValue={defaultValues?.conditionNotes ?? ''}
              placeholder="Optional notes on wear, damage, etc."
              error={errors.conditionNotes?.[0]}
            />
          </div>
        </div>
      </div>

      {/* Pricing & storage */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Pricing & Storage</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="List Price"
            name="listPrice"
            type="number"
            step="0.01"
            min="0"
            defaultValue={defaultValues?.listPrice?.toString() ?? ''}
            placeholder="e.g. 12.50"
            error={errors.listPrice?.[0]}
          />
          <Input
            label="Storage Location"
            name="storageLocation"
            defaultValue={defaultValues?.storageLocation ?? ''}
            placeholder="e.g. Shelf A3"
            error={errors.storageLocation?.[0]}
          />
        </div>
      </div>

      {/* Notes */}
      <div>
        <Input
          label="Notes"
          name="notes"
          defaultValue={defaultValues?.notes ?? ''}
          placeholder="Any additional notes"
          error={errors.notes?.[0]}
        />
      </div>

      <div className="pt-2">
        <SubmitButtons primaryLabel={submitLabel} showCreateAnother={showCreateAnother} />
      </div>
    </form>
  )
}
