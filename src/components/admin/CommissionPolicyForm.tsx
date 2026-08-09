'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  createCommissionPolicyAction,
  endDateCommissionPolicyAction,
  type CommissionPolicyActionState,
} from '@/lib/actions/commissionPolicies'

const inputCls = 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-900'

function SubmitButton({ label, confirmMessage }: { label: string; confirmMessage: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => { if (!confirm(confirmMessage)) e.preventDefault() }}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
    >
      {pending ? 'Saving…' : label}
    </button>
  )
}

// Section 13: simple structured form, not a rules-builder. A fixed set of tier rows
// (add/remove) — no free-form expression language.
export function CreateCommissionPolicyForm() {
  const [state, formAction] = useActionState<CommissionPolicyActionState, FormData>(createCommissionPolicyAction, null)
  const [tierCount, setTierCount] = useState(3)

  return (
    <form action={formAction} className="space-y-5 rounded-md border border-gray-200 bg-white p-5">
      {state?.errors?._form && <p className="text-sm text-red-600">{state.errors._form[0]}</p>}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Policy name</label>
        <input name="name" type="text" placeholder="Standard Consignment" required className={inputCls} />
        {state?.errors?.name && <p className="text-xs text-red-600 mt-1">{state.errors.name[0]}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Default commission %</label>
          <input name="defaultCommissionPercent" type="text" placeholder="20" required className={inputCls} />
          {state?.errors?.defaultCommissionPercent && <p className="text-xs text-red-600 mt-1">{state.errors.defaultCommissionPercent[0]}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Minimum fee per item (USD)</label>
          <input name="minimumFeeAmount" type="text" placeholder="2.50" required className={inputCls} />
          {state?.errors?.minimumFeeAmount && <p className="text-xs text-red-600 mt-1">{state.errors.minimumFeeAmount[0]}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Effective from</label>
          <input name="effectiveFrom" type="date" required className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Effective to<span className="ml-1 text-xs text-gray-400">optional</span></label>
          <input name="effectiveTo" type="date" className={inputCls} />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-700">Volume tiers<span className="ml-1 text-xs text-gray-400">optional</span></label>
          <button type="button" onClick={() => setTierCount(n => n + 1)} className="text-xs text-blue-600 hover:underline">
            + Add tier
          </button>
        </div>
        <div className="space-y-2">
          {Array.from({ length: tierCount }).map((_, i) => (
            <div key={i} className="grid grid-cols-3 gap-2">
              <input name="tierMinItems" type="text" placeholder="Min items (e.g. 20)" className={inputCls} />
              <input name="tierCommissionPercent" type="text" placeholder="Rate % (e.g. 17)" className={inputCls} />
              <input name="tierMinimumFee" type="text" placeholder="Min fee (optional)" className={inputCls} />
            </div>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Leave a row blank to skip it. Tiers apply by minimum accepted item count — e.g. 1, 20, 200.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="activateImmediately" className="rounded border-gray-300" />
        Activate immediately
      </label>

      <SubmitButton label="Create policy" confirmMessage="Create this commission policy? Activating it will affect new agreement resolution." />
    </form>
  )
}

export function EndDatePolicyForm({ policyId }: { policyId: string }) {
  const action = endDateCommissionPolicyAction.bind(null, policyId)
  const [state, formAction] = useActionState<CommissionPolicyActionState, FormData>(action, null)
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input name="effectiveTo" type="date" className="rounded-md border border-gray-300 px-2 py-1 text-xs" />
      <SubmitButton label="End-date policy" confirmMessage="End this policy? It will stop applying to new resolutions from the chosen date." />
      {state?.errors?._form && <p className="text-xs text-red-600">{state.errors._form[0]}</p>}
    </form>
  )
}
