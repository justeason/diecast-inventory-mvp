'use client'

import { deleteCollectionItem } from '@/lib/actions/collectionItems'

export function ConfirmDeleteItemButton({ id }: { id: string }) {
  const action = deleteCollectionItem.bind(null, id)
  return (
    <form
      action={action}
      onSubmit={e => {
        if (!window.confirm('Permanently delete this item and all its photos? This cannot be undone.')) e.preventDefault()
      }}
    >
      <button
        type="submit"
        className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
      >
        Delete item
      </button>
    </form>
  )
}
