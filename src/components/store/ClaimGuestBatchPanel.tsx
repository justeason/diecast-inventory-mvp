'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { claimGuestSellerBatch, type ClaimConflict } from '@/lib/actions/guestSellerClaim'
import { removeGuestSellerItem } from '@/lib/actions/guestSeller'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint', near_mint: 'Near Mint', good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
}
const SALE_TYPE_LABELS: Record<string, string> = {
  unsure: 'Not sure yet', buyout: 'Sell outright', consignment: 'Consign with us',
}

function describeItem(item: { quantity: number; condition: string | null; notes: string | null; saleTypePreference: string | null }): string {
  const parts = [`Qty ${item.quantity}`]
  if (item.condition) parts.push(CONDITION_LABELS[item.condition] ?? item.condition)
  if (item.saleTypePreference) parts.push(SALE_TYPE_LABELS[item.saleTypePreference] ?? item.saleTypePreference)
  if (item.notes) parts.push(`"${item.notes}"`)
  return parts.join(' · ')
}

// 19C: the claim page's only mutating control. A synchronous ref guard (same
// pattern as SellCaptureFlow's addInFlightRef, 19B Final Runtime
// Reconciliation) prevents a fast double-click from firing two concurrent
// claims — the claim transaction is authoritative idempotency regardless, but
// the UI should not intentionally fire duplicate requests.
export function ClaimGuestBatchPanel() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ClaimConflict[] | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  async function handleClaim() {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setPending(true)
    setError(null)
    try {
      const result = await claimGuestSellerBatch()
      if (!result.ok) {
        setError(result.error)
        setConflicts(result.conflicts ?? null)
        return
      }
      router.push('/sell?claimed=1')
    } finally {
      inFlightRef.current = false
      setPending(false)
    }
  }

  // Reuses the existing guest-scoped removeGuestSellerItem action verbatim —
  // authorization still comes from the guest_sell_session cookie, not the
  // customer's own auth state, so this is safe to call even while signed in.
  async function handleRemoveConflict(guestItemId: string) {
    setRemovingId(guestItemId)
    try {
      const result = await removeGuestSellerItem(guestItemId)
      if (result.ok) {
        setConflicts((prev) => prev?.filter((c) => c.guestItemId !== guestItemId) ?? null)
        setError(null)
        router.refresh()
      }
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {conflicts && conflicts.length > 0 && (
        <ul className="space-y-3">
          {conflicts.map((c) => (
            <li key={c.guestItemId} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="font-medium text-gray-900">
                {c.brand} {c.name}{c.year && <span className="text-gray-500 font-normal"> ({c.year})</span>}
              </p>
              <p className="mt-1 text-xs text-gray-600">Saved: {describeItem(c.guest)}</p>
              <p className="text-xs text-gray-600">In your batch: {describeItem(c.target)}</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <Link href="/sell" className="text-xs font-medium text-gray-900 hover:underline underline-offset-2">
                  Edit item in your batch
                </Link>
                <button
                  type="button"
                  onClick={() => handleRemoveConflict(c.guestItemId)}
                  disabled={removingId === c.guestItemId}
                  className="text-xs font-medium text-red-700 hover:underline underline-offset-2 disabled:opacity-40"
                >
                  {removingId === c.guestItemId ? 'Removing…' : 'Remove saved item'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={handleClaim}
        disabled={pending}
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
      >
        {pending ? 'Adding…' : 'Add Saved Items'}
      </button>
    </div>
  )
}
