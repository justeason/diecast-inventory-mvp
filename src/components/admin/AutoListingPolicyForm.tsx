'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { publishAutoListingPolicyVersionAction, type AutoListingPolicyActionState } from '@/lib/actions/autoListingPolicy'

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

export function AutoListingPolicyForm({ currentlyEnabled }: { currentlyEnabled: boolean }) {
  const [state, formAction] = useActionState<AutoListingPolicyActionState, FormData>(publishAutoListingPolicyVersionAction, null)
  const errors = state?.errors ?? {}

  return (
    <form action={formAction} className="space-y-4 rounded-md border border-gray-200 bg-white p-5 max-w-lg">
      {errors._form && <p className="text-sm text-red-600">{errors._form[0]}</p>}

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="enabled" defaultChecked={currentlyEnabled} className="rounded border-gray-300" />
        Enabled
      </label>
      {/* Part O section 37 — one explicit statement, no alarmist multi-confirm. */}
      {!currentlyEnabled && (
        <p className="text-xs text-amber-700 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          Eligible items can be listed automatically when an admin runs Auto-Listing.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Minimum pricing confidence</label>
          <select name="minimumPricingConfidence" defaultValue="high" className={inputCls}>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          {errors.minimumPricingConfidence && <p className="text-xs text-red-600 mt-1">{errors.minimumPricingConfidence[0]}</p>}
        </div>
        <div>
          <label className={labelCls}>Price position (bps, 0=low, 5000=mid, 10000=high)</label>
          <input name="pricePositionBps" type="text" defaultValue="5000" className={inputCls} />
          {errors.pricePositionBps && <p className="text-xs text-red-600 mt-1">{errors.pricePositionBps[0]}</p>}
        </div>
      </div>

      <div>
        <label className={labelCls}>Effective from</label>
        <input name="effectiveFrom" type="datetime-local" className={inputCls} />
        {errors.effectiveFrom && <p className="text-xs text-red-600 mt-1">{errors.effectiveFrom[0]}</p>}
      </div>

      <div>
        <label className={labelCls}>Notes</label>
        <textarea name="notes" rows={2} className={inputCls} placeholder="Why this version was published…" />
      </div>

      <SubmitButton />
    </form>
  )
}
