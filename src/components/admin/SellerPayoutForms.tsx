'use client'

import { useActionState } from 'react'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'
import {
  holdSellerPayoutLine,
  releaseSellerPayoutLine,
  voidSellerPayoutLine,
  createSellerPayout,
  removeLineFromDraftPayout,
  approveSellerPayout,
  markSellerPayoutPaid,
  ensureBuyoutPayoutLineForAgreement,
  type PayoutLineActionState,
  type PayoutActionState,
  type EnsureBuyoutPayoutLineActionState,
} from '@/lib/actions/sellerPayouts'
import { ALLOWED_PAYMENT_METHODS } from '@/lib/sellerPayoutCalculation'

// ─── Hold ─────────────────────────────────────────────────────────────────────

export function HoldLineForm({ lineId }: { lineId: string }) {
  const action = holdSellerPayoutLine.bind(null, lineId)
  const [state, formAction, isPending] = useActionState<PayoutLineActionState, FormData>(action, null)
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input
        name="holdReason"
        placeholder="Hold reason…"
        required
        className="text-xs border border-gray-300 rounded px-2 py-1 w-36"
      />
      {state && 'errors' in state && (
        <p className="text-xs text-red-600">{Object.values(state.errors).flat()[0]}</p>
      )}
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Holding…' : 'Hold'}
      </Button>
    </form>
  )
}

// ─── Release ──────────────────────────────────────────────────────────────────

export function ReleaseLineForm({ lineId }: { lineId: string }) {
  const action = releaseSellerPayoutLine.bind(null, lineId)
  const [state, formAction, isPending] = useActionState<PayoutLineActionState, FormData>(action, null)
  return (
    <form action={formAction}>
      {state && 'errors' in state && (
        <p className="text-xs text-red-600 mb-1">{Object.values(state.errors).flat()[0]}</p>
      )}
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Releasing…' : 'Release'}
      </Button>
    </form>
  )
}

// ─── Void ─────────────────────────────────────────────────────────────────────

export function VoidLineForm({ lineId }: { lineId: string }) {
  const action = voidSellerPayoutLine.bind(null, lineId)
  const [state, formAction, isPending] = useActionState<PayoutLineActionState, FormData>(action, null)
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input
        name="voidReason"
        placeholder="Void reason…"
        required
        className="text-xs border border-gray-300 rounded px-2 py-1 w-36"
      />
      {state && 'errors' in state && (
        <p className="text-xs text-red-600">{Object.values(state.errors).flat()[0]}</p>
      )}
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Voiding…' : 'Void'}
      </Button>
    </form>
  )
}

// ─── Create payout batch ──────────────────────────────────────────────────────

type EligibleLineRow = {
  id: string
  lineType: string
  netAmount: string
  eligibleAt: Date
  submissionId: string | null
  orderId: string | null
}

export function CreatePayoutForm({
  lines,
  sellerProfileId,
  canCreate,
}: {
  lines: EligibleLineRow[]
  sellerProfileId: string | null
  canCreate: boolean
}) {
  const [state, formAction, isPending] = useActionState<PayoutActionState, FormData>(createSellerPayout, null)

  return (
    <form action={formAction} className="space-y-3">
      {sellerProfileId && <input type="hidden" name="sellerProfileId" value={sellerProfileId} />}

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-gray-500">
              <th className="px-3 py-2 font-medium w-10">
                <span className="sr-only">Select</span>
              </th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Link</th>
              <th className="px-3 py-2 font-medium">Eligible</th>
              <th className="px-3 py-2 font-medium text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {lines.map((line) => (
              <tr key={line.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    name="lineIds"
                    value={line.id}
                    defaultChecked
                    disabled={!canCreate}
                    className="rounded border-gray-300"
                  />
                </td>
                <td className="px-3 py-2 capitalize text-gray-700">{line.lineType}</td>
                <td className="px-3 py-2 text-xs text-blue-600">
                  {line.submissionId ? (
                    <a href={`/admin/seller-submissions/${line.submissionId}/agreement`} className="hover:underline">
                      Agreement
                    </a>
                  ) : line.orderId ? (
                    <a href={`/admin/orders/${line.orderId}`} className="hover:underline">
                      Order
                    </a>
                  ) : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-gray-400">{line.eligibleAt.toLocaleDateString()}</td>
                <td className="px-3 py-2 font-mono font-medium text-gray-900 text-right">
                  ${parseFloat(line.netAmount).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {state && 'errors' in state && (
        <p className="text-sm text-red-600">{Object.values(state.errors).flat()[0]}</p>
      )}

      {canCreate ? (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating…' : 'Create payout batch'}
          </Button>
          <input
            name="adminNotes"
            placeholder="Admin notes (optional)"
            className="text-sm border border-gray-300 rounded px-2 py-1 flex-1 max-w-xs"
          />
        </div>
      ) : (
        <p className="text-xs text-gray-400">Batching unavailable — active SellerProfile required.</p>
      )}
    </form>
  )
}

// ─── Remove line from draft payout ────────────────────────────────────────────

export function RemoveLineForm({ payoutId, lineId }: { payoutId: string; lineId: string }) {
  const action = removeLineFromDraftPayout.bind(null, payoutId, lineId)
  const [state, formAction, isPending] = useActionState<PayoutActionState, FormData>(action, null)
  return (
    <form action={formAction}>
      {state && 'errors' in state && (
        <p className="text-xs text-red-600 mb-1">{Object.values(state.errors).flat()[0]}</p>
      )}
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Removing…' : 'Remove'}
      </Button>
    </form>
  )
}

// ─── Approve payout ───────────────────────────────────────────────────────────

export function ApprovePayoutForm({ payoutId }: { payoutId: string }) {
  const action = approveSellerPayout.bind(null, payoutId)
  const [state, formAction, isPending] = useActionState<PayoutActionState, FormData>(action, null)
  return (
    <form action={formAction}>
      {state && 'errors' in state && (
        <p className="text-sm text-red-600 mb-2">{Object.values(state.errors).flat()[0]}</p>
      )}
      <Button type="submit" disabled={isPending}>
        {isPending ? 'Approving…' : 'Approve payout'}
      </Button>
      <p className="text-xs text-gray-500 mt-2">
        Approval locks the payout composition. This does not send any payment.
      </p>
    </form>
  )
}

// ─── Mark paid ────────────────────────────────────────────────────────────────

const PAYMENT_METHOD_OPTIONS = ALLOWED_PAYMENT_METHODS.map((m) => ({
  value: m,
  label: m.charAt(0).toUpperCase() + m.slice(1),
}))

export function MarkPayoutPaidForm({ payoutId }: { payoutId: string }) {
  const action = markSellerPayoutPaid.bind(null, payoutId)
  const [state, formAction, isPending] = useActionState<PayoutActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}
  return (
    <form action={formAction} className="space-y-4 max-w-sm">
      <Select
        label="Payment method"
        name="paymentMethod"
        required
        options={PAYMENT_METHOD_OPTIONS}
        error={errors.paymentMethod?.[0]}
      />
      <Input
        label="Payment reference"
        name="paymentReference"
        required
        placeholder="e.g. transaction ID, cheque number"
        error={errors.paymentReference?.[0]}
      />
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm that payment was sent externally. This records the payment — no transfer is executed.
      </label>
      {errors._form && <p className="text-sm text-red-600">{errors._form[0]}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? 'Recording…' : 'Mark as paid'}
      </Button>
    </form>
  )
}

// ─── Generate missing buyout payout eligibility (legacy reconciliation) ──────

export function GenerateBuyoutEligibilityForm({ agreementId }: { agreementId: string }) {
  const action = ensureBuyoutPayoutLineForAgreement.bind(null, agreementId)
  const [state, formAction, isPending] = useActionState<EnsureBuyoutPayoutLineActionState, FormData>(action, null)
  return (
    <form action={formAction}>
      {state && 'errors' in state && (
        <p className="text-xs text-red-600 mb-1">{Object.values(state.errors).flat()[0]}</p>
      )}
      {state && 'success' in state && state.success && (
        <p className="text-xs text-green-700 mb-1">
          {state.created
            ? 'Buyout eligibility record created.'
            : 'Eligibility record already exists — no duplicate created.'}
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Generating…' : 'Generate missing buyout eligibility'}
      </Button>
    </form>
  )
}

// ─── Hold line from inline context (e.g. order detail) ───────────────────────

export { HoldLineForm as InlineHoldLineForm }
