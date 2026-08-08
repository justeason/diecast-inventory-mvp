'use client'

import { useState, useTransition } from 'react'
import { repairTrimWhitespace, repairNullEmptyOptionals } from '@/lib/actions/catalogDataQuality'
import type { DataQualityIssue } from '@/lib/catalogDataQuality'

type Props = {
  catalogModelId: string
  updatedAt:      string
  issues:         DataQualityIssue[]
}

type RepairState = 'idle' | 'confirm' | 'working' | 'done' | 'error'

function RepairButton({
  label,
  preview,
  onConfirm,
}: {
  label:      string
  preview:    string
  onConfirm:  () => Promise<{ ok: boolean; error?: string }>
}) {
  const [state,    setState]    = useState<RepairState>('idle')
  const [errMsg,   setErrMsg]   = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleConfirm() {
    setState('working')
    startTransition(async () => {
      const result = await onConfirm()
      if (result.ok) {
        setState('done')
      } else {
        setErrMsg(result.error ?? 'Repair failed.')
        setState('error')
      }
    })
  }

  if (state === 'done') {
    return (
      <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
        Repair applied and audited.
      </div>
    )
  }

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 space-y-2">
      <p className="text-sm font-medium text-gray-900">{label}</p>
      <p className="text-xs font-mono text-blue-700">{preview}</p>

      {state === 'error' && (
        <p className="text-xs text-red-600">{errMsg}</p>
      )}

      {state === 'idle' || state === 'error' ? (
        <button
          onClick={() => setState('confirm')}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          Preview repair
        </button>
      ) : state === 'confirm' ? (
        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            disabled={isPending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Confirm repair
          </button>
          <button
            onClick={() => setState('idle')}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className="text-xs text-gray-400">Applying…</p>
      )}
    </div>
  )
}

export function CatalogQualityRepairForms({ catalogModelId, updatedAt, issues }: Props) {
  const hasWhitespace = issues.some(i => i.repairAction === 'trim_whitespace')
  const hasNullOpts   = false // null_empty_optionals is a separate manual trigger

  const whitespaceIssues = issues
    .filter(i => i.repairAction === 'trim_whitespace')
    .map(i => i.repairPreview)
    .filter(Boolean)
    .join(' | ')

  return (
    <div className="space-y-3">
      {hasWhitespace && (
        <RepairButton
          label="Trim whitespace and remove control characters"
          preview={whitespaceIssues || 'Normalize brand, name, and series text fields.'}
          onConfirm={() => repairTrimWhitespace(catalogModelId, updatedAt)}
        />
      )}

      <RepairButton
        label="Null out empty optional strings"
        preview='Set empty series, color, scale, notes to null instead of empty string "".'
        onConfirm={() => repairNullEmptyOptionals(catalogModelId, updatedAt)}
      />

      {hasNullOpts && null /* already in above */}
    </div>
  )
}
