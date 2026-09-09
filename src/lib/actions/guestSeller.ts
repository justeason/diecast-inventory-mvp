'use server'

import crypto from 'crypto'
import { headers } from 'next/headers'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  getGuestSellerSessionContext,
  generateGuestSellerToken,
  setGuestSellerCookie,
} from '@/lib/guestSellerSession'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'

// 19B: mirrors mobileCapture.ts's VALID_CONDITIONS/VALID_SALE_TYPES exactly.
// Duplicated (not imported) because mobileCapture.ts has 'use server' at the
// top, which restricts every export to an async function — a plain const
// array can't be re-exported from it. Must stay byte-identical to that file's
// own lists.
const VALID_CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'] as const
const VALID_SALE_TYPES = ['consignment', 'buyout', 'unsure'] as const

// Mirrors MobileCapture's MAX_CAPTURE_ITEMS_PER_SESSION — no reason to allow
// anonymous guests a larger allowance than authenticated customers.
const MAX_GUEST_ITEMS_PER_SESSION = 100

// New-SESSION creation only — reusing an existing valid cookie never counts.
const GUEST_SESSION_CREATE_MAX = 5
const GUEST_SESSION_CREATE_WINDOW = 60 * 60 * 1000 // 1 hour

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string; existingItemId?: string }
type AR<T> = Ok<T> | Err

function ok<T>(data: T): Ok<T> { return { ok: true, data } }
function err(msg: string, existingItemId?: string): Err { return { ok: false, error: msg, existingItemId } }

function isPrismaP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}
function p2002ConstraintName(e: unknown): string {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return ''
  return String(e.meta?.target ?? '')
}

// Same shape/purpose as MobileCapture's own fingerprint: detects an exact
// retry (same clientToken, same payload → return existing row) vs a
// conflicting retry (same clientToken, different payload → error). Does not
// include clientToken/sessionId itself.
function computePayloadFingerprint(params: {
  catalogModelId: string
  quantity: number
  condition: string | null
  notes: string | null
  saleTypePreference: string | null
}): string {
  const parts = [
    params.catalogModelId,
    String(params.quantity),
    params.condition ?? '',
    params.notes ?? '',
    params.saleTypePreference ?? '',
  ]
  return crypto.createHash('sha256').update(parts.join('\x00')).digest('hex')
}

export type GuestSellerItemInput = {
  catalogModelId: string
  quantity: number
  condition: string | null
  notes: string | null
  saleTypePreference: string | null
  clientToken: string
}

export type GuestSellerItemResult = {
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

function itemResultFromRow(
  row: {
    id: string; catalogModelId: string; quantity: number; condition: string | null;
    notes: string | null; saleTypePreference: string | null; clientToken: string; updatedAt: Date;
  },
  catalog: { brand: string; name: string; year: number | null },
): GuestSellerItemResult {
  return {
    id:                 row.id,
    catalogModelId:     row.catalogModelId,
    brand:              catalog.brand,
    name:               catalog.name,
    year:               catalog.year,
    quantity:           row.quantity,
    condition:          row.condition,
    notes:              row.notes,
    saleTypePreference: row.saleTypePreference,
    clientToken:        row.clientToken,
    updatedAt:          row.updatedAt.toISOString(),
  }
}

function validateInput(input: GuestSellerItemInput): string | null {
  if (!input.clientToken) return 'Client token is required.'
  if (input.quantity < 1 || input.quantity > 999) return 'Quantity must be 1–999.'
  if (input.condition && !(VALID_CONDITIONS as readonly string[]).includes(input.condition)) return 'Invalid condition.'
  if (input.saleTypePreference && !(VALID_SALE_TYPES as readonly string[]).includes(input.saleTypePreference)) return 'Invalid sale type.'
  if (input.notes && input.notes.length > 500) return 'Notes must be 500 characters or fewer.'
  if (input.notes && /[\x00-\x1F\x7F]/.test(input.notes)) return 'Notes contain invalid characters.'
  return null
}

const ITEM_SELECT = {
  id: true, catalogModelId: true, quantity: true, condition: true,
  notes: true, saleTypePreference: true, clientToken: true, updatedAt: true,
} as const

// ── addGuestSellerItem ────────────────────────────────────────────────────────
// Lazy session creation: GET /sell never creates a row. The FIRST successful
// add for a browser with no valid guest cookie mints a session and creates
// that first item inside ONE transaction — a GuestSellerSession can never
// exist with zero items. The cookie is set only after that transaction has
// actually committed (a failure between commit and cookie-set leaves a rare,
// harmless orphan session, bounded by its own 7-day expiry).
export async function addGuestSellerItem(input: GuestSellerItemInput): Promise<AR<GuestSellerItemResult>> {
  const validationError = validateInput(input)
  if (validationError) return err(validationError)

  // Server-side catalog resolution — never trust client-supplied brand/name/year.
  const catalog = await prisma.catalogModel.findUnique({
    where: { id: input.catalogModelId },
    select: { id: true, brand: true, name: true, year: true },
  })
  if (!catalog) return err('Catalog model not found.')

  const payloadFingerprint = computePayloadFingerprint({
    catalogModelId: catalog.id,
    quantity: input.quantity,
    condition: input.condition,
    notes: input.notes,
    saleTypePreference: input.saleTypePreference,
  })

  const existingCtx = await getGuestSellerSessionContext()

  if (!existingCtx) {
    const reqHeaders = await headers()
    const rateLimitKey = rateLimitKeyFromHeaders(reqHeaders, ':guest_sell_session_create')
    if (rateLimitKey === null) {
      return err('Starting a new selling session is temporarily unavailable. Please try again later.')
    }
    const { allowed, resetMs } = checkRateLimit(rateLimitKey, GUEST_SESSION_CREATE_MAX, GUEST_SESSION_CREATE_WINDOW)
    if (!allowed) {
      const secs = Math.ceil(resetMs / 1000)
      return err(`Too many new selling sessions started. Please wait ${secs} seconds.`)
    }

    const { rawToken, tokenHash, expiresAt } = generateGuestSellerToken()

    const item = await prisma.$transaction(async (tx) => {
      const session = await tx.guestSellerSession.create({
        data: { tokenHash, expiresAt },
        select: { id: true },
      })
      return tx.guestSellerItem.create({
        data: {
          sessionId:          session.id,
          catalogModelId:     catalog.id,
          quantity:           input.quantity,
          condition:          input.condition,
          notes:              input.notes,
          saleTypePreference: input.saleTypePreference,
          clientToken:        input.clientToken,
          payloadFingerprint,
        },
        select: ITEM_SELECT,
      })
    })

    // Only after the transaction above has committed.
    await setGuestSellerCookie(rawToken)
    return ok(itemResultFromRow(item, catalog))
  }

  // Existing session — race-safe add under a session lock, mirroring
  // MobileCapture's own "queue bound enforced under session lock" pattern.
  try {
    const item = await prisma.$transaction(async (tx) => {
      // 19B Final Runtime Reconciliation §6: the earlier getGuestSellerSessionContext()
      // check above is now stale by the time this transaction actually acquires the
      // lock — re-verify expiry against the LOCKED row itself, never trust the
      // pre-transaction read. In practice the window is milliseconds, but
      // correctness must not depend on that being true.
      const locked = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>`
        SELECT id, "expiresAt" FROM "GuestSellerSession" WHERE id = ${existingCtx.id} FOR UPDATE
      `
      if (locked.length === 0 || locked[0].expiresAt.getTime() <= Date.now()) {
        throw new Error('SESSION_EXPIRED')
      }

      const itemCount = await tx.guestSellerItem.count({ where: { sessionId: existingCtx.id } })
      if (itemCount >= MAX_GUEST_ITEMS_PER_SESSION) {
        throw new Error('QUEUE_FULL')
      }

      return tx.guestSellerItem.create({
        data: {
          sessionId:          existingCtx.id,
          catalogModelId:     catalog.id,
          quantity:           input.quantity,
          condition:          input.condition,
          notes:              input.notes,
          saleTypePreference: input.saleTypePreference,
          clientToken:        input.clientToken,
          payloadFingerprint,
        },
        select: ITEM_SELECT,
      })
    })

    return ok(itemResultFromRow(item, catalog))
  } catch (e) {
    if (e instanceof Error && e.message === 'SESSION_EXPIRED') {
      // The session expired between the pre-transaction read and lock
      // acquisition (or was never valid) — do NOT revive it. The existing
      // browser cookie is simply stale; retrying this same add will find no
      // valid session and take the first-add path, minting a fresh one.
      return err('Your selling session has expired. Please try adding this item again.')
    }
    if (e instanceof Error && e.message === 'QUEUE_FULL') {
      return err(`Your selling batch is full. Maximum ${MAX_GUEST_ITEMS_PER_SESSION} items.`)
    }

    if (isPrismaP2002(e)) {
      const constraint = p2002ConstraintName(e)

      if (constraint.includes('clientToken')) {
        const existing = await prisma.guestSellerItem.findUnique({
          where: { sessionId_clientToken: { sessionId: existingCtx.id, clientToken: input.clientToken } },
          include: { catalogModel: { select: { brand: true, name: true, year: true } } },
        })
        if (!existing) return err('Item not found after conflict. Please retry.')
        if (existing.payloadFingerprint !== payloadFingerprint) {
          return err('This request was already used with different item details.')
        }
        return ok(itemResultFromRow(existing, existing.catalogModel))
      }

      if (constraint.includes('catalogModelId')) {
        // 19B: intentional conflict, never a silent quantity increment and
        // never a second row — the same product decision MobileCapture
        // already made for authenticated customers.
        const existing = await prisma.guestSellerItem.findFirst({
          where: { sessionId: existingCtx.id, catalogModelId: catalog.id },
          select: { id: true },
        })
        return err('This model is already in your selling batch. Update the quantity instead.', existing?.id)
      }
    }

    throw e
  }
}

// ── updateGuestSellerItem ─────────────────────────────────────────────────────
// catalogModelId is intentionally NOT editable here — if the customer picked
// the wrong model, remove + re-add (see product-scope note in the schema
// comment: every persisted row must already be an explicitly-confirmed model).

export type UpdateGuestSellerItemInput = Partial<Pick<GuestSellerItemInput, 'quantity' | 'condition' | 'notes' | 'saleTypePreference'>>

export async function updateGuestSellerItem(
  itemId: string,
  updates: UpdateGuestSellerItemInput,
  updatedAt: string,
): Promise<AR<GuestSellerItemResult>> {
  const ctx = await getGuestSellerSessionContext()
  if (!ctx) return err('Selling session not found or expired.')

  if (updates.quantity !== undefined && (updates.quantity < 1 || updates.quantity > 999)) {
    return err('Quantity must be 1–999.')
  }
  if (updates.condition && !(VALID_CONDITIONS as readonly string[]).includes(updates.condition)) {
    return err('Invalid condition.')
  }
  if (updates.saleTypePreference && !(VALID_SALE_TYPES as readonly string[]).includes(updates.saleTypePreference)) {
    return err('Invalid sale type.')
  }
  if (updates.notes && updates.notes.length > 500) return err('Notes must be 500 characters or fewer.')
  if (updates.notes && /[\x00-\x1F\x7F]/.test(updates.notes)) return err('Notes contain invalid characters.')

  const result = await prisma.guestSellerItem.updateMany({
    where: { id: itemId, sessionId: ctx.id, updatedAt: new Date(updatedAt) },
    data: {
      ...(updates.quantity           !== undefined ? { quantity: updates.quantity }                     : {}),
      ...(updates.condition          !== undefined ? { condition: updates.condition }                   : {}),
      ...(updates.notes              !== undefined ? { notes: updates.notes }                           : {}),
      ...(updates.saleTypePreference !== undefined ? { saleTypePreference: updates.saleTypePreference } : {}),
    },
  })

  if (result.count === 0) return err('Item was modified elsewhere. Please refresh.')

  const item = await prisma.guestSellerItem.findFirst({
    where: { id: itemId, sessionId: ctx.id },
    include: { catalogModel: { select: { brand: true, name: true, year: true } } },
  })
  if (!item) return err('Item not found.')

  return ok(itemResultFromRow(item, item.catalogModel))
}

// ── removeGuestSellerItem ─────────────────────────────────────────────────────

export async function removeGuestSellerItem(itemId: string): Promise<AR<{ removed: boolean }>> {
  const ctx = await getGuestSellerSessionContext()
  if (!ctx) return err('Selling session not found or expired.')

  const result = await prisma.guestSellerItem.deleteMany({
    where: { id: itemId, sessionId: ctx.id },
  })
  return ok({ removed: result.count > 0 })
}

// ── getGuestSellerBatch ────────────────────────────────────────────────────────
// Read-only, zero-write — safe to call on every /sell GET render.

export type GuestSellerBatch = { items: GuestSellerItemResult[] }

export async function getGuestSellerBatch(): Promise<GuestSellerBatch> {
  const ctx = await getGuestSellerSessionContext()
  if (!ctx) return { items: [] }

  const items = await prisma.guestSellerItem.findMany({
    where: { sessionId: ctx.id },
    orderBy: { createdAt: 'asc' },
    include: { catalogModel: { select: { brand: true, name: true, year: true } } },
  })

  return { items: items.map((i) => itemResultFromRow(i, i.catalogModel)) }
}
