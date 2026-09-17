'use client'

import { useActionState } from 'react'
import { addAcquisitionLotAction, type OwnershipActionState } from '@/lib/actions/collectionOwnership'

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-0.5 text-xs text-red-600">{message}</p>
}

// 26B §24: "Add Another" creates a new, independent AcquisitionLot — never a
// blind bump of the existing quantity, never inherits a prior lot's cost/date.
export function AddAcquisitionForm({ collectionItemId }: { collectionItemId: string }) {
  const action = addAcquisitionLotAction.bind(null, collectionItemId)
  const [state, formAction, isPending] = useActionState<OwnershipActionState, FormData>(action, null)
  const errors = state?.errors ?? {}

  return (
    <details className="rounded-md border border-gray-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-medium text-gray-900">Add Another</summary>
      <form action={formAction} className="mt-4 space-y-3">
        {errors.form && <p className="text-xs text-red-600">{errors.form[0]}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="add-quantity" className="text-xs font-medium text-gray-600">Quantity</label>
            <input id="add-quantity" name="quantity" type="number" min="1" step="1" defaultValue={1}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
            <FieldError message={errors.quantity?.[0]} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="add-price" className="text-xs font-medium text-gray-600">Purchase price per item ($)</label>
            <input id="add-price" name="purchasePricePerItem" type="number" min="0" step="0.01" placeholder="0.00"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
            <FieldError message={errors.purchasePricePerItem?.[0]} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="add-date" className="text-xs font-medium text-gray-600">Purchase date (optional)</label>
          <input id="add-date" name="purchaseDate" type="date" className="rounded-md border border-gray-300 px-2 py-1.5 text-sm max-w-[10rem]" />
        </div>
        <button type="submit" disabled={isPending}
          className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50">
          {isPending ? 'Adding…' : 'Add Acquisition'}
        </button>
      </form>
    </details>
  )
}
