'use client'

import { toggleWantedAlertAction } from '@/lib/actions/buyerAlerts'

export function WantedAlertToggle({
  id,
  field,
  enabled,
  label,
}: {
  id: string
  field: 'availabilityAlertEnabled' | 'priceAlertEnabled'
  enabled: boolean
  label: string
}) {
  const action = toggleWantedAlertAction.bind(null, id, field)
  return (
    <form action={action}>
      <button
        type="submit"
        className={`text-xs rounded-full px-2 py-0.5 border transition-colors ${
          enabled
            ? 'border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200'
            : 'border-gray-200 bg-white text-gray-400 hover:bg-gray-50'
        }`}
        title={enabled ? `${label} alerts on — click to turn off` : `${label} alerts off — click to turn on`}
      >
        {label}: {enabled ? 'on' : 'off'}
      </button>
    </form>
  )
}
