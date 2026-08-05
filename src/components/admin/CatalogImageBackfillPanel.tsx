'use client'

import { useActionState } from 'react'
import { generateFingerprintBatch, type BackfillState } from '@/lib/actions/catalogImageBackfill'

export function CatalogImageBackfillPanel() {
  const [state, formAction, isPending] = useActionState<BackfillState, FormData>(
    generateFingerprintBatch,
    null,
  )

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Backfill fingerprints</h2>
        <form action={formAction}>
          <button
            type="submit"
            disabled={isPending || state?.hasMore === false && state?.processed === 0}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-40"
          >
            {isPending ? 'Processing…' : 'Generate next batch (25)'}
          </button>
        </form>
      </div>

      {state && (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-3 text-center">
            {[
              { label: 'Processed', value: state.processed },
              { label: 'Succeeded', value: state.succeeded, cls: 'text-green-700' },
              { label: 'Failed',    value: state.failed,    cls: state.failed    > 0 ? 'text-red-700'    : undefined },
              { label: 'Skipped',  value: state.skipped,   cls: state.skipped   > 0 ? 'text-yellow-700' : undefined },
            ].map(({ label, value, cls }) => (
              <div key={label} className="rounded-md bg-gray-50 p-2">
                <p className={`text-lg font-semibold ${cls ?? 'text-gray-900'}`}>{value}</p>
                <p className="text-xs text-gray-500">{label}</p>
              </div>
            ))}
          </div>

          {state.processed > 0 && !state.hasMore && (
            <p className="text-xs text-green-700 font-medium">All photos fingerprinted.</p>
          )}
          {state.hasMore && (
            <p className="text-xs text-gray-500">More photos remain — click again to continue.</p>
          )}

          {state.errors.length > 0 && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 space-y-1">
              <p className="text-xs font-medium text-red-700">Errors ({state.errors.length})</p>
              <ul className="space-y-0.5">
                {state.errors.map((err, i) => (
                  <li key={i} className="text-xs text-red-600 font-mono">{err}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
