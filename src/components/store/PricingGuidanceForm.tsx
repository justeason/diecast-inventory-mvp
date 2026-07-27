'use client'

import { useState, useActionState } from 'react'
import {
  saveSellerPricingPreference,
  type PricingGuidanceActionState,
} from '@/lib/actions/sellerPricingGuidance'
import { STRATEGY_LABELS, type PricingStrategy } from '@/lib/sellerPricingGuidance'

export type SerializedGuidance = {
  targetPriceCents: number | null
  estimatedDaysToSell: number | null
  estimatedSellerProceedsCents: number | null
  confidence: string
  comparableCount: number
  matchLevel: string
  warnings: string[]
}

export type SerializedPreference = {
  strategy: string
  selectedTargetPriceCents: number
  customDesiredPriceCents: number | null
  estimatedDaysToSell: number | null
  estimatedSellerProceedsCents: number | null
  confidence: string
  matchLevel: string
  comparableCount: number
  capturedAt: string
} | null

type Props = {
  submissionId: string
  sellFastGuidance: SerializedGuidance | null
  maximizeGuidance: SerializedGuidance | null
  hasEstimate: boolean
  savedPreference: SerializedPreference
  isLocked: boolean
  hasConsignmentTerms: boolean
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-green-700',
  medium: 'text-blue-700',
  low: 'text-yellow-700',
  insufficient: 'text-gray-500',
}

const MATCH_LABELS: Record<string, string> = {
  exact: 'Exact model',
  model_family: 'Model family',
  series_year: 'Series + year',
  brand_series: 'Brand + series',
  insufficient: 'No data',
}

function usd(cents: number | null): string {
  if (cents === null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function GuidanceDetails({
  guidance,
  hasConsignmentTerms,
}: {
  guidance: SerializedGuidance | null
  hasConsignmentTerms: boolean
}) {
  if (!guidance || guidance.targetPriceCents === null) return null
  return (
    <div className="mt-2 space-y-1 text-xs text-gray-600">
      <p>
        Target price:{' '}
        <span className="font-semibold text-gray-900">{usd(guidance.targetPriceCents)}</span>
      </p>
      {guidance.estimatedDaysToSell !== null && (
        <p>Est. days to sell: ~{guidance.estimatedDaysToSell}d</p>
      )}
      {hasConsignmentTerms && guidance.estimatedSellerProceedsCents !== null && (
        <p>
          Est. proceeds:{' '}
          <span className="font-medium text-gray-900">
            {usd(guidance.estimatedSellerProceedsCents)}
          </span>{' '}
          <span className="text-gray-400">(estimate only)</span>
        </p>
      )}
      {!hasConsignmentTerms && (
        <p className="text-gray-400">
          Estimated proceeds available after consignment terms are set.
        </p>
      )}
      <p>
        Based on{' '}
        <span className={CONFIDENCE_COLORS[guidance.confidence] ?? 'text-gray-500'}>
          {guidance.confidence} confidence
        </span>{' '}
        · {guidance.comparableCount} comparable{guidance.comparableCount !== 1 ? 's' : ''} ·{' '}
        {MATCH_LABELS[guidance.matchLevel] ?? guidance.matchLevel}
      </p>
      {guidance.warnings
        .filter((w) => !w.startsWith('No comparable'))
        .map((w, i) => (
          <p key={i} className="text-amber-700">
            {w}
          </p>
        ))}
    </div>
  )
}

export function PricingGuidanceForm({
  submissionId,
  sellFastGuidance,
  maximizeGuidance,
  hasEstimate,
  savedPreference,
  isLocked,
  hasConsignmentTerms,
}: Props) {
  const defaultStrategy: PricingStrategy = savedPreference
    ? (savedPreference.strategy as PricingStrategy)
    : hasEstimate
      ? 'sell_fast'
      : 'custom'

  const defaultCustomPrice =
    savedPreference?.customDesiredPriceCents !== null && savedPreference?.customDesiredPriceCents != null
      ? (savedPreference.customDesiredPriceCents / 100).toFixed(2)
      : ''

  const [strategy, setStrategy] = useState<PricingStrategy>(defaultStrategy)
  const [customPrice, setCustomPrice] = useState(defaultCustomPrice)

  const boundAction = saveSellerPricingPreference.bind(null, submissionId)
  const [state, formAction, isPending] = useActionState<PricingGuidanceActionState, FormData>(
    boundAction,
    null,
  )

  if (isLocked) {
    if (!savedPreference) return null
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm">
        <p className="font-semibold text-gray-700 mb-2">Pricing preference (locked)</p>
        <p className="text-xs text-gray-500 mb-3">
          The agreement has been accepted or inventory has been converted. No further changes can be
          made.
        </p>
        <dl className="space-y-1 text-xs text-gray-600">
          <div className="flex gap-3">
            <dt className="text-gray-500 w-32 shrink-0">Strategy</dt>
            <dd>{STRATEGY_LABELS[savedPreference.strategy as PricingStrategy] ?? savedPreference.strategy}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-32 shrink-0">Target price</dt>
            <dd className="font-semibold text-gray-900">{usd(savedPreference.selectedTargetPriceCents)}</dd>
          </div>
          {savedPreference.customDesiredPriceCents !== null && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-32 shrink-0">Custom target</dt>
              <dd>{usd(savedPreference.customDesiredPriceCents)}</dd>
            </div>
          )}
          {savedPreference.estimatedDaysToSell !== null && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-32 shrink-0">Est. days to sell</dt>
              <dd>~{savedPreference.estimatedDaysToSell}d</dd>
            </div>
          )}
          {savedPreference.estimatedSellerProceedsCents !== null && (
            <div className="flex gap-3">
              <dt className="text-gray-500 w-32 shrink-0">Est. proceeds</dt>
              <dd>{usd(savedPreference.estimatedSellerProceedsCents)}</dd>
            </div>
          )}
          <div className="flex gap-3">
            <dt className="text-gray-500 w-32 shrink-0">Confidence</dt>
            <dd className={CONFIDENCE_COLORS[savedPreference.confidence] ?? 'text-gray-600'}>
              {savedPreference.confidence}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-32 shrink-0">Captured</dt>
            <dd>{new Date(savedPreference.capturedAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      </div>
    )
  }

  return (
    <form action={formAction}>
      {state?.errors?.form && (
        <p className="mb-3 text-xs text-red-600">{state.errors.form.join(' ')}</p>
      )}

      {!hasEstimate && (
        <p className="mb-4 text-sm text-gray-500 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
          Not enough completed-sale history for automatic suggestions. You may still enter a custom
          target price.
        </p>
      )}

      <div className="space-y-2 mb-4">
        {hasEstimate &&
          (['sell_fast', 'maximize_proceeds'] as PricingStrategy[]).map((s) => {
            const g = s === 'sell_fast' ? sellFastGuidance : maximizeGuidance
            const isSelected = strategy === s
            return (
              <label
                key={s}
                className={`block rounded-md border px-4 py-3 cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-gray-900 bg-gray-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="strategy"
                    value={s}
                    checked={isSelected}
                    onChange={() => setStrategy(s)}
                    className="shrink-0"
                  />
                  <span className="font-medium text-sm text-gray-900">{STRATEGY_LABELS[s]}</span>
                </div>
                {isSelected && g && (
                  <GuidanceDetails guidance={g} hasConsignmentTerms={hasConsignmentTerms} />
                )}
              </label>
            )
          })}

        <label
          className={`block rounded-md border px-4 py-3 cursor-pointer transition-colors ${
            strategy === 'custom'
              ? 'border-gray-900 bg-gray-50'
              : 'border-gray-200 bg-white hover:border-gray-300'
          }`}
        >
          <div className="flex items-center gap-2">
            <input
              type="radio"
              name="strategy"
              value="custom"
              checked={strategy === 'custom'}
              onChange={() => setStrategy('custom')}
              className="shrink-0"
            />
            <span className="font-medium text-sm text-gray-900">{STRATEGY_LABELS.custom}</span>
          </div>
          {strategy === 'custom' && (
            <div className="mt-2">
              <label className="block text-xs text-gray-600 mb-1">Your target price (USD)</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-gray-500">$</span>
                <input
                  type="number"
                  name="customTarget"
                  value={customPrice}
                  onChange={(e) => setCustomPrice(e.target.value)}
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  className="w-32 rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
              {state?.errors?.customTarget && (
                <p className="mt-1 text-xs text-red-600">{state.errors.customTarget.join(' ')}</p>
              )}
            </div>
          )}
        </label>
      </div>

      {state?.errors?.strategy && (
        <p className="mb-3 text-xs text-red-600">{state.errors.strategy.join(' ')}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 transition-colors"
      >
        {isPending ? 'Saving…' : 'Save preference'}
      </button>

      <p className="mt-3 text-xs text-gray-400">
        These estimates are based on prior CollectNTrades sales and are not guaranteed. Final
        agreement terms and listing price are determined separately.
      </p>
    </form>
  )
}
