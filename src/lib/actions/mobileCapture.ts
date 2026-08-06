'use server'

import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { getRequestId } from '@/lib/requestId'
import { normalizeError } from '@/lib/errors'
import { checkRateLimit } from '@/lib/rateLimit'

export type CaptureDestination = 'collection' | 'sell'

const VALID_DESTINATIONS  = ['collection', 'sell'] as const
const VALID_CONDITIONS    = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'] as const
const VALID_SALE_TYPES    = ['consignment', 'buyout', 'unsure'] as const

const MAX_CAPTURE_ITEMS_PER_SESSION = 100

const CAPTURE_ADD_MAX    = 60
const CAPTURE_ADD_WINDOW = 60 * 60 * 1000  // 1 hour
const CAPTURE_SUB_MAX    = 10
const CAPTURE_SUB_WINDOW = 60 * 60 * 1000  // 1 hour

// ── Types ─────────────────────────────────────────────────────────────────────

export type CaptureItemInput = {
  catalogModelId:     string
  quantity:           number
  acquisitionDate:    string | null   // ISO date string; collection only
  condition:          string | null
  notes:              string | null
  isPublic:           boolean
  saleTypePreference: string | null
  clientToken:        string
}

export type CaptureItemResult = {
  id:                 string
  catalogModelId:     string
  brand:              string
  name:               string
  year:               number | null
  quantity:           number
  acquisitionDate:    string | null
  condition:          string | null
  notes:              string | null
  isPublic:           boolean
  saleTypePreference: string | null
  clientToken:        string
  updatedAt:          string
}

export type CaptureSessionResult = {
  id:          string
  destination: CaptureDestination
  status:      string
  items:       CaptureItemResult[]
}

export type ExistingCollectionInfo = {
  id:        string
  quantity:  number
  updatedAt: string
}

export type SubmitItemResult    = { itemId: string; ok: boolean; error?: string }
export type SubmitSessionResult = { submitted: boolean; results: SubmitItemResult[] }

type Ok<T>  = { ok: true;  data: T }
type Err    = { ok: false; error: string }
type AR<T>  = Ok<T> | Err

function ok<T>(data: T): Ok<T>  { return { ok: true,  data } }
function err(msg: string): Err  { return { ok: false, error: msg } }

function isPrismaP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

function p2002ConstraintName(e: unknown): string {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return ''
  return String(e.meta?.target ?? '')
}

// Server-computed SHA-256 fingerprint of the full normalized item payload.
// Null fields are represented as empty strings; boolean as 'true'/'false'.
// Does not include clientToken, sessionId, profileId, or any image data.
function computePayloadFingerprint(params: {
  catalogModelId:     string
  quantity:           number
  acquisitionDate:    string | null
  condition:          string | null
  notes:              string | null
  isPublic:           boolean
  saleTypePreference: string | null
}): string {
  const parts = [
    params.catalogModelId,
    String(params.quantity),
    params.acquisitionDate ?? '',
    params.condition ?? '',
    params.notes ?? '',
    String(params.isPublic),
    params.saleTypePreference ?? '',
  ]
  return crypto.createHash('sha256').update(parts.join('\x00')).digest('hex')
}

function itemResultFromRow(
  row: {
    id: string; catalogModelId: string; quantity: number; acquisitionDate: Date | null;
    condition: string | null; notes: string | null; isPublic: boolean;
    saleTypePreference: string | null; clientToken: string; updatedAt: Date;
  },
  catalog: { brand: string; name: string; year: number | null },
): CaptureItemResult {
  return {
    id:                 row.id,
    catalogModelId:     row.catalogModelId,
    brand:              catalog.brand,
    name:               catalog.name,
    year:               catalog.year,
    quantity:           row.quantity,
    acquisitionDate:    row.acquisitionDate?.toISOString() ?? null,
    condition:          row.condition,
    notes:              row.notes,
    isPublic:           row.isPublic,
    saleTypePreference: row.saleTypePreference,
    clientToken:        row.clientToken,
    updatedAt:          row.updatedAt.toISOString(),
  }
}

// ── getOrCreateDraftSession ───────────────────────────────────────────────────
// Backed by a partial unique index (status = 'draft') so concurrent creates
// produce exactly one session: the losing request gets P2002 and re-fetches.

export async function getOrCreateDraftSession(
  destination: string,
): Promise<AR<{ sessionId: string; itemCount: number }>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  if (!(VALID_DESTINATIONS as readonly string[]).includes(destination)) {
    return err('Invalid destination.')
  }

  const existing = await prisma.mobileCaptureSession.findFirst({
    where:   { customerProfileId: session.profileId, destination, status: 'draft' },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, _count: { select: { items: true } } },
  })
  if (existing) return ok({ sessionId: existing.id, itemCount: existing._count.items })

  try {
    const created = await prisma.mobileCaptureSession.create({
      data:   { customerProfileId: session.profileId, destination },
      select: { id: true },
    })
    return ok({ sessionId: created.id, itemCount: 0 })
  } catch (e) {
    if (isPrismaP2002(e)) {
      const race = await prisma.mobileCaptureSession.findFirst({
        where:   { customerProfileId: session.profileId, destination, status: 'draft' },
        orderBy: { createdAt: 'desc' },
        select:  { id: true, _count: { select: { items: true } } },
      })
      if (race) return ok({ sessionId: race.id, itemCount: race._count.items })
    }
    throw e
  }
}

// ── addCaptureItem ────────────────────────────────────────────────────────────
// Idempotency via clientToken + full-payload fingerprint:
//   - exact retry (same token + same payload)  → return existing item unchanged
//   - same token, changed payload              → idempotency conflict error
//   - different token, same catalogModelId     → "already in batch" error
//   - concurrent same-token creates            → one row via P2002 recovery
// Queue bound enforced under session lock: MAX_CAPTURE_ITEMS_PER_SESSION.

export async function addCaptureItem(
  sessionId: string,
  input: CaptureItemInput,
): Promise<AR<CaptureItemResult>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  const requestId = await getRequestId()

  const { allowed, resetMs } = checkRateLimit(
    `capture_add:${session.profileId}`,
    CAPTURE_ADD_MAX,
    CAPTURE_ADD_WINDOW,
  )
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return err(`Too many items added. Please wait ${secs} seconds.`)
  }

  // Ownership + status check (fast path before acquiring lock)
  const captureSession = await prisma.mobileCaptureSession.findFirst({
    where:  { id: sessionId, customerProfileId: session.profileId },
    select: { id: true, status: true, destination: true },
  })
  if (!captureSession)                   return err('Session not found.')
  if (captureSession.status !== 'draft') return err('Session is no longer editable.')

  // Input validation
  if (!input.clientToken)                         return err('Client token is required.')
  if (input.quantity < 1 || input.quantity > 999) return err('Quantity must be 1–999.')
  if (input.condition && !(VALID_CONDITIONS as readonly string[]).includes(input.condition)) {
    return err('Invalid condition.')
  }
  if (captureSession.destination === 'collection') {
    if (input.acquisitionDate) {
      const d = new Date(input.acquisitionDate)
      if (isNaN(d.getTime())) return err('Invalid acquisition date.')
      if (d > new Date())       return err('Acquisition date cannot be in the future.')
    }
  } else {
    // sell: ignore acquisitionDate silently (field is collection-only)
    input = { ...input, acquisitionDate: null, isPublic: false }
    if (!input.saleTypePreference || !(VALID_SALE_TYPES as readonly string[]).includes(input.saleTypePreference)) {
      return err('Please select how you would like to sell.')
    }
  }
  if (input.notes && input.notes.length > 500)             return err('Notes must be 500 characters or fewer.')
  if (input.notes && /[\x00-\x1F\x7F]/.test(input.notes)) return err('Notes contain invalid characters.')

  // Server-side catalog resolution — never trust client-supplied brand/name/year
  const catalog = await prisma.catalogModel.findUnique({
    where:  { id: input.catalogModelId },
    select: { id: true, brand: true, name: true, year: true },
  })
  if (!catalog) return err('Catalog model not found.')

  // Compute fingerprint before acquiring lock
  const acquisitionDateNorm = input.acquisitionDate
    ? new Date(input.acquisitionDate).toISOString()
    : null
  const payloadFingerprint = computePayloadFingerprint({
    catalogModelId:     catalog.id,
    quantity:           input.quantity,
    acquisitionDate:    acquisitionDateNorm,
    condition:          input.condition,
    notes:              input.notes,
    isPublic:           input.isPublic,
    saleTypePreference: input.saleTypePreference,
  })

  // Race-safe create inside a transaction with session lock.
  // Lock serializes concurrent additions so queue bound is accurate.
  try {
    const item = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "MobileCaptureSession" WHERE id = ${sessionId} FOR UPDATE`

      // Re-check status after lock (submission may have begun concurrently)
      const lockedSession = await tx.mobileCaptureSession.findFirst({
        where:  { id: sessionId, customerProfileId: session.profileId },
        select: { status: true },
      })
      if (!lockedSession || lockedSession.status !== 'draft') {
        throw new Error('SESSION_NOT_EDITABLE')
      }

      // Enforce queue bound under lock
      const itemCount = await tx.mobileCaptureItem.count({ where: { sessionId } })
      if (itemCount >= MAX_CAPTURE_ITEMS_PER_SESSION) {
        throw new Error('QUEUE_FULL')
      }

      return tx.mobileCaptureItem.create({
        data: {
          sessionId,
          catalogModelId:     catalog.id,
          quantity:           input.quantity,
          acquisitionDate:    acquisitionDateNorm ? new Date(acquisitionDateNorm) : null,
          condition:          input.condition,
          notes:              input.notes,
          isPublic:           input.isPublic,
          saleTypePreference: input.saleTypePreference,
          clientToken:        input.clientToken,
          payloadFingerprint,
        },
        select: {
          id: true, catalogModelId: true, quantity: true, acquisitionDate: true,
          condition: true, notes: true, isPublic: true, saleTypePreference: true,
          clientToken: true, updatedAt: true,
        },
      })
    }, { timeout: 10_000 })

    return ok(itemResultFromRow(item, catalog))

  } catch (e) {
    if (e instanceof Error && e.message === 'SESSION_NOT_EDITABLE') {
      return err('Session is no longer editable.')
    }
    if (e instanceof Error && e.message === 'QUEUE_FULL') {
      return err(`Queue is full. Maximum ${MAX_CAPTURE_ITEMS_PER_SESSION} items per batch.`)
    }

    if (isPrismaP2002(e)) {
      const constraint = p2002ConstraintName(e)

      if (constraint.includes('clientToken')) {
        // Same clientToken: re-fetch authoritative row, compare full fingerprint
        const existing = await prisma.mobileCaptureItem.findUnique({
          where:   { sessionId_clientToken: { sessionId, clientToken: input.clientToken } },
          include: { catalog: { select: { brand: true, name: true, year: true } } },
        })
        if (!existing) return err('Item not found after conflict. Please retry.')

        if (existing.payloadFingerprint !== payloadFingerprint) {
          return err('Client token conflict: this token was already used with different item details.')
        }

        return ok(itemResultFromRow(existing, existing.catalog))
      }

      if (constraint.includes('catalogModelId')) {
        // Different clientToken, same catalogModelId → already in batch
        return err('This model is already in your capture batch.')
      }
    }

    const norm = normalizeError(e, { event: 'capture.add_item_failed', requestId })
    return err(norm.userMessage)
  }
}

// ── updateCaptureItem ─────────────────────────────────────────────────────────

export async function updateCaptureItem(
  itemId: string,
  sessionId: string,
  updates: Partial<Pick<CaptureItemInput, 'quantity' | 'acquisitionDate' | 'condition' | 'notes' | 'isPublic' | 'saleTypePreference'>>,
  updatedAt: string,
): Promise<AR<CaptureItemResult>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  const requestId = await getRequestId()

  const captureSession = await prisma.mobileCaptureSession.findFirst({
    where:  { id: sessionId, customerProfileId: session.profileId },
    select: { id: true, status: true, destination: true },
  })
  if (!captureSession)                   return err('Session not found.')
  if (captureSession.status !== 'draft') return err('Session is no longer editable.')

  if (updates.quantity !== undefined && (updates.quantity < 1 || updates.quantity > 999)) {
    return err('Quantity must be 1–999.')
  }
  if (updates.condition && !(VALID_CONDITIONS as readonly string[]).includes(updates.condition)) {
    return err('Invalid condition.')
  }
  if (updates.notes && updates.notes.length > 500)             return err('Notes must be 500 characters or fewer.')
  if (updates.notes && /[\x00-\x1F\x7F]/.test(updates.notes)) return err('Notes contain invalid characters.')
  if (captureSession.destination === 'collection') {
    if (updates.acquisitionDate) {
      const d = new Date(updates.acquisitionDate)
      if (isNaN(d.getTime())) return err('Invalid acquisition date.')
      if (d > new Date())       return err('Acquisition date cannot be in the future.')
    }
  } else {
    updates = { ...updates, acquisitionDate: undefined, isPublic: undefined }
    if (updates.saleTypePreference !== undefined && (
      !updates.saleTypePreference || !(VALID_SALE_TYPES as readonly string[]).includes(updates.saleTypePreference)
    )) {
      return err('Invalid sale type.')
    }
  }

  try {
    const acquisitionDateUpdate = updates.acquisitionDate !== undefined
      ? { acquisitionDate: updates.acquisitionDate ? new Date(updates.acquisitionDate) : null }
      : {}

    const result = await prisma.mobileCaptureItem.updateMany({
      where: { id: itemId, sessionId, updatedAt: new Date(updatedAt) },
      data:  {
        ...(updates.quantity           !== undefined ? { quantity:           updates.quantity }           : {}),
        ...acquisitionDateUpdate,
        ...(updates.condition          !== undefined ? { condition:          updates.condition }          : {}),
        ...(updates.notes              !== undefined ? { notes:              updates.notes }              : {}),
        ...(updates.isPublic           !== undefined ? { isPublic:           updates.isPublic }           : {}),
        ...(updates.saleTypePreference !== undefined ? { saleTypePreference: updates.saleTypePreference } : {}),
      },
    })

    if (result.count === 0) return err('Item was modified elsewhere. Please refresh.')

    const item = await prisma.mobileCaptureItem.findFirst({
      where:   { id: itemId, sessionId },
      include: { catalog: { select: { brand: true, name: true, year: true } } },
    })
    if (!item) return err('Item not found.')

    return ok(itemResultFromRow(item, item.catalog))
  } catch (e) {
    const norm = normalizeError(e, { event: 'capture.update_item_failed', requestId })
    return err(norm.userMessage)
  }
}

// ── removeCaptureItem ─────────────────────────────────────────────────────────

export async function removeCaptureItem(
  itemId: string,
  sessionId: string,
): Promise<AR<{ removed: boolean }>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  const captureSession = await prisma.mobileCaptureSession.findFirst({
    where:  { id: sessionId, customerProfileId: session.profileId },
    select: { id: true, status: true },
  })
  if (!captureSession)                   return err('Session not found.')
  if (captureSession.status !== 'draft') return err('Session is no longer editable.')

  const result = await prisma.mobileCaptureItem.deleteMany({
    where: { id: itemId, sessionId },
  })
  return ok({ removed: result.count > 0 })
}

// ── getCaptureSession ─────────────────────────────────────────────────────────

export async function getCaptureSession(
  sessionId: string,
): Promise<AR<CaptureSessionResult>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  const captureSession = await prisma.mobileCaptureSession.findFirst({
    where:  { id: sessionId, customerProfileId: session.profileId },
    select: {
      id: true, destination: true, status: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select:  {
          id: true, catalogModelId: true, quantity: true, acquisitionDate: true,
          condition: true, notes: true, isPublic: true, saleTypePreference: true,
          clientToken: true, updatedAt: true,
          catalog: { select: { brand: true, name: true, year: true } },
        },
      },
    },
  })

  if (!captureSession) return err('Session not found.')

  return ok({
    id:          captureSession.id,
    destination: captureSession.destination as CaptureDestination,
    status:      captureSession.status,
    items:       captureSession.items.map(item => itemResultFromRow(item, item.catalog)),
  })
}

// ── cancelCaptureSession ──────────────────────────────────────────────────────
// Only draft sessions may be cancelled. Cancelled sessions are immutable and
// do not count against the partial unique draft index (allowing a new draft for
// the same destination). No destination records exist to roll back.

export async function cancelCaptureSession(
  sessionId: string,
): Promise<AR<{ cancelled: true }>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "MobileCaptureSession"
        WHERE id = ${sessionId} AND "customerProfileId" = ${session.profileId}
        FOR UPDATE
      `

      const captureSession = await tx.mobileCaptureSession.findFirst({
        where:  { id: sessionId, customerProfileId: session.profileId },
        select: { id: true, status: true },
      })

      if (!captureSession)                   throw new Error('SESSION_NOT_FOUND')
      if (captureSession.status !== 'draft') throw new Error('SESSION_NOT_DRAFT')

      await tx.mobileCaptureSession.update({
        where: { id: sessionId },
        data:  { status: 'cancelled' },
      })
    })

    return ok({ cancelled: true })

  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'SESSION_NOT_FOUND') return err('Session not found.')
      if (e.message === 'SESSION_NOT_DRAFT')  return err('Only draft sessions can be cancelled.')
    }
    throw e
  }
}

// ── submitCaptureSession ──────────────────────────────────────────────────────
// Single transaction with FOR UPDATE. Pre-validates all items before converting
// any. Any failure rolls back all conversions.
// Lock order: MobileCaptureSession (single row).

export async function submitCaptureSession(
  sessionId: string,
): Promise<AR<SubmitSessionResult>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  const requestId = await getRequestId()

  const { allowed, resetMs } = checkRateLimit(
    `capture_submit:${session.profileId}`,
    CAPTURE_SUB_MAX,
    CAPTURE_SUB_WINDOW,
  )
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return err(`Too many submissions. Please wait ${secs} seconds.`)
  }

  const results: SubmitItemResult[] = []

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "MobileCaptureSession"
        WHERE id = ${sessionId} AND "customerProfileId" = ${session.profileId}
        FOR UPDATE
      `

      const captureSession = await tx.mobileCaptureSession.findFirst({
        where:  { id: sessionId, customerProfileId: session.profileId },
        select: {
          id: true, destination: true, status: true,
          items: {
            orderBy: { createdAt: 'asc' },
            select:  {
              id: true, catalogModelId: true, quantity: true, acquisitionDate: true,
              condition: true, notes: true, isPublic: true, saleTypePreference: true,
              catalog: { select: { brand: true, name: true, year: true } },
            },
          },
        },
      })

      if (!captureSession)                   throw new Error('SESSION_NOT_FOUND')
      if (captureSession.status !== 'draft') throw new Error('SESSION_NOT_DRAFT')
      if (captureSession.items.length === 0) throw new Error('NO_ITEMS')

      // Pre-validation: check all items before converting any
      const seenModels = new Set<string>()
      for (const item of captureSession.items) {
        // Catch duplicate model IDs in queue (race condition defence)
        if (seenModels.has(item.catalogModelId)) {
          throw Object.assign(new Error('DUPLICATE_MODEL_IN_QUEUE'), {
            brand: item.catalog.brand, name: item.catalog.name,
          })
        }
        seenModels.add(item.catalogModelId)

        // Per-destination validation
        if (captureSession.destination === 'collection') {
          if (item.quantity < 1 || item.quantity > 999) throw new Error('INVALID_QUANTITY')
          if (item.saleTypePreference)                   throw new Error('SELLER_FIELD_IN_COLLECTION')
          if (item.acquisitionDate && isNaN(item.acquisitionDate.getTime())) {
            throw new Error('INVALID_DATE')
          }
        } else {
          // sell: acquisitionDate and isPublic must not be set
          if (item.acquisitionDate) throw new Error('COLLECTION_FIELD_IN_SELLER')
          if (!item.saleTypePreference) throw new Error('MISSING_SALE_TYPE')
          if (!(VALID_SALE_TYPES as readonly string[]).includes(item.saleTypePreference)) {
            throw new Error('INVALID_SALE_TYPE')
          }
        }
      }

      // Conversion: all items, all under the same transaction
      for (const item of captureSession.items) {
        if (captureSession.destination === 'collection') {
          const dupe = await tx.collectionItem.findFirst({
            where:  { profileId: session.profileId, catalogId: item.catalogModelId },
            select: { id: true },
          })
          if (dupe) {
            throw Object.assign(new Error('COLLECTION_DUPLICATE'), {
              brand: item.catalog.brand, name: item.catalog.name,
            })
          }

          await tx.collectionItem.create({
            data: {
              profileId:       session.profileId,
              catalogId:       item.catalogModelId,
              brand:           item.catalog.brand,
              name:            item.catalog.name,
              year:            item.catalog.year,
              quantity:        item.quantity,
              condition:       item.condition,
              notes:           item.notes,
              isPublic:        item.isPublic,
              purchaseDate:    item.acquisitionDate ?? undefined,
            },
          })
        } else {
          // Only permitted records: SellerSubmission with status='submitted'.
          // No ItemInstance, Listing, Order, agreement, shipment, payout, or pricing.
          await tx.sellerSubmission.create({
            data: {
              profileId:          session.profileId,
              catalogId:          item.catalogModelId,
              brand:              item.catalog.brand,
              name:               item.catalog.name,
              year:               item.catalog.year,
              quantity:           item.quantity,
              condition:          item.condition,
              userNotes:          item.notes,
              saleTypePreference: item.saleTypePreference,
              status:             'submitted',
            },
          })
        }

        results.push({ itemId: item.id, ok: true })
      }

      await tx.mobileCaptureSession.update({
        where: { id: sessionId },
        data:  { status: 'submitted' },
      })
    }, { timeout: 30_000 })

    return ok({ submitted: true, results })

  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'SESSION_NOT_FOUND') return err('Session not found.')
      if (e.message === 'SESSION_NOT_DRAFT')  return err('Session already submitted.')
      if (e.message === 'NO_ITEMS')           return err('No items to submit.')
      if (e.message === 'INVALID_QUANTITY')   return err('One or more items has an invalid quantity.')
      if (e.message === 'INVALID_DATE')       return err('One or more items has an invalid acquisition date.')
      if (e.message === 'SELLER_FIELD_IN_COLLECTION') return err('Invalid item data for collection.')
      if (e.message === 'COLLECTION_FIELD_IN_SELLER') return err('Invalid item data for seller.')
      if (e.message === 'MISSING_SALE_TYPE' || e.message === 'INVALID_SALE_TYPE') {
        return err('One or more items is missing a valid sale preference.')
      }
      if (e.message === 'DUPLICATE_MODEL_IN_QUEUE') {
        const ex = e as Error & { brand?: string; name?: string }
        return err(`Duplicate model in queue: ${ex.brand ?? ''} ${ex.name ?? ''}. Remove the duplicate and try again.`)
      }
      if (e.message === 'COLLECTION_DUPLICATE') {
        const ex = e as Error & { brand?: string; name?: string }
        return err(`Already in collection: ${ex.brand ?? ''} ${ex.name ?? ''}. Remove the duplicate item and try again.`)
      }
    }
    const norm = normalizeError(e, { event: 'capture.submit_session_failed', requestId })
    return err(norm.userMessage)
  }
}

// ── checkCollectionDuplicate ──────────────────────────────────────────────────

export async function checkCollectionDuplicate(
  catalogModelId: string,
): Promise<AR<{ isDuplicate: false } | { isDuplicate: true; existing: ExistingCollectionInfo }>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  const existing = await prisma.collectionItem.findFirst({
    where:  { profileId: session.profileId, catalogId: catalogModelId },
    select: { id: true, quantity: true, updatedAt: true },
  })

  if (!existing) return ok({ isDuplicate: false })
  return ok({
    isDuplicate: true,
    existing: { id: existing.id, quantity: existing.quantity, updatedAt: existing.updatedAt.toISOString() },
  })
}

// ── updateExistingCollectionQuantity ──────────────────────────────────────────
// Sets target quantity (absolute, not delta). Retry-safe: SET qty = N is idempotent.
// Stale-safe: updateMany on (id, profileId, updatedAt) — count=0 → stale error.
// Preserves all other fields on the existing CollectionItem.

export async function updateExistingCollectionQuantity(
  existingItemId: string,
  targetQty: number,
  expectedUpdatedAt: string,
): Promise<AR<{ newQuantity: number }>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to use Quick Capture.')

  if (!Number.isInteger(targetQty) || targetQty < 1 || targetQty > 999) {
    return err('Quantity must be 1–999.')
  }

  const result = await prisma.collectionItem.updateMany({
    where: { id: existingItemId, profileId: session.profileId, updatedAt: new Date(expectedUpdatedAt) },
    data:  { quantity: targetQty },
  })

  if (result.count === 0) {
    return err('Collection item was modified elsewhere. Please refresh.')
  }

  return ok({ newQuantity: targetQty })
}
