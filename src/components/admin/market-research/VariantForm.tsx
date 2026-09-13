'use client'

import { useActionState } from 'react'
import { assignObservationVariant, type AssignVariantActionState } from '@/lib/actions/externalMarketResearch'

// 21B §16/§36: a small optional classification control for a matched observation.
// "Unclassified" means marketVariantId = null — never a fabricated "Unspecified"
// MarketVariant row. Resolution against the observation's matched CatalogModel
// happens server-side; this form only ever submits a packaging label.
export function VariantForm({
  observationId,
  updatedAt,
  packagingType,
}: {
  observationId: string
  updatedAt: string
  packagingType: string | null
}) {
  const action = assignObservationVariant.bind(null, observationId)
  const [state, formAction, isPending] = useActionState<AssignVariantActionState, FormData>(action, null)

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="updatedAt" value={updatedAt} />
      <label className="text-xs font-medium text-gray-600" htmlFor="packagingType">Packaging</label>
      <select
        id="packagingType"
        name="packagingType"
        defaultValue={packagingType ?? ''}
        className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
      >
        <option value="">Unclassified</option>
        <option value="carded">Carded</option>
        <option value="loose">Loose</option>
      </select>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
      >
        {isPending ? 'Saving…' : 'Save'}
      </button>
      {state?.errors?.['packagingType']?.map(e => (
        <p key={e} className="text-xs text-red-600">{e}</p>
      ))}
      {state?.errors?.['form']?.map(e => (
        <p key={e} className="text-xs text-red-600">{e}</p>
      ))}
    </form>
  )
}
