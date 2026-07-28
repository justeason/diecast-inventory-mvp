'use client'

import { useActionState } from 'react'
import { adminLinkSubmissionCatalog } from '@/lib/actions/sellerSubmissions'
import { CatalogModelCombobox } from '@/components/admin/CatalogModelCombobox'
import type { SellerSubmissionActionState } from '@/lib/actions/sellerSubmissions'

type Props = {
  submissionId: string
  initialQuery?: string
  currentCatalogLabel?: string
}

const initialState: SellerSubmissionActionState = null

export function SubmissionCatalogLinkForm({ submissionId, initialQuery, currentCatalogLabel }: Props) {
  const action = adminLinkSubmissionCatalog.bind(null, submissionId)
  const [state, formAction, isPending] = useActionState<SellerSubmissionActionState, FormData>(
    action,
    initialState
  )

  return (
    <form action={formAction} className="space-y-3">
      {currentCatalogLabel && (
        <p className="text-xs text-gray-500">
          Current: <span className="font-medium text-gray-700">{currentCatalogLabel}</span>
        </p>
      )}
      <CatalogModelCombobox
        name="catalogId"
        initialQuery={initialQuery}
        placeholder="Search catalog to link…"
      />
      {state?.errors?.catalogId?.[0] && (
        <p className="text-xs text-red-600">{state.errors.catalogId[0]}</p>
      )}
      {state?.errors?.form?.[0] && (
        <p className="text-xs text-red-600">{state.errors.form[0]}</p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
      >
        {isPending ? 'Linking…' : currentCatalogLabel ? 'Update link' : 'Link catalog model'}
      </button>
    </form>
  )
}
