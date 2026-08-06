'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { CatalogImageSearch } from '@/components/store/CatalogImageSearch'
import { CatalogModelSearch } from '@/components/shared/CatalogModelSearch'
import { searchCatalogByImage } from '@/lib/actions/catalogImageMatching'
import {
  getOrCreateDraftSession,
  addCaptureItem,
  cancelCaptureSession,
  checkCollectionDuplicate,
  updateExistingCollectionQuantity,
  type CaptureDestination,
  type CaptureItemResult,
  type ExistingCollectionInfo,
} from '@/lib/actions/mobileCapture'
import { type CatalogSearchResult, formatCatalogResult } from '@/lib/catalogFormat'

// Wizard step ordering
type Step = 'destination' | 'capture' | 'dup_resolution' | 'details' | 'queued'

type Props = {
  presetDestination?: CaptureDestination
}

const CONDITIONS = [
  { value: 'mint',      label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good',      label: 'Good' },
  { value: 'fair',      label: 'Fair' },
  { value: 'poor',      label: 'Poor' },
  { value: 'damaged',   label: 'Damaged' },
]

const SALE_TYPES = [
  { value: 'consignment', label: 'Consignment (we sell it, split the proceeds)' },
  { value: 'buyout',      label: 'Direct buyout (we buy it outright)' },
  { value: 'unsure',      label: 'Not sure yet' },
]

export function CaptureWizard({ presetDestination }: Props) {
  const router = useRouter()

  const [step,        setStep]        = useState<Step>(presetDestination ? 'capture' : 'destination')
  const [destination, setDestination] = useState<CaptureDestination | null>(presetDestination ?? null)
  const [sessionId,   setSessionId]   = useState<string | null>(null)
  const [queueCount,  setQueueCount]  = useState(0)
  const [selected,    setSelected]    = useState<CatalogSearchResult | null>(null)

  // Duplicate resolution state
  const [existingItem,    setExistingItem]    = useState<ExistingCollectionInfo | null>(null)
  const [updateQtyInput,  setUpdateQtyInput]  = useState('')
  const [dupResError,     setDupResError]     = useState<string | null>(null)
  const [dupResWorking,   setDupResWorking]   = useState(false)

  // Details form state
  const [quantity,         setQuantity]         = useState(1)
  const [acquisitionDate,  setAcquisitionDate]  = useState('')
  const [condition,        setCondition]        = useState('')
  const [notes,            setNotes]            = useState('')
  const [isPublic,         setIsPublic]         = useState(false)
  const [saleType,         setSaleType]         = useState('')
  const [submitting,       setSubmitting]       = useState(false)
  const [addError,         setAddError]         = useState<string | null>(null)
  const [lastAdded,        setLastAdded]        = useState<CaptureItemResult | null>(null)

  // Cancel state
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const [cancelWorking, setCancelWorking] = useState(false)
  const [cancelError,   setCancelError]   = useState<string | null>(null)

  const resetDetails = useCallback(() => {
    setQuantity(1); setAcquisitionDate(''); setCondition(''); setNotes('')
    setIsPublic(false); setSaleType(''); setAddError(null)
    setExistingItem(null); setDupResError(null); setUpdateQtyInput('')
  }, [])

  async function chooseDestination(dest: CaptureDestination) {
    setDestination(dest)
    const res = await getOrCreateDraftSession(dest)
    if (!res.ok) { setAddError(res.error); return }
    setSessionId(res.data.sessionId)
    setQueueCount(res.data.itemCount)
    setStep('capture')
  }

  async function handleModelSelect(model: CatalogSearchResult) {
    setSelected(model)
    resetDetails()

    if (destination === 'collection') {
      const res = await checkCollectionDuplicate(model.id)
      if (res.ok && res.data.isDuplicate) {
        setExistingItem(res.data.existing)
        setUpdateQtyInput(String(res.data.existing.quantity))
        setStep('dup_resolution')
        return
      }
    }

    setStep('details')
  }

  // Duplicate resolution: user chooses to update existing quantity
  async function handleUpdateExisting() {
    if (!selected || !existingItem) return
    setDupResWorking(true)
    setDupResError(null)

    const parsed = parseInt(updateQtyInput, 10)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999) {
      setDupResError('Quantity must be 1–999.')
      setDupResWorking(false)
      return
    }

    const res = await updateExistingCollectionQuantity(existingItem.id, parsed, existingItem.updatedAt)
    setDupResWorking(false)
    if (!res.ok) {
      setDupResError(res.error)
      return
    }

    // Success: model resolved, go back to capture without queuing
    setSelected(null)
    resetDetails()
    setStep('capture')
  }

  // Duplicate resolution: user chooses to skip this model entirely
  function handleSkipDuplicate() {
    setSelected(null)
    resetDetails()
    setStep('capture')
  }

  async function handleAdd() {
    if (!selected || !sessionId || !destination) return
    setSubmitting(true)
    setAddError(null)

    // clientToken: contains model ID, timestamp, and entropy — server verifies catalogModelId matches
    const clientToken = `${selected.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`

    const res = await addCaptureItem(sessionId, {
      catalogModelId:     selected.id,
      quantity,
      acquisitionDate:    destination === 'collection' && acquisitionDate ? acquisitionDate : null,
      condition:          condition || null,
      notes:              notes.trim() || null,
      isPublic,
      saleTypePreference: destination === 'sell' ? saleType || null : null,
      clientToken,
    })

    setSubmitting(false)
    if (!res.ok) { setAddError(res.error); return }

    setLastAdded(res.data)
    setQueueCount(c => c + 1)
    setStep('queued')
  }

  function captureNext() {
    setSelected(null)
    resetDetails()
    setStep('capture')
  }

  function goToReview() {
    if (sessionId) router.push(`/account/capture/review?session=${sessionId}`)
  }

  async function handleCancelSession() {
    if (!sessionId) return
    setCancelWorking(true)
    setCancelError(null)
    const res = await cancelCaptureSession(sessionId)
    setCancelWorking(false)
    if (!res.ok) { setCancelError(res.error); return }
    router.push('/account')
  }

  // ── Destination step ───────────────────────────────────────────────────────
  if (step === 'destination') {
    return (
      <div className="flex flex-col gap-4 py-6">
        <h2 className="text-lg font-semibold text-gray-900">What are you capturing?</h2>
        <button
          onClick={() => chooseDestination('collection')}
          className="rounded-xl border-2 border-gray-200 p-5 text-left hover:border-blue-500 hover:bg-blue-50 transition-colors"
        >
          <div className="font-medium text-gray-900">Add to My Collection</div>
          <div className="text-sm text-gray-500 mt-1">Track items you own</div>
        </button>
        <button
          onClick={() => chooseDestination('sell')}
          className="rounded-xl border-2 border-gray-200 p-5 text-left hover:border-green-500 hover:bg-green-50 transition-colors"
        >
          <div className="font-medium text-gray-900">Submit to Sell</div>
          <div className="text-sm text-gray-500 mt-1">Send items to CollectNTrades to sell</div>
        </button>
        {addError && <p className="text-sm text-red-600">{addError}</p>}
      </div>
    )
  }

  // ── Capture step ───────────────────────────────────────────────────────────
  if (step === 'capture') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            {destination === 'collection' ? 'Add to Collection' : 'Submit to Sell'}
          </h2>
          <div className="flex items-center gap-3">
            {queueCount > 0 && (
              <button
                onClick={goToReview}
                className="text-sm font-medium text-blue-600 hover:text-blue-800"
              >
                Review queue ({queueCount})
              </button>
            )}
            {sessionId && !cancelConfirm && (
              <button
                onClick={() => setCancelConfirm(true)}
                className="text-sm text-gray-400 hover:text-red-600"
              >
                Cancel batch
              </button>
            )}
          </div>
        </div>

        {cancelConfirm && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
            <p className="text-sm font-medium text-red-800">
              Cancel this batch? All {queueCount} queued item{queueCount !== 1 ? 's' : ''} will be discarded.
            </p>
            {cancelError && <p className="text-xs text-red-600">{cancelError}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleCancelSession}
                disabled={cancelWorking}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {cancelWorking ? 'Cancelling…' : 'Yes, cancel batch'}
              </button>
              <button
                onClick={() => { setCancelConfirm(false); setCancelError(null) }}
                disabled={cancelWorking}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Keep capturing
              </button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-2">Search by photo</p>
            {/* CatalogImageSearch: uses existing 12G-C action; preview is a local object URL
                revoked on replace/unmount inside the component; image bytes never enter the
                capture session or any Prisma model. */}
            <CatalogImageSearch
              onSelect={handleModelSelect}
              searchAction={searchCatalogByImage}
            />
          </div>
          <div>
            <p className="text-sm text-gray-600 mb-2">Or search by name</p>
            <CatalogModelSearch
              name="catalogId"
              placeholder="Brand, name, year…"
              onSelect={m => m && handleModelSelect(m)}
            />
          </div>
        </div>
      </div>
    )
  }

  // ── Duplicate resolution step ──────────────────────────────────────────────
  // Only shown when destination === 'collection' and the model is already there.
  // User must explicitly choose: update existing quantity OR skip.
  // No silent duplicate creation; no silent quantity increment.
  if (step === 'dup_resolution' && selected && existingItem) {
    return (
      <div className="flex flex-col gap-4">
        <button
          onClick={handleSkipDuplicate}
          className="text-sm text-gray-500 hover:text-gray-700 self-start"
        >
          ← Back
        </button>

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
          <p className="font-medium text-amber-900 text-sm">Already in your collection</p>
          <p className="text-sm text-amber-800 mt-1">
            {formatCatalogResult(selected)} is already in your collection (current quantity: {existingItem.quantity}).
          </p>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-700">What would you like to do?</p>

          {/* Update existing quantity */}
          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <p className="text-sm font-medium text-gray-900">Update existing quantity</p>
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-600 shrink-0">New total quantity:</label>
              <input
                type="number"
                min={1}
                max={999}
                value={updateQtyInput}
                onChange={e => setUpdateQtyInput(e.target.value)}
                className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                disabled={dupResWorking}
              />
            </div>
            {dupResError && <p className="text-xs text-red-600">{dupResError}</p>}
            <button
              onClick={handleUpdateExisting}
              disabled={dupResWorking}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {dupResWorking ? 'Updating…' : 'Update quantity'}
            </button>
          </div>

          {/* Skip */}
          <button
            onClick={handleSkipDuplicate}
            className="w-full rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-600 hover:bg-gray-50"
          >
            Skip — leave collection unchanged
          </button>
        </div>
      </div>
    )
  }

  // ── Details step ───────────────────────────────────────────────────────────
  if (step === 'details' && selected) {
    return (
      <div className="flex flex-col gap-4">
        <button
          onClick={() => { setStep('capture'); setSelected(null); resetDetails() }}
          className="text-sm text-gray-500 hover:text-gray-700 self-start"
        >
          ← Back
        </button>

        <div className="rounded-lg bg-gray-50 p-3 text-sm">
          <span className="font-medium text-gray-900">{formatCatalogResult(selected)}</span>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number"
              min={1}
              max={999}
              value={quantity}
              onChange={e => setQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-24 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Condition</label>
            <select
              value={condition}
              onChange={e => setCondition(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm w-full"
            >
              <option value="">— select —</option>
              {CONDITIONS.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          {destination === 'collection' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Acquisition date <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                type="date"
                value={acquisitionDate}
                onChange={e => setAcquisitionDate(e.target.value)}
                max={new Date().toISOString().split('T')[0]}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
          )}

          {destination === 'sell' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sale preference</label>
              <select
                value={saleType}
                onChange={e => setSaleType(e.target.value)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm w-full"
              >
                <option value="">— select —</option>
                {SALE_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm resize-none"
            />
          </div>

          {destination === 'collection' && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={e => setIsPublic(e.target.checked)}
                className="rounded border-gray-300"
              />
              Share publicly on my profile
            </label>
          )}
        </div>

        {addError && <p className="text-sm text-red-600">{addError}</p>}

        <button
          onClick={handleAdd}
          disabled={submitting}
          className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Adding…' : 'Add to queue'}
        </button>
      </div>
    )
  }

  // ── Queued confirmation ────────────────────────────────────────────────────
  if (step === 'queued' && lastAdded) {
    return (
      <div className="flex flex-col gap-4 py-4 text-center">
        <div className="text-4xl">✓</div>
        <p className="font-medium text-gray-900">
          {lastAdded.brand} {lastAdded.name} added to queue
        </p>
        <p className="text-sm text-gray-500">{queueCount} item{queueCount !== 1 ? 's' : ''} queued</p>

        <div className="flex flex-col gap-2 mt-2">
          <button
            onClick={captureNext}
            className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Capture next
          </button>
          <button
            onClick={goToReview}
            className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700"
          >
            Review &amp; submit ({queueCount})
          </button>
        </div>
      </div>
    )
  }

  return null
}
