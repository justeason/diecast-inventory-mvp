'use client'

import { useActionState } from 'react'
import { importMarketDataCsv, type ImportActionState } from '@/lib/actions/externalMarketResearch'

export function ImportForm() {
  const [state, formAction, isPending] = useActionState<ImportActionState, FormData>(
    importMarketDataCsv,
    null,
  )

  return (
    <form action={formAction} encType="multipart/form-data" className="space-y-6 max-w-lg">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Provider name <span className="text-red-500">*</span>
        </label>
        <input
          name="provider"
          type="text"
          placeholder='e.g. "eBay", "StockX"'
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          required
        />
        {state?.errors?.['provider']?.map(e => (
          <p key={e} className="mt-1 text-xs text-red-600">{e}</p>
        ))}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          CSV file <span className="text-red-500">*</span>
        </label>
        <input
          name="file"
          type="file"
          accept=".csv,text/csv"
          className="w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-gray-50"
          required
        />
        <p className="mt-1 text-xs text-gray-400">
          Required columns: title, observation_type, price, currency, total_price
        </p>
        {state?.errors?.['file']?.map(e => (
          <p key={e} className="mt-1 text-xs text-red-600">{e}</p>
        ))}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Admin notes</label>
        <textarea
          name="adminInfo"
          rows={2}
          placeholder="Optional notes about this import"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
      >
        {isPending ? 'Importing…' : 'Import CSV'}
      </button>

      {state?.batchError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.batchError}
        </div>
      )}

      {state?.result && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-green-800">
            Import complete — batch <code className="text-xs">{state.result.batchId}</code>
          </p>
          <div className="text-sm text-green-700 grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span>Rows processed:</span> <span>{state.result.rowCount}</span>
            <span>Imported:</span>       <span>{state.result.importedCount}</span>
            <span>Duplicates:</span>     <span>{state.result.duplicateCount}</span>
            <span>Errors:</span>         <span>{state.result.errorCount}</span>
          </div>
          {state.result.rows.some(r => r.status !== 'imported') && (
            <details className="mt-2">
              <summary className="text-xs text-green-700 cursor-pointer">Row details</summary>
              <div className="mt-2 max-h-64 overflow-y-auto space-y-0.5">
                {state.result.rows
                  .filter(r => r.status !== 'imported')
                  .map(r => (
                    <p key={r.rowIndex} className="text-xs text-gray-600">
                      Row {r.rowIndex}: <span className="font-medium">{r.status}</span>
                      {r.reason ? ` — ${r.reason}` : ''}
                    </p>
                  ))}
              </div>
            </details>
          )}
        </div>
      )}
    </form>
  )
}
