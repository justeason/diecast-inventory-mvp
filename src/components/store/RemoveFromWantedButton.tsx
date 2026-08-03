'use client'

import { removeFromWantedList } from '@/lib/actions/wantedList'

export function RemoveFromWantedButton({ id }: { id: string }) {
  const action = removeFromWantedList.bind(null, id)
  return (
    <form
      action={action}
      onSubmit={e => {
        if (!window.confirm('Remove this model from your wanted list?')) e.preventDefault()
      }}
    >
      <button type="submit" className="text-xs text-red-500 hover:text-red-700 transition-colors">
        Remove
      </button>
    </form>
  )
}
