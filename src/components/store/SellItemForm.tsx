'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  submitCollectionItemForSale,
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

type Props = {
  collectionItemId: string
  prefill: {
    condition: string | null
    conditionNotes: string | null
    quantity: number
  }
}

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

export function SellItemForm({ collectionItemId, prefill }: Props) {
  const action = submitCollectionItemForSale.bind(null, collectionItemId)
  const [state, formAction] = useActionState<SellerSubmissionActionState, FormData>(action, null)
  const errors = state?.errors ?? {}

  const inputClass = (field: string) =>
    `w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
      errors[field] ? 'border-red-500' : 'border-gray-300'
    }`

  return (
    <form action={formAction} className="space-y-5">
      {errors.form && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errors.form[0]}
        </div>
      )}

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
        <label htmlFor="sell-quantity" className="text-sm font-medium text-gray-700">
          Quantity to sell
        </label>
        <input
          id="sell-quantity"
          type="number"
          name="quantity"
          min={1}
          max={prefill.quantity}
          defaultValue={prefill.quantity}
          className={inputClass('quantity')}
        />
        <p className="text-xs text-gray-400">
          You have {prefill.quantity} in your collection.
        </p>
        <FieldError message={errors.quantity?.[0]} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="sell-condition" className="text-sm font-medium text-gray-700">
          Condition
        </label>
        <select
          id="sell-condition"
          name="condition"
          defaultValue={prefill.condition ?? ''}
          className={inputClass('condition')}
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
        <label htmlFor="sell-condition-notes" className="text-sm font-medium text-gray-700">
          Condition notes{' '}
          <span className="font-normal text-gray-400">(optional — max 500 characters)</span>
        </label>
        <textarea
          id="sell-condition-notes"
          name="conditionNotes"
          rows={2}
          maxLength={500}
          defaultValue={prefill.conditionNotes ?? ''}
          placeholder="Describe any wear, scratches, or notable details"
          className={`${inputClass('conditionNotes')} resize-none`}
        />
        <FieldError message={errors.conditionNotes?.[0]} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="sell-expected-price" className="text-sm font-medium text-gray-700">
          Expected price{' '}
          <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="sell-expected-price"
          type="number"
          name="expectedPrice"
          min={0}
          step="0.01"
          placeholder="0.00"
          className={inputClass('expectedPrice')}
        />
        <p className="text-xs text-gray-400">
          For reference only — does not guarantee a sale price.
        </p>
        <FieldError message={errors.expectedPrice?.[0]} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="sell-user-notes" className="text-sm font-medium text-gray-700">
          Anything else we should know?{' '}
          <span className="font-normal text-gray-400">(optional — max 1000 characters)</span>
        </label>
        <textarea
          id="sell-user-notes"
          name="userNotes"
          rows={3}
          maxLength={1000}
          placeholder="Special packaging, accessories included, provenance, etc."
          className={`${inputClass('userNotes')} resize-none`}
        />
        <FieldError message={errors.userNotes?.[0]} />
      </div>

      <SubmitButton />
    </form>
  )
}
