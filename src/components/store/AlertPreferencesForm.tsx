'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { updateAlertPreferences, type BuyerAlertActionState } from '@/lib/actions/buyerAlerts'
import type { ResolvedAlertPreference } from '@/lib/buyerAlertsQuery'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? 'Saving…' : 'Save preferences'}
    </button>
  )
}

export function AlertPreferencesForm({ preference }: { preference: ResolvedAlertPreference }) {
  const [state, formAction] = useActionState<BuyerAlertActionState, FormData>(updateAlertPreferences, null)
  const errors = state && 'errors' in state ? state.errors : {}

  return (
    <form action={formAction} className="rounded-md border border-gray-200 bg-gray-50 px-4 py-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-900">Alert preferences</h2>

      {errors._form && <p className="text-xs text-red-600">{errors._form[0]}</p>}

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          name="wantedAvailableAlerts"
          defaultChecked={preference.wantedAvailableAlerts}
          className="rounded border-gray-300"
        />
        Notify me when a wanted model becomes available
      </label>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          name="wantedPriceChangeAlerts"
          defaultChecked={preference.wantedPriceChangeAlerts}
          className="rounded border-gray-300"
        />
        Notify me when the price of an available wanted model changes
      </label>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          name="emailAlertsEnabled"
          defaultChecked={preference.emailAlertsEnabled}
          className="rounded border-gray-300"
        />
        Send these alerts by email (always shown in-app either way)
      </label>

      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Minimum price change to notify about (%)
        </label>
        <input
          type="number"
          name="priceChangeThresholdPct"
          min={1}
          max={100}
          step={1}
          defaultValue={preference.priceChangeThresholdPct ?? ''}
          placeholder="Default: 5%"
          className="w-32 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        />
        {errors.priceChangeThresholdPct && (
          <p className="mt-1 text-xs text-red-600">{errors.priceChangeThresholdPct[0]}</p>
        )}
      </div>

      <SubmitButton />
    </form>
  )
}
