'use client'

import { useActionState, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'
import type { SellerAgreementActionState } from '@/lib/actions/sellerAgreements'
import { resolveCommissionTerms } from '@/lib/commissionPolicy'
import type { CommissionPolicyDef, SellerOverrideDef } from '@/lib/commissionPolicy'

type DefaultValues = {
  type?: string
  agreedBuyoutAmount?: string
  commissionPercent?: string
  fixedFee?: string
  minimumSellerPayout?: string
  agreedListPrice?: string
  sellerTermsSummary?: string
  adminNotes?: string
  commissionOverrideReason?: string
  commissionMinimumFee?: string
  isCommissionOverride?: boolean
  acceptedItemCount?: string
}

type Props = {
  action: (
    _prev: SellerAgreementActionState,
    formData: FormData,
  ) => Promise<SellerAgreementActionState>
  defaultValues?: DefaultValues
  submitLabel?: string
  // 15A-review section 1: submitted quantity (context/cap) and the raw resolution
  // ingredients for the active policy — passed down so the accepted-quantity field
  // can show an instant tier/commission preview by re-running the SAME pure
  // resolveCommissionTerms engine client-side, with no network round-trip.
  submittedQuantity?: number
  policy?: CommissionPolicyDef | null
  sellerOverride?: SellerOverrideDef | null
}

function pctLabel(bps: number): string {
  const pct = bps / 100
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`
}

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null
  return <p className="mt-1 text-xs text-red-600">{messages[0]}</p>
}

function inputCls(hasError?: boolean) {
  return [
    'block w-full rounded-md border px-3 py-2 text-sm text-gray-900 placeholder-gray-400',
    'focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent',
    hasError ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
  ].join(' ')
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Saving…' : label}
    </button>
  )
}

export function SellerAgreementForm({
  action,
  defaultValues,
  submitLabel = 'Save',
  submittedQuantity,
  policy = null,
  sellerOverride = null,
}: Props) {
  const [state, formAction] = useActionState(action, {})
  const [selectedType, setSelectedType] = useState(defaultValues?.type ?? '')
  const [overrideCommission, setOverrideCommission] = useState(defaultValues?.isCommissionOverride ?? false)
  const [acceptedItemCount, setAcceptedItemCount] = useState(
    defaultValues?.acceptedItemCount ?? (submittedQuantity != null ? String(submittedQuantity) : ''),
  )

  const e = state.errors ?? {}

  const parsedAcceptedItemCount = parseInt(acceptedItemCount, 10)
  const validAcceptedItemCount = Number.isInteger(parsedAcceptedItemCount) && parsedAcceptedItemCount >= 1
    ? parsedAcceptedItemCount
    : null

  const livePreview = useMemo(() => {
    if (overrideCommission || !policy || validAcceptedItemCount === null) return null
    return resolveCommissionTerms({
      sellerOverride,
      policy,
      acceptedItemCount: validAcceptedItemCount,
      asOf: new Date(),
    })
  }, [overrideCommission, policy, sellerOverride, validAcceptedItemCount])

  return (
    <form action={formAction} className="space-y-5">
      {e._form && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {e._form[0]}
        </div>
      )}

      {/* Type */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Agreement type <span className="text-red-500">*</span>
        </label>
        <select
          name="type"
          value={selectedType}
          onChange={(ev) => setSelectedType(ev.target.value)}
          className={inputCls(!!e.type)}
          required
        >
          <option value="">Select type…</option>
          <option value="buyout">Buyout (outright sale)</option>
          <option value="consignment">Consignment</option>
        </select>
        <FieldError messages={e.type} />
      </div>

      {/* Buyout-specific */}
      {selectedType === 'buyout' && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Agreed buyout amount (USD) <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="agreedBuyoutAmount"
              defaultValue={defaultValues?.agreedBuyoutAmount ?? ''}
              placeholder="0.00"
              className={inputCls(!!e.agreedBuyoutAmount)}
            />
            <FieldError messages={e.agreedBuyoutAmount} />
          </div>
          {/* 15D-review (final approval pass): this amount is the TOTAL for the whole
              agreement, not automatically a per-item price. Leave blank unless exactly
              one physical item is covered — that is the only case where the total and
              the item's cost basis are mathematically identical. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Physical item count covered (optional)
            </label>
            <input
              type="text"
              inputMode="numeric"
              name="acceptedItemCount"
              defaultValue={defaultValues?.acceptedItemCount ?? ''}
              placeholder="Leave blank if unknown or more than one item"
              className={inputCls(!!e.acceptedItemCount)}
            />
            <p className="mt-1 text-xs text-gray-400">
              Set this to exactly <strong>1</strong> only when the buyout amount above pays for a single
              physical item — intake will then record that amount as the item&apos;s cost basis. For
              multiple items or an unknown split, leave this blank; item-level cost stays unallocated.
            </p>
            <FieldError messages={e.acceptedItemCount} />
          </div>
        </div>
      )}

      {/* Consignment-specific — 15A: commission is normally auto-resolved by the
          Commission Policy Engine. No fields are required here for the default path. */}
      {selectedType === 'consignment' && (
        <>
          {/* 15A-review section 1: accepted quantity is the authoritative volume-tier
              denominator for this agreement — always relevant for consignment,
              independent of whether commission terms are overridden below. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Accepted quantity for this agreement <span className="text-red-500">*</span>
            </label>
            {submittedQuantity != null && (
              <p className="mb-1 text-xs text-gray-500">Submitted quantity: {submittedQuantity}</p>
            )}
            <input
              type="text"
              inputMode="numeric"
              name="acceptedItemCount"
              value={acceptedItemCount}
              onChange={(ev) => setAcceptedItemCount(ev.target.value)}
              placeholder="1"
              className={inputCls(!!e.acceptedItemCount)}
            />
            <p className="mt-1 text-xs text-gray-400">
              How many items CollectNTrades is accepting under this agreement — may differ from what
              the seller submitted. Drives the volume-tier commission rate below.
            </p>
            <FieldError messages={e.acceptedItemCount} />
            {livePreview && (
              <p className="mt-2 text-xs text-gray-700 bg-white rounded border border-gray-200 px-2 py-1.5">
                Applied tier: <span className="font-medium">{pctLabel(livePreview.commissionBps)} commission</span>
                {' · '}min ${(livePreview.minimumFeeCents / 100).toFixed(2)}/item
              </p>
            )}
            {!overrideCommission && !policy && (
              <p className="mt-1 text-xs text-amber-700">
                No active commission policy configured — check &quot;Override commission terms&quot; below to set terms manually.
              </p>
            )}
          </div>

          <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <input
                type="checkbox"
                checked={overrideCommission}
                onChange={(ev) => setOverrideCommission(ev.target.checked)}
                className="rounded border-gray-300"
              />
              Override commission terms for this agreement
            </label>
            <p className="mt-1 text-xs text-gray-500">
              Leave unchecked to let the active commission policy resolve the rate automatically —
              this is the normal path and requires no editing below.
            </p>

            {overrideCommission && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Commission %</label>
                  <div className="relative">
                    <input
                      type="text"
                      name="commissionPercent"
                      defaultValue={defaultValues?.commissionPercent ?? ''}
                      placeholder="20"
                      className={inputCls(!!e.commissionPercent)}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">%</span>
                  </div>
                  <FieldError messages={e.commissionPercent} />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Minimum commission per sold item (USD)
                    <span className="ml-1 text-xs font-normal text-gray-400">optional</span>
                  </label>
                  <input
                    type="text"
                    name="commissionMinimumFee"
                    defaultValue={defaultValues?.commissionMinimumFee ?? ''}
                    placeholder="0.00"
                    className={inputCls(!!e.commissionMinimumFee)}
                  />
                  <FieldError messages={e.commissionMinimumFee} />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason for override <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    name="commissionOverrideReason"
                    defaultValue={defaultValues?.commissionOverrideReason ?? ''}
                    rows={2}
                    placeholder="Why this agreement uses non-standard commission terms…"
                    className={inputCls(!!e.commissionOverrideReason)}
                  />
                  <FieldError messages={e.commissionOverrideReason} />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Common: agreed list price */}
      {selectedType && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Agreed list price (USD)
            <span className="ml-1 text-xs font-normal text-gray-400">optional</span>
          </label>
          <input
            type="text"
            name="agreedListPrice"
            defaultValue={defaultValues?.agreedListPrice ?? ''}
            placeholder="0.00"
            className={inputCls(!!e.agreedListPrice)}
          />
          <p className="mt-1 text-xs text-gray-400">
            Indicative listing price discussed with seller. Does not set the actual listing price.
          </p>
          <FieldError messages={e.agreedListPrice} />
        </div>
      )}

      {/* Seller terms summary */}
      {selectedType && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Seller terms summary
            <span className="ml-1 text-xs font-normal text-gray-400">
              required before proposing
            </span>
          </label>
          <textarea
            name="sellerTermsSummary"
            defaultValue={defaultValues?.sellerTermsSummary ?? ''}
            rows={4}
            placeholder="Plain-language summary of the agreement terms visible to the seller…"
            className={inputCls(!!e.sellerTermsSummary)}
          />
          <FieldError messages={e.sellerTermsSummary} />
        </div>
      )}

      {/* Admin notes */}
      {selectedType && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Admin notes
            <span className="ml-1 text-xs font-normal text-gray-400">
              internal only — not shown to seller
            </span>
          </label>
          <textarea
            name="adminNotes"
            defaultValue={defaultValues?.adminNotes ?? ''}
            rows={3}
            placeholder="Internal notes about this agreement…"
            className={inputCls(!!e.adminNotes)}
          />
          <FieldError messages={e.adminNotes} />
        </div>
      )}

      <SubmitButton label={submitLabel} />
    </form>
  )
}
