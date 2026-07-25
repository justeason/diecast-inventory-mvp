'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import type { SellerAgreementActionState } from '@/lib/actions/sellerAgreements'

type DefaultValues = {
  type?: string
  agreedBuyoutAmount?: string
  commissionPercent?: string
  fixedFee?: string
  minimumSellerPayout?: string
  agreedListPrice?: string
  sellerTermsSummary?: string
  adminNotes?: string
}

type Props = {
  action: (
    _prev: SellerAgreementActionState,
    formData: FormData,
  ) => Promise<SellerAgreementActionState>
  defaultValues?: DefaultValues
  submitLabel?: string
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

export function SellerAgreementForm({ action, defaultValues, submitLabel = 'Save' }: Props) {
  const [state, formAction] = useActionState(action, {})
  const [selectedType, setSelectedType] = useState(defaultValues?.type ?? '')

  const e = state.errors ?? {}

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
      )}

      {/* Consignment-specific */}
      {selectedType === 'consignment' && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Commission % <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                name="commissionPercent"
                defaultValue={defaultValues?.commissionPercent ?? ''}
                placeholder="20"
                className={inputCls(!!e.commissionPercent)}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">
                %
              </span>
            </div>
            <FieldError messages={e.commissionPercent} />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Fixed fee (USD)
              <span className="ml-1 text-xs font-normal text-gray-400">optional</span>
            </label>
            <input
              type="text"
              name="fixedFee"
              defaultValue={defaultValues?.fixedFee ?? ''}
              placeholder="0.00"
              className={inputCls(!!e.fixedFee)}
            />
            <FieldError messages={e.fixedFee} />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Minimum seller payout (USD)
              <span className="ml-1 text-xs font-normal text-gray-400">optional</span>
            </label>
            <input
              type="text"
              name="minimumSellerPayout"
              defaultValue={defaultValues?.minimumSellerPayout ?? ''}
              placeholder="0.00"
              className={inputCls(!!e.minimumSellerPayout)}
            />
            <FieldError messages={e.minimumSellerPayout} />
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
