'use client'

import { removeFromWantedList } from '@/lib/actions/wantedList'

export function RemoveFromWantedButton({ id, modelName }: { id: string; modelName: string }) {
  const action = removeFromWantedList.bind(null, id)
  return (
    <form
      action={action}
      onSubmit={e => {
        if (!window.confirm(`Remove ${modelName} from your wanted list?`)) e.preventDefault()
      }}
    >
      <button
        type="submit"
        aria-label={`Remove ${modelName} from Wanted`}
        className="text-xs text-red-500 hover:text-red-700 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
      >
        Remove from Wanted
      </button>
    </form>
  )
}
