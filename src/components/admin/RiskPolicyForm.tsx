'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { createRiskPolicyVersionAction, type RiskPolicyActionState } from '@/lib/actions/riskPolicies'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
    >
      {pending ? 'Publishing…' : 'Publish new version'}
    </button>
  )
}

const inputCls = 'block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900'
const labelCls = 'block text-sm font-medium text-gray-700 mb-1'

export function RiskPolicyForm() {
  const [state, formAction] = useActionState<RiskPolicyActionState, FormData>(createRiskPolicyVersionAction, null)
  const errors = state?.errors ?? {}

  return (
    <form action={formAction} className="space-y-4 rounded-md border border-gray-200 bg-white p-5 max-w-lg">
      {errors._form && <p className="text-sm text-red-600">{errors._form[0]}</p>}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>High-value review threshold ($)</label>
          <input name="highValueReviewThreshold" type="text" placeholder="200.00" className={inputCls} />
          {errors.highValueReviewThreshold && <p className="text-xs text-red-600 mt-1">{errors.highValueReviewThreshold[0]}</p>}
        </div>
        <div>
          <label className={labelCls}>Very-high-value threshold ($)</label>
          <input name="veryHighValueThreshold" type="text" placeholder="1000.00" className={inputCls} />
          {errors.veryHighValueThreshold && <p className="text-xs text-red-600 mt-1">{errors.veryHighValueThreshold[0]}</p>}
        </div>
        <div>
          <label className={labelCls}>Payout approval threshold ($)</label>
          <input name="payoutApprovalThreshold" type="text" placeholder="1000.00" className={inputCls} />
          {errors.payoutApprovalThreshold && <p className="text-xs text-red-600 mt-1">{errors.payoutApprovalThreshold[0]}</p>}
        </div>
        <div>
          <label className={labelCls}>Price deviation tolerance (%)</label>
          <input name="priceDeviationTolerancePercent" type="text" placeholder="15" className={inputCls} />
          {errors.priceDeviationTolerancePercent && <p className="text-xs text-red-600 mt-1">{errors.priceDeviationTolerancePercent[0]}</p>}
        </div>
      </div>

      <div>
        <label className={labelCls}>Effective from</label>
        <input name="effectiveFrom" type="datetime-local" className={inputCls} />
        {errors.effectiveFrom && <p className="text-xs text-red-600 mt-1">{errors.effectiveFrom[0]}</p>}
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="destructiveActionsRequireApproval" defaultChecked className="rounded border-gray-300" />
        Destructive/ownership-adjacent inventory actions require approval
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="commercialOverridesRequireApproval" defaultChecked className="rounded border-gray-300" />
        Commercial overrides (commission overrides) require approval
      </label>

      <div>
        <label className={labelCls}>Notes</label>
        <textarea name="notes" rows={2} className={inputCls} placeholder="Why this version was published…" />
      </div>

      <SubmitButton />
    </form>
  )
}
