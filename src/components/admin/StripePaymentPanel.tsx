'use client'

import { useActionState, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import {
  createAndSendStripeCheckoutSession,
  expireStripeSession,
  resendStripePaymentEmail,
  type StripeActionState,
} from '@/lib/actions/stripe'

// ─── Sub-buttons ──────────────────────────────────────────────────────────────

function GenerateButton({ disabled, disabledReason }: { disabled: boolean; disabledReason?: string }) {
  const { pending } = useFormStatus()
  return (
    <div>
      <button
        type="submit"
        disabled={pending || disabled}
        title={disabled ? disabledReason : undefined}
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white
                   hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? 'Generating…' : 'Generate & Send Payment Link'}
      </button>
      {disabled && disabledReason && (
        <p className="mt-1.5 text-xs text-amber-600">{disabledReason}</p>
      )}
    </div>
  )
}

function ExpireButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium
                 text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Expiring…' : 'Expire current payment link'}
    </button>
  )
}

function ResendButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium
                 text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Sending…' : 'Resend payment email'}
    </button>
  )
}

// ─── Copy button (client-only) ────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const ref = useRef<HTMLButtonElement>(null)

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      if (ref.current) {
        ref.current.textContent = 'Copied!'
        setTimeout(() => { if (ref.current) ref.current.textContent = 'Copy' }, 2000)
      }
    })
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={handleCopy}
      className="ml-2 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600
                 hover:bg-gray-100 transition-colors shrink-0"
    >
      Copy
    </button>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  orderId: string
  orderStatus: string
  estimatedShipping: number | null
  paymentStatus: string
  paymentMethod: string | null
  paymentLink: string | null
  stripeSessionId: string | null
  stripeSessionExpiresAt: Date | null
  stripePaymentIntentId: string | null
  paidAt: Date | null
  buyerEmail: string
  subtotal: number
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function StripePaymentPanel({
  orderId,
  orderStatus,
  estimatedShipping,
  paymentStatus,
  paymentMethod,
  paymentLink,
  stripeSessionId,
  stripeSessionExpiresAt,
  stripePaymentIntentId,
  paidAt,
  buyerEmail,
  subtotal,
}: Props) {
  const generateAction = createAndSendStripeCheckoutSession.bind(null, orderId)
  const expireAction   = expireStripeSession.bind(null, orderId)
  const resendAction   = resendStripePaymentEmail.bind(null, orderId)

  const [generateState, generateFormAction] = useActionState<StripeActionState, FormData>(generateAction, null)
  const [expireState,   expireFormAction]   = useActionState<StripeActionState, FormData>(expireAction,   null)
  const [resendState,   resendFormAction]   = useActionState<StripeActionState, FormData>(resendAction,   null)

  const generateErrors = generateState && 'errors' in generateState ? generateState.errors : {}
  const expireErrors   = expireState   && 'errors' in expireState   ? expireState.errors   : {}
  const resendErrors   = resendState   && 'errors' in resendState   ? resendState.errors   : {}
  const resendSuccess  = resendState   && 'success' in resendState

  const isTerminal = orderStatus === 'complete' || orderStatus === 'cancelled'
  const shipping = estimatedShipping ?? null
  const total = shipping !== null ? subtotal + shipping : null
  const isExpired = stripeSessionExpiresAt !== null && stripeSessionExpiresAt < new Date()

  // ── State C: Paid via Stripe ────────────────────────────────────────────────
  if (paymentStatus === 'paid' && paymentMethod === 'stripe') {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 px-4 py-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800">
            Paid via Stripe
          </span>
        </div>
        {paidAt && (
          <p className="text-sm text-gray-700">
            <span className="text-gray-500 mr-2">Paid:</span>
            {paidAt.toLocaleDateString()} at {paidAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
        )}
        {stripePaymentIntentId && (
          <p className="text-sm text-gray-700 mt-1 flex items-center">
            <span className="text-gray-500 mr-2">Reference:</span>
            <span className="font-mono text-xs">{stripePaymentIntentId}</span>
            <CopyButton text={stripePaymentIntentId} />
          </p>
        )}
      </div>
    )
  }

  // ── State B: Active session (possibly expired) ──────────────────────────────
  if (stripeSessionId && paymentLink) {
    return (
      <div className="space-y-3">
        {/* Expired warning replaces the blue info box */}
        {isExpired ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4">
            <p className="text-sm font-medium text-amber-800 mb-1">Payment link appears expired</p>
            <p className="text-xs text-amber-700">
              This payment link appears to be expired. You can expire/clear it manually below and generate a new payment link if needed.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <span className="text-xs text-amber-600 truncate max-w-xs">{paymentLink}</span>
              <CopyButton text={paymentLink} />
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-4">
            <p className="text-sm font-medium text-blue-900 mb-1">
              Payment link sent to {buyerEmail}
            </p>
            {stripeSessionExpiresAt && (
              <p className="text-xs text-blue-700 mb-3">
                Expires: {stripeSessionExpiresAt.toLocaleDateString()} at{' '}
                {stripeSessionExpiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            <div className="flex items-center gap-2">
              <a
                href={paymentLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-700 underline truncate max-w-xs"
              >
                {paymentLink}
              </a>
              <CopyButton text={paymentLink} />
            </div>
          </div>
        )}

        {/* Resend email — only show when session is not expired */}
        {!isExpired && (
          <form action={resendFormAction}>
            <ResendButton />
            {resendErrors.form && (
              <p className="mt-1 text-xs text-red-600">{resendErrors.form[0]}</p>
            )}
            {resendSuccess && (
              <p className="mt-1 text-xs text-green-700">Email resent to {buyerEmail}.</p>
            )}
          </form>
        )}

        {/* Expire */}
        <form action={expireFormAction}>
          <ExpireButton />
          {expireErrors.form && (
            <p className="mt-1 text-xs text-red-600">{expireErrors.form[0]}</p>
          )}
        </form>
      </div>
    )
  }

  // ── State A: No active session ──────────────────────────────────────────────

  if (isTerminal || paymentStatus === 'paid') {
    return null
  }

  const missingShipping = shipping === null
  const disabledReason = missingShipping
    ? 'Enter estimated shipping first (use 0 for free shipping).'
    : undefined

  return (
    <div className="space-y-3">
      {total !== null && (
        <p className="text-sm text-gray-600">
          Will charge:{' '}
          <strong className="text-gray-900">${total.toFixed(2)}</strong>
          <span className="text-gray-400 text-xs ml-1">
            (${subtotal.toFixed(2)} items
            {shipping !== null && shipping > 0 ? ` + $${shipping.toFixed(2)} shipping` : shipping === 0 ? ' + free shipping' : ''})
          </span>
        </p>
      )}

      <form action={generateFormAction}>
        <GenerateButton disabled={missingShipping} disabledReason={disabledReason} />
        {generateErrors.form && (
          <p className="mt-1.5 text-xs text-red-600">{generateErrors.form[0]}</p>
        )}
      </form>

      <p className="text-xs text-gray-400">
        Creates a Stripe Checkout Session and emails the buyer a payment link.
        The link expires in 23 hours.
      </p>
    </div>
  )
}
