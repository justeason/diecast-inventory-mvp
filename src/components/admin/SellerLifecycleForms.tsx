'use client'

import { useActionState } from 'react'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'
import {
  rejectSellerIntake,
  openPostSaleSellerCase,
  recordSellerReturnShipment,
  markSellerItemReturned,
  resolveSellerLifecycleCase,
  cancelSellerLifecycleCase,
  recordSellerWithdrawal,
  expireConsignment,
  type LifecycleActionState,
} from '@/lib/actions/sellerLifecycle'

function errorsOf(state: LifecycleActionState): Record<string, string[]> {
  return state && 'errors' in state ? state.errors : {}
}

function FormError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <p className="text-sm text-red-600">{msg}</p>
}

function SuccessNote({ state, text }: { state: LifecycleActionState; text: string }) {
  if (!(state && 'success' in state && state.success)) return null
  return <p className="text-sm text-green-700">{text}</p>
}

const textareaClass =
  'rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900'

const confirmLabel = 'flex items-center gap-2 text-sm text-gray-700'

// ─── Reject intake ──────────────────────────────────────────────────────────────

export function RejectIntakeForm({ intakeDraftId }: { intakeDraftId: string }) {
  const action = rejectSellerIntake.bind(null, intakeDraftId)
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(action, null)
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Internal rejection reason</label>
        <textarea name="rejectionReason" rows={2} required className={textareaClass} />
        <FormError msg={errors.rejectionReason?.[0]} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Seller-facing reason</label>
        <textarea name="sellerRejectionReason" rows={2} required className={textareaClass} />
        <FormError msg={errors.sellerRejectionReason?.[0]} />
      </div>
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm this intake should be rejected.
      </label>
      <FormError msg={errors._form?.[0]} />
      <SuccessNote state={state} text="Intake rejected." />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Rejecting…' : 'Reject intake'}
      </Button>
    </form>
  )
}

// ─── Open post-sale case ────────────────────────────────────────────────────────

const POST_SALE_TYPE_OPTIONS = [
  { value: 'buyer_return', label: 'Buyer return' },
  { value: 'buyer_dispute', label: 'Buyer dispute' },
  { value: 'lost_or_damaged', label: 'Lost or damaged' },
  { value: 'other', label: 'Other' },
]

export function OpenPostSaleCaseForm({
  sellerSubmissionId,
  orderItemId,
  lineStatus,
  payoutStatus,
}: {
  sellerSubmissionId: string
  orderItemId: string
  lineStatus?: string | null
  payoutStatus?: string | null
}) {
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(
    openPostSaleSellerCase,
    null,
  )
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <input type="hidden" name="sellerSubmissionId" value={sellerSubmissionId} />
      <input type="hidden" name="orderItemId" value={orderItemId} />
      {(lineStatus || payoutStatus) && (
        <p className="text-xs text-gray-500">
          Payout line status: {lineStatus ?? 'none'}
          {payoutStatus ? ` · payout: ${payoutStatus}` : ''}
        </p>
      )}
      <Select
        label="Case type"
        name="caseType"
        required
        options={POST_SALE_TYPE_OPTIONS}
        placeholder="Select a case type"
        error={errors.caseType?.[0]}
      />
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Seller message (optional)</label>
        <textarea name="sellerMessage" rows={2} className={textareaClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Admin notes (optional)</label>
        <textarea name="adminNotes" rows={2} className={textareaClass} />
      </div>
      <label className={confirmLabel}>
        <input type="checkbox" name="sellerVisible" className="rounded border-gray-300" />
        Make this case visible to the seller.
      </label>
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm opening this case (this may place a hold on the related payout).
      </label>
      <FormError msg={errors._form?.[0]} />
      <FormError msg={errors.orderItemId?.[0]} />
      <SuccessNote state={state} text="Case opened." />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Opening…' : 'Open case'}
      </Button>
    </form>
  )
}

// ─── Record return shipment ─────────────────────────────────────────────────────

export function RecordReturnShipmentForm({ caseId }: { caseId: string }) {
  const action = recordSellerReturnShipment.bind(null, caseId)
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(action, null)
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <Input label="Carrier" name="carrier" required error={errors.carrier?.[0]} />
      <Input label="Tracking number" name="trackingNumber" required error={errors.trackingNumber?.[0]} />
      <Input label="Shipped date" name="shippedAt" type="date" required error={errors.shippedAt?.[0]} />
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Seller message (optional)</label>
        <textarea name="sellerMessage" rows={2} className={textareaClass} />
      </div>
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm the return has shipped.
      </label>
      <FormError msg={errors._form?.[0]} />
      <SuccessNote state={state} text="Return shipment recorded." />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Saving…' : 'Record return shipment'}
      </Button>
    </form>
  )
}

// ─── Mark item returned ─────────────────────────────────────────────────────────

export function MarkItemReturnedForm({ caseId }: { caseId: string }) {
  const action = markSellerItemReturned.bind(null, caseId)
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(action, null)
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <Input label="Returned date" name="returnedAt" type="date" required error={errors.returnedAt?.[0]} />
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Resolution summary</label>
        <textarea name="resolutionSummary" rows={2} required className={textareaClass} />
        <FormError msg={errors.resolutionSummary?.[0]} />
      </div>
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm the item was received back. This archives the listing and marks the item not for sale.
      </label>
      <FormError msg={errors._form?.[0]} />
      <SuccessNote state={state} text="Item marked returned." />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Saving…' : 'Mark item returned'}
      </Button>
    </form>
  )
}

// ─── Resolve case ───────────────────────────────────────────────────────────────

export function ResolveCaseForm({ caseId, sellerVisible }: { caseId: string; sellerVisible: boolean }) {
  const action = resolveSellerLifecycleCase.bind(null, caseId)
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(action, null)
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Resolution summary</label>
        <textarea name="resolutionSummary" rows={2} required className={textareaClass} />
        <FormError msg={errors.resolutionSummary?.[0]} />
      </div>
      {sellerVisible && (
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Seller message (optional)</label>
          <textarea name="sellerMessage" rows={2} className={textareaClass} />
        </div>
      )}
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm resolving this case. This does not release any payout hold — do that separately.
      </label>
      <FormError msg={errors._form?.[0]} />
      <SuccessNote state={state} text="Case resolved." />
      <Button type="submit" disabled={isPending}>
        {isPending ? 'Resolving…' : 'Resolve case'}
      </Button>
    </form>
  )
}

// ─── Cancel case ────────────────────────────────────────────────────────────────

export function CancelCaseForm({ caseId }: { caseId: string }) {
  const action = cancelSellerLifecycleCase.bind(null, caseId)
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(action, null)
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Cancel reason</label>
        <textarea name="cancelReason" rows={2} required className={textareaClass} />
        <FormError msg={errors.cancelReason?.[0]} />
      </div>
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm cancelling this case.
      </label>
      <FormError msg={errors._form?.[0]} />
      <SuccessNote state={state} text="Case cancelled." />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Cancelling…' : 'Cancel case'}
      </Button>
    </form>
  )
}

// ─── Record withdrawal ──────────────────────────────────────────────────────────

export function RecordWithdrawalForm({
  sellerSubmissionId,
  itemInstanceId,
}: {
  sellerSubmissionId: string
  itemInstanceId?: string
}) {
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(
    recordSellerWithdrawal,
    null,
  )
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <input type="hidden" name="sellerSubmissionId" value={sellerSubmissionId} />
      {itemInstanceId && <input type="hidden" name="itemInstanceId" value={itemInstanceId} />}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Admin notes</label>
        <textarea name="adminNotes" rows={2} required className={textareaClass} />
        <FormError msg={errors.adminNotes?.[0]} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Seller-facing summary</label>
        <textarea name="sellerSummary" rows={2} required className={textareaClass} />
        <FormError msg={errors.sellerSummary?.[0]} />
      </div>
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm recording this withdrawal.
      </label>
      <FormError msg={errors._form?.[0]} />
      <SuccessNote state={state} text="Withdrawal recorded." />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Recording…' : 'Record withdrawal'}
      </Button>
    </form>
  )
}

// ─── Expire consignment ─────────────────────────────────────────────────────────

const NEXT_ACTION_OPTIONS = [
  { value: 'renew', label: 'Renew consignment' },
  { value: 'return', label: 'Return to seller' },
  { value: 'manual', label: 'Flag for manual handling' },
]

export function ExpireConsignmentForm({ itemInstanceId }: { itemInstanceId: string }) {
  const [state, formAction, isPending] = useActionState<LifecycleActionState, FormData>(
    expireConsignment,
    null,
  )
  const errors = errorsOf(state)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <input type="hidden" name="itemInstanceId" value={itemInstanceId} />
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Expiration reason</label>
        <textarea name="expirationReason" rows={2} required className={textareaClass} />
        <FormError msg={errors.expirationReason?.[0]} />
      </div>
      <Select
        label="Next action"
        name="nextAction"
        required
        options={NEXT_ACTION_OPTIONS}
        placeholder="Select next action"
        error={errors.nextAction?.[0]}
      />
      <label className={confirmLabel}>
        <input type="checkbox" name="confirm" className="rounded border-gray-300" />
        I confirm expiring this consignment.
      </label>
      <FormError msg={errors._form?.[0]} />
      <SuccessNote state={state} text="Consignment expiration recorded." />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? 'Processing…' : 'Expire consignment'}
      </Button>
    </form>
  )
}
