'use server'

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import {
  getOrCreateDraftSession,
  addCaptureItem,
  updateCaptureItem,
  removeCaptureItem,
  getCaptureSession,
  submitCaptureSession,
} from '@/lib/actions/mobileCapture'
import {
  addGuestSellerItem,
  updateGuestSellerItem,
  removeGuestSellerItem,
  getGuestSellerBatch,
  type GuestSellerItemInput,
  type UpdateGuestSellerItemInput,
} from '@/lib/actions/guestSeller'
import { searchCatalogModels } from '@/lib/catalogSearch'
import type { CatalogMatchResult } from '@/lib/catalogMatching'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string; existingItemId?: string }
type AR<T> = Ok<T> | Err

// 19B section 21/29: ONE customer-facing capture UI (SellCaptureFlow) — the
// persistence backend is chosen here, invisibly, based on whether a valid
// buyer_session exists. Signed-in customers use the existing, unmodified
// authenticated MobileCaptureSession(destination='sell') pipeline; signed-out
// visitors use GuestSellerSession/Item. Neither mobileCapture.ts nor
// guestSeller.ts is modified to know about the other, or even that this
// wrapper exists.
export type SellItemInput = GuestSellerItemInput
export type UpdateSellItemInput = UpdateGuestSellerItemInput

export type SellItemResult = {
  id: string
  catalogModelId: string
  brand: string
  name: string
  year: number | null
  quantity: number
  condition: string | null
  notes: string | null
  saleTypePreference: string | null
  clientToken: string
  updatedAt: string
}

export type SellBatch = { items: SellItemResult[] }

function toSellItemResult(item: {
  id: string; catalogModelId: string; brand: string; name: string; year: number | null;
  quantity: number; condition: string | null; notes: string | null;
  saleTypePreference: string | null; clientToken: string; updatedAt: string;
}): SellItemResult {
  return {
    id:                 item.id,
    catalogModelId:     item.catalogModelId,
    brand:              item.brand,
    name:               item.name,
    year:               item.year,
    quantity:           item.quantity,
    condition:          item.condition,
    notes:              item.notes,
    saleTypePreference: item.saleTypePreference,
    clientToken:        item.clientToken,
    updatedAt:          item.updatedAt,
  }
}

// Read-only — never creates a MobileCaptureSession merely to check for one.
// Mirrors GuestSellerSession's own "GET writes zero rows" invariant for the
// authenticated backend too: visiting /sell must never write a row for anyone,
// signed in or not. A session is only ever minted at actual add-item time.
async function peekMobileCaptureSessionId(profileId: string): Promise<string | null> {
  const session = await prisma.mobileCaptureSession.findFirst({
    where: { customerProfileId: profileId, destination: 'sell', status: 'draft' },
    select: { id: true },
  })
  return session?.id ?? null
}

// Backend selection is keyed on AUTH STATE ITSELF, never on "does a
// MobileCaptureSession happen to already exist" — an authenticated visitor
// with no session yet must still be treated as authenticated (empty batch,
// never falls through to reading/mutating an unrelated guest cookie). Mixing
// those two questions was a real bug caught by this milestone's own tests:
// an authenticated peek returning null must never be treated as "anonymous."
type AuthBackend =
  | { authenticated: false }
  | { authenticated: true; sessionId: string | null }

async function resolveBackend(): Promise<AuthBackend> {
  const session = await getBuyerSession()
  if (!session) return { authenticated: false }
  const sessionId = await peekMobileCaptureSessionId(session.profileId)
  return { authenticated: true, sessionId }
}

const NOT_FOUND: Err = { ok: false, error: 'Item not found.' }

export async function addSellItem(input: SellItemInput): Promise<AR<SellItemResult>> {
  const session = await getBuyerSession()

  if (session) {
    const draft = await getOrCreateDraftSession('sell')
    if (!draft.ok) return draft
    const result = await addCaptureItem(draft.data.sessionId, {
      catalogModelId:     input.catalogModelId,
      quantity:           input.quantity,
      acquisitionDate:    null,
      condition:          input.condition,
      notes:              input.notes,
      isPublic:           false,
      saleTypePreference: input.saleTypePreference,
      clientToken:        input.clientToken,
    })
    if (!result.ok) return result
    return { ok: true, data: toSellItemResult(result.data) }
  }

  const result = await addGuestSellerItem(input)
  if (!result.ok) return result
  return { ok: true, data: toSellItemResult(result.data) }
}

export async function updateSellItem(
  itemId: string,
  updates: UpdateSellItemInput,
  updatedAt: string,
): Promise<AR<SellItemResult>> {
  const backend = await resolveBackend()

  if (backend.authenticated) {
    if (!backend.sessionId) return NOT_FOUND // no session ⇒ no items ⇒ nothing to update
    const result = await updateCaptureItem(itemId, backend.sessionId, updates, updatedAt)
    if (!result.ok) return result
    return { ok: true, data: toSellItemResult(result.data) }
  }

  const result = await updateGuestSellerItem(itemId, updates, updatedAt)
  if (!result.ok) return result
  return { ok: true, data: toSellItemResult(result.data) }
}

export async function removeSellItem(itemId: string): Promise<AR<{ removed: boolean }>> {
  const backend = await resolveBackend()

  if (backend.authenticated) {
    if (!backend.sessionId) return { ok: true, data: { removed: false } }
    return removeCaptureItem(itemId, backend.sessionId)
  }

  return removeGuestSellerItem(itemId)
}

// Read-only — safe to call on every /sell GET render.
export async function getSellBatch(): Promise<SellBatch> {
  const backend = await resolveBackend()

  if (backend.authenticated) {
    if (!backend.sessionId) return { items: [] } // never falls through to reading a guest cookie
    const result = await getCaptureSession(backend.sessionId)
    if (!result.ok) return { items: [] }
    return { items: result.data.items.map(toSellItemResult) }
  }

  const guestBatch = await getGuestSellerBatch()
  return { items: guestBatch.items.map(toSellItemResult) }
}

// 19B section 29: a signed-in visitor's /sell always shows their authenticated
// MobileCapture batch — an existing guest cookie is never read as the active
// batch while signed in (auth always wins the backend selection above). Their
// guest work is never deleted, merged, or auto-claimed either (19C does that),
// so this only reports whether an unclaimed guest batch ALSO exists, purely
// for a one-line, non-destructive notice.
export async function getUnclaimedGuestBatchCount(): Promise<number> {
  const session = await getBuyerSession()
  if (!session) return 0 // anonymous visitors ARE the guest batch — nothing "extra" to report
  const guestBatch = await getGuestSellerBatch()
  return guestBatch.items.length
}

// 19C: the explicit final-submission action for the authenticated backend only
// — a guest has no MobileCaptureSession to submit (they must claim first).
// Resolves the session id itself (never trusts a client-supplied id) and calls
// the existing, unmodified submitCaptureSession — zero duplicate
// SellerSubmission-creation logic.
export async function submitSellBatch(): Promise<AR<{ submitted: boolean }>> {
  const session = await getBuyerSession()
  if (!session) return { ok: false, error: 'Sign in to submit your selling batch.' }

  const sessionId = await peekMobileCaptureSessionId(session.profileId)
  if (!sessionId) return { ok: false, error: 'No items to submit.' }

  const result = await submitCaptureSession(sessionId)
  if (!result.ok) return result
  return { ok: true, data: { submitted: result.data.submitted } }
}

// ── Manual catalog search fallback (item 26) ──────────────────────────────────
// Plain reuse of the existing public text-search engine (same one /catalog's own
// GET-form search uses) — read-only, no auth, no new CatalogSuggestion creation.
export async function searchModelsForSell(query: string): Promise<CatalogMatchResult[]> {
  return searchCatalogModels(query)
}
