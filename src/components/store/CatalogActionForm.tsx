'use client'

import { useActionState } from 'react'
import { PendingActionButton } from './PendingActionButton'
import type { CatalogModelActionState } from '@/lib/actions/catalogModelDomainActions'

type Props = {
  // The already-bound server action (e.g. wantAction.bind(null, model.id)) —
  // identical to what every existing plain <form action={...}> caller already
  // passes today. Wrapped internally below to fit useActionState's 2-arg
  // (prevState, payload) contract; that wrapping stays entirely client-side, so
  // `action` itself never needs to be reshaped by the Server Component caller.
  action: (formData: FormData) => Promise<CatalogModelActionState>
  label: string
  pendingLabel: string
  ariaLabel: string
  className: string
}

// 37B: wraps the existing Want/Unwant/Own server actions (now returning
// CatalogModelActionState instead of void) with useActionState, so a genuine
// mutation rejection surfaces as visible, retryable text instead of being
// silently discarded. Pending/disabled state still comes from
// PendingActionButton's own useFormStatus (unchanged) — resubmitting after a
// shown error re-runs the SAME action via the SAME form, no separate retry
// path to keep in sync. Never optimistic: the button's own Want/Owned label
// state is driven entirely by the caller's server-rendered `relationship`
// prop (CatalogModelCard), not by this component's local action state.
export function CatalogActionForm({ action, label, pendingLabel, ariaLabel, className }: Props) {
  const [state, formAction] = useActionState<CatalogModelActionState, FormData>(
    (_prevState, formData) => action(formData),
    null,
  )
  return (
    <form action={formAction}>
      <PendingActionButton label={label} pendingLabel={pendingLabel} ariaLabel={ariaLabel} className={className} />
      {state?.errors?._form && (
        <p role="alert" className="mt-1 text-xs text-red-600">{state.errors._form[0]}</p>
      )}
    </form>
  )
}
