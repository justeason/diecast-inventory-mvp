'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  submitManualSellRequest,
  type SellerSubmissionActionState,
} from '@/lib/actions/sellerSubmissions'

const CONDITION_OPTIONS = [
  { value: 'mint', label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
]

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Submitting…' : 'Submit sell request'}
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

export function ManualSellRequestForm() {
  const [state, formAction] = useActionState<SellerSubmissionActionState, FormData>(
    submitManualSellRequest,
    null
  )
  const errors = state?.errors ?? {}

  return (
    <form action={formAction} className="space-y-6">
      <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
        This creates a request for admin review. It does not list the item for sale automatically.
      </div>

      {errors.form?.[0] && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errors.form[0]}
        </div>
      )}

      {/* Item identification */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Item details</h2>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-brand" className="text-sm font-medium text-gray-700">
            Brand <span className="font-normal text-gray-400">(optional, max 100 characters)</span>
          </label>
          <input
            id="manual-brand"
            type="text"
            name="brand"
            maxLength={100}
            placeholder="e.g. Hot Wheels"
            className={inputCls(!!errors.brand?.[0])}
          />
          <FieldError message={errors.brand?.[0]} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-name" className="text-sm font-medium text-gray-700">
            Model name <span className="font-normal text-gray-400">(optional, max 150 characters)</span>
          </label>
          <input
            id="manual-name"
            type="text"
            name="name"
            maxLength={150}
            placeholder="e.g. '69 Camaro"
            className={inputCls(!!errors.name?.[0])}
          />
          <FieldError message={errors.name?.[0]} />
        </div>

        {errors.brandOrName?.[0] && (
          <p className="text-xs text-red-600">{errors.brandOrName[0]}</p>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-series" className="text-sm font-medium text-gray-700">
            Series <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="manual-series"
            type="text"
            name="series"
            maxLength={150}
            placeholder="e.g. Treasure Hunt"
            className={inputCls(!!errors.series?.[0])}
          />
          <FieldError message={errors.series?.[0]} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="manual-year" className="text-sm font-medium text-gray-700">
              Year <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id="manual-year"
              type="number"
              name="year"
              min={1900}
              max={2100}
              placeholder="e.g. 2023"
              className={inputCls(!!errors.year?.[0])}
            />
            <FieldError message={errors.year?.[0]} />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="manual-scale" className="text-sm font-medium text-gray-700">
              Scale <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id="manual-scale"
              type="text"
              name="scale"
              maxLength={50}
              placeholder="e.g. 1:64"
              className={inputCls(!!errors.scale?.[0])}
            />
            <FieldError message={errors.scale?.[0]} />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-color" className="text-sm font-medium text-gray-700">
            Color <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="manual-color"
            type="text"
            name="color"
            maxLength={100}
            placeholder="e.g. Red"
            className={inputCls(!!errors.color?.[0])}
          />
          <FieldError message={errors.color?.[0]} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-carded" className="text-sm font-medium text-gray-700">
            Carded or loose <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <select
            id="manual-carded"
            name="cardedOrLoose"
            defaultValue=""
            className={inputCls(!!errors.cardedOrLoose?.[0])}
          >
            <option value="">Select…</option>
            <option value="carded">Carded</option>
            <option value="loose">Loose</option>
          </select>
          <FieldError message={errors.cardedOrLoose?.[0]} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-condition" className="text-sm font-medium text-gray-700">
            Condition <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <select
            id="manual-condition"
            name="condition"
            defaultValue=""
            className={inputCls(!!errors.condition?.[0])}
          >
            <option value="">Select condition</option>
            {CONDITION_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <FieldError message={errors.condition?.[0]} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-condition-notes" className="text-sm font-medium text-gray-700">
            Condition notes <span className="font-normal text-gray-400">(optional, max 500 characters)</span>
          </label>
          <textarea
            id="manual-condition-notes"
            name="conditionNotes"
            rows={2}
            maxLength={500}
            placeholder="Describe any wear, scratches, or notable details"
            className={`${inputCls(!!errors.conditionNotes?.[0])} resize-none`}
          />
          <FieldError message={errors.conditionNotes?.[0]} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-quantity" className="text-sm font-medium text-gray-700">
            Quantity <span className="text-red-500">*</span>
          </label>
          <input
            id="manual-quantity"
            type="number"
            name="quantity"
            min={1}
            defaultValue={1}
            className={inputCls(!!errors.quantity?.[0])}
          />
          <FieldError message={errors.quantity?.[0]} />
        </div>
      </div>

      {/* Sale preferences */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Sale preferences</h2>

        <fieldset>
          <legend className="text-sm font-medium text-gray-700 mb-2">
            How would you like to sell? <span className="text-red-500">*</span>
          </legend>
          <div className="space-y-2">
            {[
              {
                value: 'consignment',
                label: 'Consign with us',
                description: 'We sell it on your behalf; you receive proceeds minus commission.',
              },
              {
                value: 'buyout',
                label: 'Sell it to us outright',
                description: 'We purchase the item from you directly.',
              },
              {
                value: 'unsure',
                label: 'Not sure yet',
                description: "Let's discuss options.",
              },
            ].map(({ value, label, description }) => (
              <label key={value} className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="saleTypePreference"
                  value={value}
                  className="mt-0.5 shrink-0"
                />
                <span>
                  <span className="text-sm font-medium text-gray-900">{label}</span>
                  <span className="block text-xs text-gray-500">{description}</span>
                </span>
              </label>
            ))}
          </div>
          <FieldError message={errors.saleTypePreference?.[0]} />
        </fieldset>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-expected-price" className="text-sm font-medium text-gray-700">
            Expected price <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="manual-expected-price"
            type="number"
            name="expectedPrice"
            min={0}
            step="0.01"
            placeholder="0.00"
            className={inputCls(!!errors.expectedPrice?.[0])}
          />
          <p className="text-xs text-gray-400">For reference only — does not guarantee a sale price.</p>
          <FieldError message={errors.expectedPrice?.[0]} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="manual-user-notes" className="text-sm font-medium text-gray-700">
            Anything else we should know?{' '}
            <span className="font-normal text-gray-400">(optional, max 1000 characters)</span>
          </label>
          <textarea
            id="manual-user-notes"
            name="userNotes"
            rows={3}
            maxLength={1000}
            placeholder="Special packaging, accessories included, provenance, etc."
            className={`${inputCls(!!errors.userNotes?.[0])} resize-none`}
          />
          <FieldError message={errors.userNotes?.[0]} />
        </div>
      </div>

      <SubmitButton />
    </form>
  )
}
