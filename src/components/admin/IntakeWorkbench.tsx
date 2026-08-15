'use client'

// 15D: Bulk Intake Workbench — continuous, keyboard/scanner-first entry for one
// SellerInboundShipment. Batch context (seller/portfolio/agreement/shipment) is
// loaded once by the server page and never re-fetched per keystroke (section 28).

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CatalogModelCombobox } from '@/components/admin/CatalogModelCombobox'
import type { CatalogMatchResult } from '@/lib/catalogMatching'
import { adminSearchCatalogByImage } from '@/lib/actions/catalogImageMatching'
import type { CatalogMatchCandidate } from '@/lib/catalogImageMatching'
import {
  confirmWorkbenchItem,
  getWorkbenchPricingAdvisory,
  claimWorkbenchLease,
  renewWorkbenchLease,
  releaseWorkbenchLease,
  reconcileWorkbenchShipment,
  type WorkbenchUnitResult,
  type WorkbenchPricingAdvisory,
} from '@/lib/actions/intakeWorkbench'

const CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged']
const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint', near_mint: 'Near Mint', good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
}
const LEASE_RENEW_MS = 2 * 60 * 1000

type ResolvedCatalog = { id: string; label: string; confidence: 'exact' | 'strong' | 'possible' | 'search' }
type StorageMatch = { id: string; label: string }

export type WorkbenchContextProps = {
  shipmentId: string
  shipmentLabel: string
  shipmentStatus: string
  sellerLabel: string
  portfolioName: string | null
  agreementStatus: string | null
  expected: number
  received: number | null
  processed: number
  exceptions: number
  remaining: number | null
  defaultCondition: string | null
  defaultCardedOrLoose: string | null
  recentItems: Array<{ id: string; sku: string; catalogLabel: string; storageLabel: string | null }>
  reconciliation: {
    status: 'in_progress' | 'reconciled' | 'reconciled_with_variance'
    observedPhysical: number
    variance: number | null
    hasUnresolvedExceptions: boolean
    lastReconciledAt: Date | null
  }
}

const RECONCILIATION_LABELS: Record<WorkbenchContextProps['reconciliation']['status'], string> = {
  in_progress: 'In progress',
  reconciled: 'Reconciled',
  reconciled_with_variance: 'Reconciled with variance',
}

function confidenceBadge(c: 'exact' | 'strong' | 'possible'): { text: string; className: string } {
  if (c === 'exact') return { text: 'High confidence', className: 'bg-green-100 text-green-700' }
  if (c === 'strong') return { text: 'Medium confidence', className: 'bg-blue-100 text-blue-700' }
  return { text: 'Low confidence', className: 'bg-amber-100 text-amber-700' }
}

export function IntakeWorkbench({ context }: { context: WorkbenchContextProps }) {
  const [formSeq, setFormSeq] = useState(0)
  const [catalog, setCatalog] = useState<ResolvedCatalog | null>(null)
  const [imageCandidates, setImageCandidates] = useState<CatalogMatchCandidate[]>([])
  const [imageBusy, setImageBusy] = useState(false)
  const [condition, setCondition] = useState(context.defaultCondition ?? '')
  const [cardedOrLoose, setCardedOrLoose] = useState(context.defaultCardedOrLoose ?? '')
  const [conditionNotes, setConditionNotes] = useState('')
  const [notes, setNotes] = useState('')
  const [quantity, setQuantity] = useState(1)

  const [storageQuery, setStorageQuery] = useState('')
  const [storageResolved, setStorageResolved] = useState<StorageMatch | null>(null)
  const [storageMatches, setStorageMatches] = useState<StorageMatch[]>([])
  const [storageLoading, setStorageLoading] = useState(false)

  const [pricing, setPricing] = useState<WorkbenchPricingAdvisory | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'exception' | 'error'; lines: string[] } | null>(null)

  const [progress, setProgress] = useState({
    processed: context.processed, exceptions: context.exceptions, remaining: context.remaining,
  })
  const [recentItems, setRecentItems] = useState(context.recentItems)
  const [reconciliation, setReconciliation] = useState(context.reconciliation)
  const [reconciling, setReconciling] = useState(false)

  const [leaseWarning, setLeaseWarning] = useState<string | null>(null)
  const claimTokenRef = useRef<string | null>(null)
  if (claimTokenRef.current === null) claimTokenRef.current = crypto.randomUUID()

  const modelWrapRef = useRef<HTMLDivElement>(null)
  const storageInputRef = useRef<HTMLInputElement>(null)
  const storageDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Lease claim/renew/release (section 21, informational only) ───────────────────
  useEffect(() => {
    let cancelled = false
    void claimWorkbenchLease(context.shipmentId, claimTokenRef.current!).then((r) => {
      if (!cancelled && r.held && !r.heldByMe) {
        setLeaseWarning(`Another session is actively working this shipment${r.expiresAt ? ` (expires ${new Date(r.expiresAt).toLocaleTimeString()})` : ''}.`)
      }
    })
    const interval = setInterval(() => {
      void renewWorkbenchLease(context.shipmentId, claimTokenRef.current!)
    }, LEASE_RENEW_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
      void releaseWorkbenchLease(context.shipmentId, claimTokenRef.current!)
    }
  }, [context.shipmentId])

  function takeOverLease() {
    void claimWorkbenchLease(context.shipmentId, claimTokenRef.current!, true).then(() => setLeaseWarning(null))
  }

  // ── Storage resolution (section 9) — bounded search, exact-match auto-resolve for
  // scanner speed; server re-validates at confirm regardless of client state. ───────
  const searchStorage = useCallback((q: string) => {
    const trimmed = q.trim()
    if (!trimmed) { setStorageMatches([]); setStorageResolved(null); return }
    setStorageLoading(true)
    fetch(`/api/admin/storage-locations/search?q=${encodeURIComponent(trimmed)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: StorageMatch[]) => {
        setStorageMatches(rows)
        const exact = rows.find((r) => r.label.toLowerCase() === trimmed.toLowerCase())
        setStorageResolved(exact ?? null)
      })
      .catch(() => setStorageMatches([]))
      .finally(() => setStorageLoading(false))
  }, [])

  function onStorageChange(v: string) {
    setStorageQuery(v)
    setStorageResolved(null)
    if (storageDebounceRef.current) clearTimeout(storageDebounceRef.current)
    storageDebounceRef.current = setTimeout(() => searchStorage(v), 200)
  }

  function pickStorage(m: StorageMatch) {
    setStorageResolved(m)
    setStorageQuery(m.label)
    setStorageMatches([])
  }

  // ── Pricing advisory (14C, section 18/19) — fetched only for the selected model.
  // The null case is cleared directly by the selection handlers below (event
  // handlers, not effect bodies), so this effect only ever needs to fetch. ──────────
  useEffect(() => {
    if (!catalog) return
    let cancelled = false
    void getWorkbenchPricingAdvisory(catalog.id, catalog.confidence === 'search' ? null : catalog.confidence).then((r) => {
      if (!cancelled) setPricing(r)
    })
    return () => { cancelled = true }
  }, [catalog])

  function onModelSelect(model: CatalogMatchResult | null) {
    setCatalog(model ? { id: model.id, label: `${model.brand} ${model.name}`, confidence: 'search' } : null)
    setImageCandidates([])
    if (!model) setPricing(null)
  }

  async function onImagePick(file: File | null) {
    if (!file) return
    setImageBusy(true)
    setImageCandidates([])
    const fd = new FormData()
    fd.set('image', file)
    const result = await adminSearchCatalogByImage(null, fd)
    setImageBusy(false)
    if (result && 'results' in result && result.results) setImageCandidates(result.results)
  }

  function pickImageCandidate(c: CatalogMatchCandidate) {
    setCatalog({ id: c.catalogModelId, label: `${c.brand} ${c.name}`, confidence: c.confidence })
    setImageCandidates([])
  }

  function resetForm() {
    setFormSeq((n) => n + 1)
    setCatalog(null)
    setImageCandidates([])
    setConditionNotes('')
    setNotes('')
    setQuantity(1)
    setStorageQuery('')
    setStorageResolved(null)
    setStorageMatches([])
    setPricing(null)
    // condition/cardedOrLoose intentionally keep their last (batch-typical) value —
    // most physical units in one shipment share condition/type, saving re-selection.
  }

  async function handleConfirm() {
    if (busy) return
    if (!catalog) { setFeedback({ kind: 'error', lines: ['Select a catalog model first.'] }); return }
    if (!storageResolved) { setFeedback({ kind: 'error', lines: ['Scan or select a valid storage location first.'] }); return }
    if (!condition || !cardedOrLoose) { setFeedback({ kind: 'error', lines: ['Condition and carded/loose are required.'] }); return }

    setBusy(true)
    const result = await confirmWorkbenchItem({
      shipmentId: context.shipmentId,
      claimToken: claimTokenRef.current!,
      clientToken: crypto.randomUUID(),
      quantity,
      catalogModelId: catalog.id,
      condition,
      cardedOrLoose,
      conditionNotes: conditionNotes.trim() || null,
      storageLocationId: storageResolved.id,
      notes: notes.trim() || null,
    })
    setBusy(false)

    if (!result.ok) {
      setFeedback({ kind: 'error', lines: [result.error] })
      return
    }

    const converted = result.units.filter((u): u is Extract<WorkbenchUnitResult, { outcome: 'converted' }> => u.outcome === 'converted')
    const exceptions = result.units.filter((u) => u.outcome === 'exception')

    setProgress((p) => ({
      processed: p.processed + converted.length,
      exceptions: p.exceptions + exceptions.length,
      remaining: p.remaining == null ? null : Math.max(0, p.remaining - converted.length - exceptions.length),
    }))
    // Counts just changed — any previously-known reconciliation snapshot is now stale
    // (matches the server's isReconciliationCurrent check), so drop back to
    // "in progress" immediately rather than showing a misleadingly-still-reconciled label.
    if (converted.length > 0 || exceptions.length > 0) {
      setReconciliation((r) => (r.status === 'in_progress' ? r : { ...r, status: 'in_progress', lastReconciledAt: null }))
    }
    if (converted.length > 0) {
      setRecentItems((prev) => [
        ...converted.map((u) => ({ id: u.itemId, sku: u.sku, catalogLabel: u.catalogLabel, storageLabel: u.storageLabel })),
        ...prev,
      ].slice(0, 10))
    }

    if (converted.length > 0 && exceptions.length === 0) {
      setFeedback({ kind: 'success', lines: converted.map((u) => `✓ ${u.sku} — ${u.catalogLabel} — Stored ${u.storageLabel}`) })
    } else if (converted.length === 0) {
      setFeedback({ kind: 'exception', lines: exceptions.map((u) => `Saved as exception: ${(u as { note: string }).note}`) })
    } else {
      setFeedback({ kind: 'exception', lines: [`${converted.length} converted, ${exceptions.length} sent to exceptions.`] })
    }

    resetForm()
  }

  // ── Reconciliation ("Finish intake") — explicit, audited action. Never implied by
  // remaining===0; the server re-fetches counts fresh and persists the snapshot. ────
  async function handleReconcile() {
    if (reconciling) return
    setReconciling(true)
    const result = await reconcileWorkbenchShipment(context.shipmentId, claimTokenRef.current!)
    setReconciling(false)
    if (!result.ok) {
      setFeedback({ kind: 'error', lines: [result.error] })
      return
    }
    setReconciliation({
      status: result.variance === 0 ? 'reconciled' : 'reconciled_with_variance',
      observedPhysical: result.observedPhysical,
      variance: result.variance,
      hasUnresolvedExceptions: result.hasUnresolvedExceptions,
      lastReconciledAt: new Date(),
    })
    setFeedback({
      kind: result.variance === 0 ? 'success' : 'exception',
      lines: [
        result.variance === 0
          ? `Reconciled — ${result.observedPhysical} physically observed matches ${result.recordedReceived} recorded received.`
          : `Reconciled with variance: ${result.observedPhysical} physically observed vs ${result.recordedReceived} recorded received (${result.variance > 0 ? '+' : ''}${result.variance}).`,
        ...(result.hasUnresolvedExceptions ? ['Unresolved exceptions remain — see recent items / 15E queue.'] : []),
      ],
    })
  }

  // ── Shortcuts (section 6): Enter on quantity/storage confirms; scoped keydown
  // handlers only — never a document-wide Enter listener that could double-fire
  // against the catalog combobox's own Enter handling. ─────────────────────────────
  function onFieldEnter(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); void handleConfirm() }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        modelWrapRef.current?.querySelector('input')?.focus()
      } else if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        storageInputRef.current?.focus()
      } else if (e.key === 'Escape') {
        resetForm()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const canConfirm = !!catalog && !!storageResolved && !!condition && !!cardedOrLoose && !busy

  // Live preview (section 2/3) — always recomputed from current local counts, never
  // waiting on an explicit reconcile call. Only the STATUS label (in
  // progress/reconciled/reconciled with variance) depends on the last explicit
  // reconciliation action, and is reset to "in progress" the moment counts change.
  const liveObserved = progress.processed + progress.exceptions
  const liveVariance = context.received != null ? liveObserved - context.received : null

  return (
    <div className="max-w-3xl">
      {/* Batch context header (section 4) — static, loaded once. */}
      <div className="sticky top-0 z-10 mb-4 rounded-md border border-gray-200 bg-white p-3 shadow-sm text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-semibold text-gray-900">{context.shipmentLabel}</span>
          <span className="text-gray-500">{context.sellerLabel}</span>
          {context.portfolioName && <span className="text-gray-500">{context.portfolioName}</span>}
          <span className="text-gray-500">Agreement {context.agreementStatus ?? '—'}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-gray-600">
          <span>Expected shipment {context.expected}</span>
          <span>Recorded received {context.received ?? '—'}</span>
          <span className="font-medium text-gray-900">Processed {progress.processed}{context.received != null ? ` / ${context.received}` : ''}</span>
          {progress.exceptions > 0 && (
            <Link href={`/admin/intake/exceptions?shipmentId=${context.shipmentId}`} className="font-medium text-red-700 hover:underline">
              Exceptions {progress.exceptions} · Review →
            </Link>
          )}
          {progress.remaining != null && <span>Remaining {progress.remaining}</span>}
        </div>
        {/* Reconciliation (15D-review reconciliation pass, sections 2/3) — never
            implied by remaining===0; requires the explicit "Finish intake" action. */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-100 pt-2">
          <span className="text-gray-600">Physically observed {liveObserved}</span>
          {liveVariance != null && (
            <span className={liveVariance === 0 ? 'text-gray-600' : 'font-medium text-amber-700'}>
              Variance {liveVariance > 0 ? `+${liveVariance}` : liveVariance}
            </span>
          )}
          <span
            className={`font-medium ${
              reconciliation.status === 'reconciled' ? 'text-green-700'
                : reconciliation.status === 'reconciled_with_variance' ? 'text-amber-700'
                : 'text-gray-500'
            }`}
          >
            Intake: {RECONCILIATION_LABELS[reconciliation.status]}
          </span>
          {reconciliation.hasUnresolvedExceptions && reconciliation.status !== 'in_progress' && (
            <span className="text-red-700">· exceptions remain</span>
          )}
          {context.received != null && (
            <button
              type="button"
              onClick={() => void handleReconcile()}
              disabled={reconciling}
              className="ml-auto rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              {reconciling ? 'Reconciling…' : 'Finish intake / Reconcile shipment'}
            </button>
          )}
        </div>
        {leaseWarning && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-amber-50 border border-amber-200 px-2 py-1 text-xs text-amber-800">
            <span>{leaseWarning}</span>
            <button type="button" onClick={takeOverLease} className="font-medium underline shrink-0">Take over</button>
          </div>
        )}
      </div>

      {feedback && (
        <div
          className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            feedback.kind === 'success' ? 'border-green-200 bg-green-50 text-green-800'
              : feedback.kind === 'exception' ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {feedback.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {/* Continuous entry form (section 5/6) */}
      <div className="rounded-md border border-gray-200 bg-white p-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Model (Ctrl/Cmd+K)</label>
          <div ref={modelWrapRef}>
            <CatalogModelCombobox key={formSeq} name="catalogModelId" onSelect={onModelSelect} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="file" accept="image/jpeg,image/png,image/webp"
              onChange={(e) => void onImagePick(e.target.files?.[0] ?? null)}
              className="text-xs text-gray-500"
            />
            {imageBusy && <span className="text-xs text-gray-400">Matching photo…</span>}
          </div>
          {imageCandidates.length > 0 && (
            <ul className="mt-2 space-y-1">
              {imageCandidates.slice(0, 3).map((c) => {
                const badge = confidenceBadge(c.confidence)
                return (
                  <li key={c.catalogModelId}>
                    <button
                      type="button"
                      onClick={() => pickImageCandidate(c)}
                      className="w-full flex items-center justify-between gap-2 rounded-md border border-gray-200 px-2 py-1.5 text-left text-sm hover:bg-gray-50"
                    >
                      <span>{c.brand} {c.name} {c.year ? `(${c.year})` : ''}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.text}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {pricing && (
            <p className="mt-2 text-xs text-gray-500">
              Est. value {pricing.estimatedValueCents != null ? `$${(pricing.estimatedValueCents / 100).toFixed(2)}` : '—'}
              {pricing.targetCents != null && pricing.lowCents != null && pricing.highCents != null && (
                <> · Recommended ${(pricing.lowCents / 100).toFixed(0)}–${(pricing.highCents / 100).toFixed(0)}</>
              )}
              {' · '}Confidence {pricing.confidence}
              {pricing.isAskOnly && ' (ask-only)'}
              {pricing.riskFlags.length > 0 && (
                <span className="ml-1 text-amber-700">· {pricing.riskFlags.map((f) => f.message).join(' ')}</span>
              )}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Condition</label>
            <select value={condition} onChange={(e) => setCondition(e.target.value)} onKeyDown={onFieldEnter}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              <option value="">Select…</option>
              {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABELS[c]}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Carded / Loose</label>
            <select value={cardedOrLoose} onChange={(e) => setCardedOrLoose(e.target.value)} onKeyDown={onFieldEnter}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              <option value="">Select…</option>
              <option value="carded">Carded</option>
              <option value="loose">Loose</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Storage (Ctrl/Cmd+L — scan or type)</label>
          <input
            ref={storageInputRef}
            type="text"
            value={storageQuery}
            onChange={(e) => onStorageChange(e.target.value)}
            onKeyDown={onFieldEnter}
            placeholder="Scan location code…"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          {storageResolved ? (
            <p className="mt-1 text-xs text-green-700">Resolved: {storageResolved.label}</p>
          ) : storageLoading ? (
            <p className="mt-1 text-xs text-gray-400">Looking up…</p>
          ) : storageMatches.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1">
              {storageMatches.slice(0, 8).map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => pickStorage(m)}
                    className="rounded-md border border-gray-200 px-2 py-0.5 text-xs hover:bg-gray-50">
                    {m.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : storageQuery.trim() ? (
            <p className="mt-1 text-xs text-red-600">No matching storage location.</p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Quantity (identical physical units)</label>
            <input
              type="number" min={1} max={20} value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
              onKeyDown={onFieldEnter}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Condition notes (optional)</label>
            <input type="text" value={conditionNotes} onChange={(e) => setConditionNotes(e.target.value)} onKeyDown={onFieldEnter}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Notes (optional)</label>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={onFieldEnter}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Confirm & Next (Enter)'}
          </button>
          <button type="button" onClick={resetForm} className="text-xs text-gray-500 hover:text-gray-700">Clear (Esc)</button>
        </div>
      </div>

      {/* Recent items strip (section 27) — bounded, no full shipment load. */}
      {recentItems.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-gray-500 mb-1">Recent items this session</h3>
          <ul className="space-y-1">
            {recentItems.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-xs">
                <span className="text-gray-600 truncate">{i.sku} · {i.catalogLabel} · {i.storageLabel ?? '—'}</span>
                <Link href={`/admin/items/${i.id}`} className="shrink-0 text-blue-600 hover:underline">View Item →</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
