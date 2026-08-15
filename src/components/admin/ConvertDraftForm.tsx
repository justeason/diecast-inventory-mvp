'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import type { StorageLocation } from '@prisma/client'
import type { ConvertActionState } from '@/lib/actions/intake'
import { formatCommissionDisplay } from '@/lib/sellerAgreementDisplay'
import { CatalogModelCombobox } from '@/components/admin/CatalogModelCombobox'
import { formatCandidateLabel } from '@/lib/catalogMatching'

type CatalogModelSummary = {
  id: string
  brand: string
  name: string
  year: number | null
  series: string | null
  color: string | null
  scale: string | null
}

export type AgreementConversionData = {
  id: string
  type: 'buyout' | 'consignment'
  agreedBuyoutAmount: string | null
  commissionPercent: string | null
  fixedFee: string | null
  minimumSellerPayout: string | null
  agreedListPrice: string | null
  sellerTermsSummary: string | null
  acceptedAtLabel: string
  acceptanceMethodLabel: string
}

type Props = {
  action: (prev: ConvertActionState, formData: FormData) => Promise<ConvertActionState>
  locations: StorageLocation[]
  suggestedSku?: string
  exactCatalogMatch?: CatalogModelSummary | null
  similarCatalogModels?: CatalogModelSummary[]
  catalogInitialQuery?: string
  sellerSubmissionId?: string | null
  acceptedAgreement?: AgreementConversionData | null
  agreementBlockReason?: string | null
}

function formatModel(m: CatalogModelSummary): string {
  return [m.brand, m.name, m.year?.toString(), m.series, m.color, m.scale]
    .filter(Boolean)
    .join(' · ')
}

function ConvertButton({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-md bg-green-700 px-5 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Converting…' : label}
    </button>
  )
}

export function ConvertDraftForm({
  action,
  locations,
  suggestedSku,
  exactCatalogMatch,
  similarCatalogModels = [],
  catalogInitialQuery,
  sellerSubmissionId,
  acceptedAgreement,
  agreementBlockReason,
}: Props) {
  const [state, formAction] = useActionState<ConvertActionState, FormData>(action, null)
  const errors = state && 'errors' in state ? state.errors : {}

  const [sku, setSku] = useState('')

  if (locations.length === 0) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4 text-sm">
        <p className="font-medium text-amber-800 mb-1">No storage locations exist.</p>
        <p className="text-amber-700">
          <Link href="/admin/locations/new" className="underline hover:no-underline">
            Create a storage location
          </Link>{' '}
          before converting this draft.
        </p>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      {errors.form && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {errors.form[0]}
        </p>
      )}

      {/* Agreement block — must resolve before converting */}
      {agreementBlockReason && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-800 mb-1">Commercial agreement required</p>
          <p className="text-amber-700 mb-2">{agreementBlockReason}</p>
          {sellerSubmissionId && (
            <a
              href={`/admin/seller-submissions/${sellerSubmissionId}/agreement`}
              className="text-amber-900 underline hover:no-underline"
            >
              Manage commercial agreement →
            </a>
          )}
        </div>
      )}

      {/* Catalog model — search and select, or leave blank to create new */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Catalog model</p>
        {exactCatalogMatch && (
          <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1">
            Auto-matched: {formatCandidateLabel(exactCatalogMatch)}
          </p>
        )}
        {!exactCatalogMatch && similarCatalogModels.length > 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
            No exact match found. Select a similar model below or leave blank to create a new one.
          </p>
        )}
        {!exactCatalogMatch && similarCatalogModels.length === 0 && (
          <p className="text-xs text-gray-400">
            No existing match found. Leave blank to create a new catalog model automatically.
          </p>
        )}
        <CatalogModelCombobox
          name="catalogModelId"
          defaultValue={exactCatalogMatch?.id ?? ''}
          defaultLabel={exactCatalogMatch ? formatCandidateLabel(exactCatalogMatch) : ''}
          initialQuery={!exactCatalogMatch ? (catalogInitialQuery ?? '') : ''}
          placeholder="Search to override catalog model…"
        />
        <p className="text-xs text-gray-400">Leave blank to auto-create a new catalog model.</p>
      </div>

      {/* Storage location — required to convert */}
      <div className="max-w-xs space-y-1">
        <label htmlFor="locationId" className="text-sm font-medium text-gray-700">
          Storage Location <span className="text-red-500">*</span>
        </label>
        <select
          id="locationId"
          name="locationId"
          defaultValue=""
          className={`w-full rounded-md border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900 ${
            errors.locationId ? 'border-red-500' : 'border-gray-300'
          }`}
        >
          <option value="">Select storage location…</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
        {errors.locationId && <p className="text-xs text-red-600">{errors.locationId[0]}</p>}
      </div>

      {/* SKU input with suggestion */}
      <div className="max-w-xs space-y-1">
        <label htmlFor="sku" className="text-sm font-medium text-gray-700">
          SKU <span className="text-red-500">*</span>
        </label>
        {suggestedSku && (
          <p className="text-xs text-gray-500">
            Suggested:{' '}
            <button
              type="button"
              onClick={() => setSku(suggestedSku)}
              className="font-mono text-indigo-600 hover:underline focus:outline-none"
            >
              {suggestedSku}
            </button>
            <span className="ml-1 text-gray-400">(click to use)</span>
          </p>
        )}
        <input
          id="sku"
          name="sku"
          required
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="e.g. HW-0001"
          className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
            errors.sku ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {errors.sku && <p className="text-xs text-red-600">{errors.sku[0]}</p>}
      </div>

      {/* Commercial confirmation — shown for seller-sourced intake with accepted agreement */}
      {acceptedAgreement && (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm space-y-3">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-gray-800">Commercial terms</p>
            <span className="text-xs text-gray-500">
              {acceptedAgreement.type === 'buyout' ? 'Buyout' : 'Consignment'}
            </span>
            {acceptedAgreement.acceptedAtLabel && (
              <span className="text-xs text-gray-400">
                · Accepted {acceptedAgreement.acceptedAtLabel}
                {acceptedAgreement.acceptanceMethodLabel &&
                  ` via ${acceptedAgreement.acceptanceMethodLabel}`}
              </span>
            )}
          </div>

          <dl className="space-y-1 text-xs text-gray-700">
            {acceptedAgreement.type === 'buyout' && acceptedAgreement.agreedBuyoutAmount && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-36 shrink-0">Buyout amount</dt>
                <dd>${acceptedAgreement.agreedBuyoutAmount}</dd>
              </div>
            )}
            {acceptedAgreement.type === 'buyout' && acceptedAgreement.agreedBuyoutAmount && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-36 shrink-0">Acquisition cost</dt>
                <dd className="text-gray-500">
                  Recorded once for the whole agreement (see seller payouts) — item-level cost not allocated
                </dd>
              </div>
            )}
            {acceptedAgreement.type === 'consignment' && acceptedAgreement.commissionPercent && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-36 shrink-0">Commission</dt>
                <dd>{formatCommissionDisplay(acceptedAgreement.commissionPercent)}</dd>
              </div>
            )}
            {acceptedAgreement.type === 'consignment' && acceptedAgreement.fixedFee && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-36 shrink-0">Fixed fee</dt>
                <dd>${acceptedAgreement.fixedFee}</dd>
              </div>
            )}
            {acceptedAgreement.type === 'consignment' && acceptedAgreement.minimumSellerPayout && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-36 shrink-0">Min. payout</dt>
                <dd>${acceptedAgreement.minimumSellerPayout}</dd>
              </div>
            )}
            {acceptedAgreement.agreedListPrice && (
              <div className="flex gap-3">
                <dt className="text-gray-500 w-36 shrink-0">Agreed list price</dt>
                <dd>${acceptedAgreement.agreedListPrice}</dd>
              </div>
            )}
          </dl>

          {acceptedAgreement.sellerTermsSummary && (
            <p className="text-xs text-gray-600 whitespace-pre-wrap border-t border-gray-200 pt-2">
              {acceptedAgreement.sellerTermsSummary}
            </p>
          )}

          {acceptedAgreement.type === 'buyout' ? (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="confirmBuyout"
                className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-gray-900"
              />
              <span className="text-sm text-gray-700">
                I confirm the agreed buyout amount (${acceptedAgreement.agreedBuyoutAmount}) is the seller
                payment for this agreement. It is not allocated to this item&apos;s individual cost basis.
              </span>
            </label>
          ) : (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="confirmConsignment"
                className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-gray-900"
              />
              <span className="text-sm text-gray-700">
                I confirm this item remains seller-owned under the accepted consignment agreement.
                The seller payout is not automatic and will be handled manually per the agreed terms.
              </span>
            </label>
          )}
        </div>
      )}

      {/* 15F-review section 1: intake no longer creates a listing directly — that
          always goes through the one risk-gated listing_activation path
          (actions/listings.ts createListing), reached from the item page right
          after conversion. */}
      <ConvertButton label="Convert to Item" disabled={!!agreementBlockReason} />
    </form>
  )
}
