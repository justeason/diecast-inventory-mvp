'use client'

import { useFormStatus } from 'react-dom'

// 16G: presentation-only pending state for the existing Server Action forms
// (Want/Unwant/Add to Collection) — same useFormStatus idiom already used by
// SellItemForm/ManualSellRequestForm/AlertPreferencesForm's SubmitButton. Prevents
// a rapid double-click from submitting the same mutation twice. No optimistic
// domain state — the button just disables itself; server-rendered relationship
// state (after the action's revalidation) remains the sole source of truth.
export function PendingActionButton({
  label,
  pendingLabel,
  ariaLabel,
  className,
}: {
  label: string
  pendingLabel: string
  ariaLabel: string
  className: string
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={ariaLabel}
      className={`${className} disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {pending ? pendingLabel : label}
    </button>
  )
}
