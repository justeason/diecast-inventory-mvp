'use client'

import { useState, useTransition } from 'react'
import {
  bulkRepairTrimWhitespace,
  type BulkRepairRowResult,
} from '@/lib/actions/catalogDataQuality'
import type { IssueRow } from '@/lib/catalogDataQualityQuery'

const BULK_MAX = 50

type Stage = 'idle' | 'confirm' | 'working' | 'done'

export function CatalogBulkRepairPanel({ issues }: { issues: IssueRow[] }) {
  const [selected, setSelected]   = useState<Set<string>>(new Set())
  const [stage, setStage]         = useState<Stage>('idle')
  const [results, setResults]     = useState<BulkRepairRowResult[]>([])
  const [isPending, startTransition] = useTransition()

  const trimIssues  = issues.filter(i => i.repairAction === 'trim_whitespace')

  if (trimIssues.length === 0) return null

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else if (next.size < BULK_MAX) {
        next.add(key)
      }
      return next
    })
  }

  const selectedIssues = trimIssues.filter(i => selected.has(i.issueKey))

  const handleRepair = () => {
    const modelIds = [...new Set(selectedIssues.map(i => i.catalogModelId))]
    setStage('working')
    startTransition(async () => {
      const result = await bulkRepairTrimWhitespace(modelIds, true)
      setResults(result.rows)
      setStage('done')
    })
  }

  const reset = () => { setStage('idle'); setSelected(new Set()); setResults([]) }

  return (
    <div className="space-y-3 pt-2">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Bulk Repair</h2>

      {stage === 'done' ? (
        <div className="space-y-2">
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {results.map(r => (
              <div key={r.catalogModelId + r.status} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <span className={`font-medium shrink-0 ${r.status === 'repaired' ? 'text-green-600' : r.status === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
                  {r.status}
                </span>
                <span className="font-mono text-gray-600">{r.catalogModelId.slice(0, 8)}…</span>
                {r.detail && <span className="text-gray-400">{r.detail}</span>}
              </div>
            ))}
          </div>
          <button onClick={reset} className="text-xs text-blue-600 hover:underline">
            Reset
          </button>
        </div>
      ) : stage === 'confirm' ? (
        <div className="space-y-3">
          <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm">
            <p className="font-medium text-amber-800 mb-2">
              Confirm trim-whitespace repair on {selectedIssues.length} issue{selectedIssues.length !== 1 ? 's' : ''}:
            </p>
            <ul className="space-y-0.5 max-h-48 overflow-y-auto">
              {selectedIssues.slice(0, 30).map(i => (
                <li key={i.issueKey} className="text-xs text-amber-700">
                  <span className="font-mono">{i.catalogModel.brand} · {i.catalogModel.name}</span>
                  {i.repairPreview && <span className="text-amber-600 ml-2">{i.repairPreview}</span>}
                </li>
              ))}
              {selectedIssues.length > 30 && (
                <li className="text-xs text-amber-500">…and {selectedIssues.length - 30} more</li>
              )}
            </ul>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleRepair}
              disabled={isPending}
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPending ? 'Repairing…' : 'Confirm Repair'}
            </button>
            <button
              onClick={() => setStage('idle')}
              disabled={isPending}
              className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
            {trimIssues.slice(0, BULK_MAX).map(issue => {
              const isSelected = selected.has(issue.issueKey)
              return (
                <label key={issue.issueKey} className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(issue.issueKey)}
                    className="mt-0.5 shrink-0"
                    disabled={!isSelected && selected.size >= BULK_MAX}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-400 font-mono">{issue.issueType}</p>
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {issue.catalogModel.brand} · {issue.catalogModel.name}
                    </p>
                    {issue.repairPreview && (
                      <p className="text-xs text-blue-600 font-mono mt-0.5 truncate">{issue.repairPreview}</p>
                    )}
                  </div>
                </label>
              )
            })}
          </div>
          {trimIssues.length > BULK_MAX && (
            <p className="text-xs text-gray-400">Showing first {BULK_MAX} repairable issues.</p>
          )}
          {selected.size > 0 && (
            <div className="flex items-center gap-4">
              <span className="text-xs text-gray-500">
                {selected.size} selected (max {BULK_MAX})
              </span>
              <button
                onClick={() => setStage('confirm')}
                className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Repair Selected ({selected.size}) →
              </button>
              <button
                onClick={reset}
                className="text-xs text-gray-400 hover:text-gray-700"
              >
                Clear
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
