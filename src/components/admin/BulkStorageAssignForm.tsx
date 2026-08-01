'use client'

import { useActionState, useState } from 'react'
import { bulkAssignIntakeStorage } from '@/lib/actions/intakeOperations'
import { StorageLocationCombobox } from './StorageLocationCombobox'

type IntakeRow = { id: string; label: string }

type Props = {
  intakes: IntakeRow[]
}

export function BulkStorageAssignForm({ intakes }: Props) {
  const [state, action, pending] = useActionState(bulkAssignIntakeStorage, null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === intakes.length ? new Set() : new Set(intakes.map((i) => i.id))
    )
  }

  return (
    <form action={action} className="space-y-3">
      {state?.errors?.form && (
        <p className="text-sm text-red-600">{state.errors.form[0]}</p>
      )}

      <div className="rounded-md border border-gray-200 divide-y divide-gray-100 bg-white">
        <div className="flex items-center gap-3 px-3 py-2 bg-gray-50">
          <input
            type="checkbox"
            checked={selected.size === intakes.length && intakes.length > 0}
            onChange={toggleAll}
            className="rounded"
          />
          <span className="text-xs font-medium text-gray-600">
            {selected.size} of {intakes.length} selected
          </span>
        </div>
        {intakes.map((intake) => (
          <label key={intake.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              name="intakeId"
              value={intake.id}
              checked={selected.has(intake.id)}
              onChange={() => toggle(intake.id)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">{intake.label}</span>
          </label>
        ))}
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Assign to location</label>
        <StorageLocationCombobox name="storageLocationId" />
        {state?.errors?.storageLocationId && (
          <p className="text-xs text-red-600 mt-1">{state.errors.storageLocationId[0]}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending || selected.size === 0}
        className="px-4 py-1.5 rounded-md bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 disabled:opacity-50"
      >
        {pending ? 'Assigning…' : `Assign storage (${selected.size})`}
      </button>
    </form>
  )
}
