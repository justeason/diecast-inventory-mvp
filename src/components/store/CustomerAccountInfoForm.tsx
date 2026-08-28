'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { updateCustomerAccountInfo, type CustomerAccountInfoState } from '@/lib/actions/customerAccount'

type Existing = {
  name: string | null
  phone: string | null
  email: string
  updatedAt: string
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  )
}

// Name and phone are editable; email is shown read-only (no change-email
// workflow yet — Part instruction). No password/deletion/address fields here.
export function CustomerAccountInfoForm({ existing }: { existing: Existing }) {
  const [state, formAction] = useActionState<CustomerAccountInfoState, FormData>(
    updateCustomerAccountInfo,
    null,
  )

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="expectedUpdatedAt" value={existing.updatedAt} />

      {state?.success && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Account info saved.
        </p>
      )}
      {state?.errors?._form && (
        <p className="text-sm text-red-600">{state.errors._form[0]}</p>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-900 mb-1">Email</label>
        <p className="text-sm text-gray-700">{existing.email}</p>
        <p className="text-xs text-gray-400 mt-0.5">Your login email — used for sign-in links.</p>
      </div>

      <div>
        <label htmlFor="account-name" className="block text-sm font-medium text-gray-900 mb-1">
          Name
        </label>
        <input
          id="account-name"
          name="name"
          type="text"
          defaultValue={existing.name ?? ''}
          placeholder="Your name"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.name && <p className="mt-1 text-xs text-red-600">{state.errors.name[0]}</p>}
      </div>

      <div>
        <label htmlFor="account-phone" className="block text-sm font-medium text-gray-900 mb-1">
          Phone <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="account-phone"
          name="phone"
          type="tel"
          defaultValue={existing.phone ?? ''}
          placeholder="(555) 555-5555"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {state?.errors?.phone && <p className="mt-1 text-xs text-red-600">{state.errors.phone[0]}</p>}
      </div>

      <SubmitButton />
    </form>
  )
}
