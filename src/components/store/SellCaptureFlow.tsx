'use client'

import Link from 'next/link'
import { useActionState, useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import { recognizeForSell } from '@/lib/actions/sellRecognize'
import type { IdentifyCandidate } from '@/lib/captureIdentifyCore'
import {
  addSellItem, updateSellItem, removeSellItem,
  searchModelsForSell, submitSellBatch,
  type SellItemResult,
} from '@/lib/actions/sellCapture'
import { getGuestMarketQuote } from '@/lib/actions/guestMarketQuote'
import type { ValuationResult } from '@/lib/marketValuation'
import { centsToDisplay } from '@/lib/marketModelPageDisplay'
import type { CatalogMatchResult } from '@/lib/catalogMatching'

export type PreselectedModel = { id: string; brand: string; name: string; year: number | null }

const CONDITION_OPTIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'] as const
const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint', near_mint: 'Near Mint', good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
}
const SALE_TYPE_LABELS: Record<string, string> = {
  unsure: 'Not sure yet', buyout: 'Sell outright', consignment: 'Consign with us',
}

function makeClientToken(catalogModelId: string): string {
  return `${catalogModelId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function SubmitButton({ label, pendingLabel, disabled }: { label: string; pendingLabel: string; disabled?: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
    >
      {pending ? pendingLabel : label}
    </button>
  )
}

// 19B: ONE customer-facing capture UI for both signed-in and signed-out
// visitors — the server-side persistence backend (GuestSellerSession vs
// authenticated MobileCaptureSession) is chosen invisibly by sellCapture.ts;
// this component only ever talks to that one backend-selecting wrapper.
export function SellCaptureFlow({
  initialItems,
  unclaimedGuestBatchCount,
  isAuthenticated,
  preselected,
  justClaimed,
}: {
  initialItems: SellItemResult[]
  unclaimedGuestBatchCount: number
  isAuthenticated: boolean
  preselected: PreselectedModel | null
  justClaimed: boolean
}) {
  const router = useRouter()
  const [recognizeState, recognizeAction] = useActionState(recognizeForSell, null)
  const [items, setItems] = useState<SellItemResult[]>(initialItems)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  const [submitPending, setSubmitPending] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const submitInFlightRef = useRef(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<CatalogMatchResult[] | null>(null)
  const [searchPending, setSearchPending] = useState(false)

  const [addPendingId, setAddPendingId] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  // 27B §11: model-level EMV, fetched the moment a CatalogModel is confirmed —
  // public market context only, never gated on authentication. Keyed by
  // catalogModelId since one guest batch can include multiple distinct models.
  const [quotesByModelId, setQuotesByModelId] = useState<Record<string, ValuationResult>>({})
  // 19B Final Runtime Reconciliation §4: `addPendingId` (React state) is what
  // drives the button's visual `disabled` prop, but state updates are batched/
  // async — a fast double-click can fire this handler twice before React
  // re-renders with the button disabled. This ref is checked and mutated
  // SYNCHRONOUSLY, independent of the render cycle, so it's the actual source
  // of truth preventing two concurrent addSellItem calls for the same model.
  const addInFlightRef = useRef<Set<string>>(new Set())

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    const file = e.target.files?.[0]
    if (file) {
      const url = URL.createObjectURL(file)
      objectUrlRef.current = url
      setPreviewUrl(url)
    } else {
      setPreviewUrl(null)
    }
  }

  // Explicit confirmation required before ANY persistence — recognition alone
  // never writes a GuestSellerItem/MobileCaptureItem. Every add uses sane,
  // least-friction defaults (quantity 1, sale type "unsure") that the customer
  // can refine afterward in the batch review below.
  async function confirmCandidate(catalogModelId: string) {
    // Synchronous guard — see addInFlightRef above. A second call for the same
    // model (double-click/tap before re-render) is a silent no-op, never a
    // second addSellItem request.
    if (addInFlightRef.current.has(catalogModelId)) return
    addInFlightRef.current.add(catalogModelId)

    setAddError(null)
    setAddPendingId(catalogModelId)
    try {
      const result = await addSellItem({
        catalogModelId,
        quantity: 1,
        condition: null,
        notes: null,
        saleTypePreference: 'unsure',
        clientToken: makeClientToken(catalogModelId),
      })
      if (!result.ok) { setAddError(result.error); return }
      setItems((prev) => [...prev, result.data])
      // Fire-and-forget — a slow/failed quote never blocks the add or the rest
      // of the flow; the item simply shows no market-value line yet.
      if (!(catalogModelId in quotesByModelId)) {
        getGuestMarketQuote(catalogModelId).then((quoteResult) => {
          if (quoteResult.ok) setQuotesByModelId((prev) => ({ ...prev, [catalogModelId]: quoteResult.valuation }))
        })
      }
    } finally {
      addInFlightRef.current.delete(catalogModelId)
      setAddPendingId(null)
    }
  }

  async function runSearch() {
    setSearchPending(true)
    const results = await searchModelsForSell(searchQuery)
    setSearchResults(results)
    setSearchPending(false)
  }

  async function handleEditSave(item: SellItemResult, updates: { quantity: number; condition: string | null; notes: string | null; saleTypePreference: string | null }) {
    setEditError(null)
    const result = await updateSellItem(item.id, updates, item.updatedAt)
    if (!result.ok) { setEditError(result.error); return }
    setItems((prev) => prev.map((i) => (i.id === item.id ? result.data : i)))
    setEditingId(null)
  }

  async function handleRemove(itemId: string) {
    const result = await removeSellItem(itemId)
    if (result.ok && result.data.removed) {
      setItems((prev) => prev.filter((i) => i.id !== itemId))
    }
  }

  // 19C: the explicit final-submission action, authenticated only — reuses the
  // existing, unmodified submitCaptureSession via submitSellBatch. Guarded by a
  // synchronous ref (same pattern as addInFlightRef above) so a fast double-click
  // can't fire two concurrent submissions; the destination on success is
  // /account/sell, the authenticated selling-activity/history page.
  async function handleSubmitBatch() {
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
    setSubmitPending(true)
    setSubmitError(null)
    try {
      const result = await submitSellBatch()
      if (!result.ok) { setSubmitError(result.error); return }
      router.push('/account/sell')
    } finally {
      submitInFlightRef.current = false
      setSubmitPending(false)
    }
  }

  const candidates = recognizeState?.candidates ?? null
  const isSingleConfident =
    candidates !== null &&
    candidates.length === 1 &&
    (candidates[0].confidence === 'exact' || candidates[0].confidence === 'strong')

  return (
    <div className="flex flex-col gap-8">
      {justClaimed && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Your saved items were added to your selling batch.
        </div>
      )}

      {unclaimedGuestBatchCount > 0 && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
          You also have {unclaimedGuestBatchCount} item{unclaimedGuestBatchCount !== 1 ? 's' : ''} saved from
          before you signed in.{' '}
          <Link href="/account/sell/claim" className="font-medium underline underline-offset-2">
            Continue Saved Batch
          </Link>
        </div>
      )}

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Sell Your Collectibles</h1>
        <p className="mt-1 text-sm text-gray-500">Take a photo to identify your item.</p>
      </div>

      {preselected && (
        <section aria-labelledby="preselected-heading" className="rounded-lg border border-gray-200 bg-white p-3">
          <h2 id="preselected-heading" className="text-sm font-semibold text-gray-900 mb-2">Add This Model</h2>
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium text-gray-900 truncate">
              {preselected.brand} {preselected.name}
              {preselected.year && <span className="text-gray-500 font-normal"> ({preselected.year})</span>}
            </p>
            <button
              type="button"
              onClick={() => confirmCandidate(preselected.id)}
              disabled={addPendingId === preselected.id}
              className="shrink-0 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              {addPendingId === preselected.id ? 'Adding…' : 'Confirm & Add'}
            </button>
          </div>
        </section>
      )}

      <form action={recognizeAction} className="flex flex-col gap-3">
        <label htmlFor="sell-image" className="block text-sm font-medium text-gray-700">Photo</label>
        <input
          id="sell-image"
          type="file"
          name="image"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={handleFileChange}
          className="text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-gray-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-700 cursor-pointer"
        />
        {previewUrl && (
          <div className="w-40 h-40 rounded-md overflow-hidden border border-gray-200 bg-gray-50 relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Selected photo preview" className="w-full h-full object-contain" />
          </div>
        )}
        <SubmitButton label="Open Camera / Identify" pendingLabel="Analyzing…" disabled={!previewUrl} />
      </form>

      {recognizeState?.error && (
        <p role="alert" className="text-sm text-red-600">{recognizeState.error}</p>
      )}
      {addError && <p role="alert" className="text-sm text-red-600">{addError}</p>}

      {candidates && candidates.length > 0 && (
        <section aria-labelledby="sell-candidates-heading">
          <h2 id="sell-candidates-heading" className="text-sm font-semibold text-gray-900 mb-3">
            {isSingleConfident ? 'Likely Match' : 'Possible Matches'} — confirm to add
          </h2>
          <ul className="space-y-2">
            {candidates.map((c: IdentifyCandidate) => (
              <li key={c.catalogModelId} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 truncate">
                    {c.brand} {c.name}{c.year && <span className="text-gray-500 font-normal"> ({c.year})</span>}
                  </p>
                  <p className="text-xs text-gray-500">{c.confidence === 'possible' ? 'Possible match' : 'Likely match'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => confirmCandidate(c.catalogModelId)}
                  disabled={addPendingId === c.catalogModelId}
                  className="shrink-0 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
                >
                  {addPendingId === c.catalogModelId ? 'Adding…' : 'Confirm & Add'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {candidates && candidates.length === 0 && !recognizeState?.error && (
        <div className="rounded-md border border-dashed border-gray-300 px-4 py-6 text-center space-y-1">
          <p className="text-sm text-gray-700">We couldn&apos;t confidently identify this model.</p>
          {recognizeState?.lowCoverage && (
            <p className="text-xs text-gray-400">We&apos;re still building our photo index, so results may be limited.</p>
          )}
        </div>
      )}

      {/* Manual search fallback — no dead end when recognition fails or is skipped. */}
      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-2">No match? Search the catalog</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Brand, model, series, color, year…"
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          <button
            type="button"
            onClick={runSearch}
            disabled={searchPending || searchQuery.trim().length < 2}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            {searchPending ? 'Searching…' : 'Search'}
          </button>
        </div>
        {searchResults && searchResults.length === 0 && (
          <p className="mt-2 text-sm text-gray-400">No models found.</p>
        )}
        {searchResults && searchResults.length > 0 && (
          <ul className="mt-2 space-y-1.5 max-h-64 overflow-y-auto">
            {searchResults.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-2">
                <span className="text-sm text-gray-900 truncate">
                  {m.brand} {m.name}{m.year && <span className="text-gray-500"> ({m.year})</span>}
                </span>
                <button
                  type="button"
                  onClick={() => confirmCandidate(m.id)}
                  disabled={addPendingId === m.id}
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition-colors"
                >
                  {addPendingId === m.id ? 'Adding…' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Batch review — no account required to view/edit/remove. */}
      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Your selling batch</h2>
        <p className="text-sm text-gray-500 mb-3">{items.length} item{items.length !== 1 ? 's' : ''}</p>
        {editError && <p role="alert" className="text-sm text-red-600 mb-2">{editError}</p>}

        {items.length === 0 ? (
          <p className="text-sm text-gray-400">No items yet — identify or search for your first item above.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-lg border border-gray-200 bg-white p-3">
                {editingId === item.id ? (
                  <EditItemForm
                    item={item}
                    onCancel={() => setEditingId(null)}
                    onSave={(updates) => handleEditSave(item, updates)}
                  />
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">
                        {item.brand} {item.name}{item.year && <span className="text-gray-500 font-normal"> ({item.year})</span>}
                      </p>
                      <p className="text-xs text-gray-500">
                        Qty {item.quantity}
                        {item.condition && <> · {CONDITION_LABELS[item.condition] ?? item.condition}</>}
                        {item.saleTypePreference && <> · {SALE_TYPE_LABELS[item.saleTypePreference] ?? item.saleTypePreference}</>}
                      </p>
                      {item.notes && <p className="text-xs text-gray-400 mt-0.5 truncate">{item.notes}</p>}
                      {(() => {
                        const quote = quotesByModelId[item.catalogModelId]
                        if (!quote) return null
                        if (quote.status === 'valued') {
                          return (
                            <p className="text-xs text-gray-500 mt-1">
                              Estimated Market Value: <span className="font-medium text-gray-700">{centsToDisplay(quote.estimatedValueCents)}</span>
                              {' '}· Model-level estimate; more specific context may be available after item details are confirmed.
                            </p>
                          )
                        }
                        return <p className="text-xs text-gray-400 mt-1">Not enough direct sales data yet.</p>
                      })()}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(item.id)}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(item.id)}
                        className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {items.length > 0 && (
        <section>
          {submitError && <p role="alert" className="text-sm text-red-600 mb-2">{submitError}</p>}
          {isAuthenticated ? (
            <button
              type="button"
              onClick={handleSubmitBatch}
              disabled={submitPending}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              {submitPending ? 'Submitting…' : 'Submit Items for Sale'}
            </button>
          ) : (
            <Link
              href="/account/sell/claim"
              className="inline-block rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
            >
              Continue to Sell
            </Link>
          )}
        </section>
      )}
    </div>
  )
}

function EditItemForm({
  item,
  onCancel,
  onSave,
}: {
  item: SellItemResult
  onCancel: () => void
  onSave: (updates: { quantity: number; condition: string | null; notes: string | null; saleTypePreference: string | null }) => void
}) {
  const [quantity, setQuantity] = useState(item.quantity)
  const [condition, setCondition] = useState(item.condition ?? '')
  const [notes, setNotes] = useState(item.notes ?? '')
  const [saleTypePreference, setSaleTypePreference] = useState(item.saleTypePreference ?? 'unsure')

  return (
    <div className="space-y-2">
      <p className="font-medium text-gray-900">{item.brand} {item.name}</p>
      <div className="flex flex-wrap gap-2">
        <label className="text-xs text-gray-600">
          Qty
          <input
            type="number"
            min={1}
            max={999}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="ml-1 w-16 rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-gray-600">
          Condition
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className="ml-1 rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">Not set</option>
            {CONDITION_OPTIONS.map((c) => (
              <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-600">
          Sale type
          <select
            value={saleTypePreference}
            onChange={(e) => setSaleTypePreference(e.target.value)}
            className="ml-1 rounded border border-gray-300 px-2 py-1 text-sm"
          >
            {Object.entries(SALE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        maxLength={500}
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSave({ quantity, condition: condition || null, notes: notes || null, saleTypePreference: saleTypePreference || null })}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 transition-colors"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
