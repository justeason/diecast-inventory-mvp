'use client'

import { markAlertReadAction, markAllAlertsReadAction } from '@/lib/actions/buyerAlerts'

export function MarkAlertReadButton({ id }: { id: string }) {
  const action = markAlertReadAction.bind(null, id)
  return (
    <form action={action}>
      <button type="submit" className="text-xs text-gray-500 hover:text-gray-900 transition-colors">
        Mark read
      </button>
    </form>
  )
}

export function MarkAllAlertsReadButton() {
  return (
    <form action={markAllAlertsReadAction}>
      <button type="submit" className="text-xs text-gray-500 hover:text-gray-900 underline underline-offset-2 transition-colors">
        Mark all read
      </button>
    </form>
  )
}
