'use client'

import { useActionState } from 'react'
import { repairReconciliationIssue } from '@/lib/actions/operationalReconciliation'
import type { RepairType } from '@/lib/operationalReconciliation'
import type { RepairActionState } from '@/lib/actions/operationalReconciliation'

type Props = {
  issueKey: string
  repairType: RepairType
  entityType: string
  entityId: string
  extraFields: Record<string, string>
}

export function ReconciliationRepairForm({
  issueKey,
  repairType,
  entityType,
  entityId,
  extraFields,
}: Props) {
  const [state, action, isPending] = useActionState<RepairActionState, FormData>(
    repairReconciliationIssue,
    null,
  )

  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="repairType" value={repairType} />
      <input type="hidden" name="issueKey" value={issueKey} />
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      {Object.entries(extraFields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      {state && 'errors' in state && (
        <div className="mb-2 rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {Object.values(state.errors).flat().join(' ')}
        </div>
      )}
      {state && 'success' in state && (
        <div className="mb-2 rounded bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-700">
          {state.message}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center rounded px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isPending ? 'Repairing…' : 'Repair'}
      </button>
    </form>
  )
}
