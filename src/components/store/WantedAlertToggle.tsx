'use client'

import { setWantedAlertAction } from '@/lib/actions/buyerAlerts'

export function WantedAlertToggle({
  id,
  field,
  enabled,
  label,
  modelName,
}: {
  id: string
  field: 'availabilityAlertEnabled' | 'priceAlertEnabled'
  enabled: boolean
  label: string
  modelName: string
}) {
  // Desired-state action bound at render time from the last known server state —
  // not a blind server-side negate — so repeated clicks/retries converge on the
  // same final value (16D Part F/14).
  const action = setWantedAlertAction.bind(null, id, field, !enabled)
  return (
    <form action={action}>
      <button
        type="submit"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()} alerts for ${modelName}`}
        className={`text-xs rounded-full px-2 py-0.5 border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
          enabled
            ? 'border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200'
            : 'border-gray-200 bg-white text-gray-400 hover:bg-gray-50'
        }`}
        title={enabled ? `${label} alerts on — click to turn off` : `${label} alerts off — click to turn on`}
      >
        {label}: {enabled ? 'On' : 'Off'}
      </button>
    </form>
  )
}
