'use client'

// 27B §6/§35/§39/§47/§59: a small client island for the per-item preview
// price — canonical commission/payout math still runs server-side
// (previewSellerProceedsAction), this component only collects input and
// displays the returned result. Estimated Difference (proceeds - Recorded
// Cost) is simple client-side subtraction of two already-known numbers
// (server-computed proceeds + the page's own once-fetched FIFO cost preview)
// — never a second fee/cost calculation.
import { useState } from 'react'
import { previewSellerProceedsAction } from '@/lib/actions/sellerProceedsPreview'
import { centsToDisplay } from '@/lib/marketModelPageDisplay'
import type { RecordedCostPreview } from '@/lib/ownershipLedger'

const TERMS_SOURCE_COPY: Record<string, string> = {
  accepted_agreement: 'Based on your accepted consignment agreement terms.',
  proposed_agreement: 'Based on your proposed consignment agreement terms (not yet accepted).',
  policy_preview: 'Estimated using current consignment terms. Final terms are confirmed in your agreement.',
}

export function SellerProceedsEstimator({
  submissionId,
  quantity,
  initialPriceCents,
  costPreview,
}: {
  submissionId: string
  quantity: number
  initialPriceCents: number | null
  // Fetched once, server-side, in the page — never refetched per keystroke.
  costPreview: RecordedCostPreview | null
}) {
  const [priceInput, setPriceInput] = useState(initialPriceCents !== null ? (initialPriceCents / 100).toFixed(2) : '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    netProceedsPerItemCents: number
    netProceedsTotalCents: number
    termsSource: string
  } | null | 'unavailable'>(null)

  async function handleCalculate() {
    const dollars = parseFloat(priceInput)
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError('Enter a valid price.')
      return
    }
    setError(null)
    setPending(true)
    const response = await previewSellerProceedsAction(submissionId, Math.round(dollars * 100))
    setPending(false)
    if (!response.ok) {
      setError(response.error)
      return
    }
    setResult(response.estimate ?? 'unavailable')
  }

  const estimatedDifferenceCents =
    result && result !== 'unavailable' && costPreview?.status === 'known'
      ? result.netProceedsTotalCents - costPreview.recordedCostCents!
      : null

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <label htmlFor="seller-proceeds-price" className="block text-xs font-medium text-gray-600 mb-1">
        Sale price per item ($)
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <input
          id="seller-proceeds-price"
          type="number"
          min="0"
          step="0.01"
          value={priceInput}
          onChange={(e) => setPriceInput(e.target.value)}
          className="w-32 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={handleCalculate}
          disabled={pending}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        >
          {pending ? 'Calculating…' : 'Estimate Proceeds'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}

      {result === 'unavailable' && (
        <p className="text-xs text-gray-400 mt-3">Consignment terms are not yet available for this submission.</p>
      )}

      {result && result !== 'unavailable' && (
        <div className="mt-3 text-sm text-gray-700 space-y-0.5">
          <p>
            Estimated Seller Proceeds / item: <span className="font-medium">{centsToDisplay(result.netProceedsPerItemCents)}</span>
          </p>
          {quantity > 1 && (
            <p>
              Estimated Seller Proceeds total ({quantity}): <span className="font-medium">{centsToDisplay(result.netProceedsTotalCents)}</span>
            </p>
          )}
          <p className="text-xs text-gray-500 mt-1">{TERMS_SOURCE_COPY[result.termsSource] ?? ''}</p>

          {estimatedDifferenceCents !== null && (
            <p className="text-xs text-gray-500 border-t border-gray-100 mt-2 pt-2">
              Estimated Difference: <span className="font-medium text-gray-700">{centsToDisplay(estimatedDifferenceCents)}</span>
              {' — '}Estimated proceeds minus your recorded acquisition cost for the copies selected to sell.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
