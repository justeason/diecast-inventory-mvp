'use server'

import crypto from 'crypto'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { getOrCreateDraftSession } from '@/lib/actions/mobileCapture'
import { getGuestSellerSessionContext, GUEST_SELLER_COOKIE_NAME } from '@/lib/guestSellerSession'
import { computeMobileCaptureFingerprint } from '@/lib/captureFingerprint'

// Mirrors mobileCapture.ts's MAX_CAPTURE_ITEMS_PER_SESSION — duplicated per the
// same 'use server' export-constraint convention already used by guestSeller.ts
// (a plain const can't be re-exported from a 'use server' file).
const MAX_CAPTURE_ITEMS_PER_SESSION = 100

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string; conflicts?: ClaimConflict[] }
type AR<T> = Ok<T> | Err

function ok<T>(data: T): Ok<T> { return { ok: true, data } }
function err(msg: string, conflicts?: ClaimConflict[]): Err { return { ok: false, error: msg, conflicts } }

export type ClaimConflict = {
  guestItemId:        string
  catalogModelId:     string
  brand:              string
  name:               string
  year:               number | null
  guest:  { quantity: number; condition: string | null; notes: string | null; saleTypePreference: string | null }
  target: { quantity: number; condition: string | null; notes: string | null; saleTypePreference: string | null }
}

export type ClaimResult = { claimedCount: number; mergedCount: number }

class ClaimAbort extends Error {
  constructor(public code: string, public conflicts?: ClaimConflict[]) {
    super(code)
  }
}

// ── claimGuestSellerBatch ──────────────────────────────────────────────────────
// Authorization requires BOTH a valid CustomerSession (buyer_session) and a
// valid GuestSellerSession (guest_sell_session) — neither profileId nor guest
// session id is ever trusted from request input. No mutation can occur from a
// GET; this is the one explicit action the claim page's button invokes.
//
// Lock order (deadlock-free against every existing add/update/remove/merge
// path — see catalog.ts's own merge-vs-capture reasoning for why CatalogModel
// and *Session locks must never oppose each other):
//   1. GuestSellerSession            (FOR UPDATE)
//   2. target MobileCaptureSession   (FOR UPDATE, resolved via getOrCreateDraftSession
//                                      BEFORE this transaction — see below)
//   3. referenced CatalogModel rows  (sorted by id)
//   4. GuestSellerItem rows          (sorted by id)
//   5. overlapping target MobileCaptureItem rows (sorted by id)
//
// getOrCreateDraftSession('sell') is called BEFORE opening this transaction —
// its own P2002-catch-and-refetch recovery is not designed to continue inside an
// already-running transaction after a uniqueness violation. If the claim
// transaction subsequently aborts (expiry/conflict/cap), the target draft
// session may be left empty. That is an accepted bounded residual: no guest data
// is lost, no SellerSubmission is created, and an empty authenticated sell draft
// is an ordinary, already-supported product state.
export async function claimGuestSellerBatch(): Promise<AR<ClaimResult>> {
  const session = await getBuyerSession()
  if (!session) return err('Sign in to continue.')

  const guestCtx = await getGuestSellerSessionContext()
  if (!guestCtx) return err('Your saved selling batch has expired or was already added.')

  const draft = await getOrCreateDraftSession('sell')
  if (!draft.ok) return draft
  const targetSessionId = draft.data.sessionId

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Lock GuestSellerSession, re-check expiry under lock.
      await tx.$queryRaw`SELECT id FROM "GuestSellerSession" WHERE id = ${guestCtx.id} FOR UPDATE`
      const lockedGuestSession = await tx.guestSellerSession.findFirst({
        where:  { id: guestCtx.id },
        select: { expiresAt: true },
      })
      if (!lockedGuestSession || lockedGuestSession.expiresAt.getTime() <= Date.now()) {
        throw new ClaimAbort('GUEST_EXPIRED')
      }

      // 2. Lock target MobileCaptureSession, revalidate ownership/destination/status.
      await tx.$queryRaw`SELECT id FROM "MobileCaptureSession" WHERE id = ${targetSessionId} FOR UPDATE`
      const lockedTarget = await tx.mobileCaptureSession.findFirst({
        where:  { id: targetSessionId, customerProfileId: session.profileId, destination: 'sell', status: 'draft' },
        select: { id: true },
      })
      if (!lockedTarget) throw new ClaimAbort('TARGET_INVALID')

      // Discovery read (unlocked, per §14) — used only to know which
      // CatalogModel/GuestSellerItem ids to lock next. New adds are already
      // blocked by the GuestSellerSession lock above; a concurrent update/remove
      // on one of these rows is closed by the explicit per-id lock below, whose
      // subsequent authoritative re-read reflects whatever committed in between.
      const discoveredGuestItems = await tx.guestSellerItem.findMany({
        where:   { sessionId: guestCtx.id },
        select:  { id: true, catalogModelId: true },
        orderBy: { id: 'asc' },
      })
      if (discoveredGuestItems.length === 0) throw new ClaimAbort('EMPTY_GUEST_BATCH')

      // 3. Lock referenced CatalogModel rows, sorted by id — same per-id-loop
      // convention as catalog.ts's own merge lock (never a single IN(...) lock).
      const catalogModelIds = [...new Set(discoveredGuestItems.map((i) => i.catalogModelId))].sort()
      for (const id of catalogModelIds) {
        await tx.$queryRaw`SELECT id FROM "CatalogModel" WHERE id = ${id} FOR UPDATE`
      }

      // 4. Lock GuestSellerItem rows by id, sorted, then re-read authoritatively.
      const guestItemIds = discoveredGuestItems.map((i) => i.id).sort()
      for (const id of guestItemIds) {
        await tx.$queryRaw`SELECT id FROM "GuestSellerItem" WHERE id = ${id} FOR UPDATE`
      }
      const guestItems = await tx.guestSellerItem.findMany({
        where:   { id: { in: guestItemIds } },
        orderBy: { id: 'asc' },
      })
      if (guestItems.length === 0) throw new ClaimAbort('EMPTY_GUEST_BATCH')

      // 5. Lock overlapping target MobileCaptureItem rows by id, sorted, then
      // re-read authoritatively.
      const authoritativeModelIds = [...new Set(guestItems.map((i) => i.catalogModelId))]
      const discoveredTargetOverlap = await tx.mobileCaptureItem.findMany({
        where:   { sessionId: targetSessionId, catalogModelId: { in: authoritativeModelIds } },
        select:  { id: true },
        orderBy: { id: 'asc' },
      })
      const targetOverlapIds = discoveredTargetOverlap.map((i) => i.id).sort()
      for (const id of targetOverlapIds) {
        await tx.$queryRaw`SELECT id FROM "MobileCaptureItem" WHERE id = ${id} FOR UPDATE`
      }
      const targetOverlapItems = await tx.mobileCaptureItem.findMany({
        where:   { id: { in: targetOverlapIds } },
        orderBy: { id: 'asc' },
      })
      const targetByModel = new Map(targetOverlapItems.map((t) => [t.catalogModelId, t]))

      const catalogRows = await tx.catalogModel.findMany({
        where:  { id: { in: catalogModelIds } },
        select: { id: true, brand: true, name: true, year: true },
      })
      const catalogByModel = new Map(catalogRows.map((c) => [c.id, c]))

      // 6. Classify: exact-metadata-compatible overlap merges quantity only;
      // any mismatch (or a combined quantity >999) blocks the ENTIRE claim —
      // no guest row is silently skipped, no partial transfer.
      const conflicts: ClaimConflict[] = []
      const compatibleMerges: Array<{ targetId: string; newQuantity: number }> = []
      const newInserts: typeof guestItems = []

      for (const g of guestItems) {
        const t = targetByModel.get(g.catalogModelId)
        if (!t) { newInserts.push(g); continue }

        const compatible =
          t.condition === g.condition &&
          t.notes === g.notes &&
          t.saleTypePreference === g.saleTypePreference
        const combinedQuantity = t.quantity + g.quantity

        if (compatible && combinedQuantity <= 999) {
          compatibleMerges.push({ targetId: t.id, newQuantity: combinedQuantity })
        } else {
          const catalog = catalogByModel.get(g.catalogModelId)
          conflicts.push({
            guestItemId:    g.id,
            catalogModelId: g.catalogModelId,
            brand:          catalog?.brand ?? '',
            name:           catalog?.name ?? '',
            year:           catalog?.year ?? null,
            guest:  { quantity: g.quantity, condition: g.condition, notes: g.notes, saleTypePreference: g.saleTypePreference },
            target: { quantity: t.quantity, condition: t.condition, notes: t.notes, saleTypePreference: t.saleTypePreference },
          })
        }
      }

      if (conflicts.length > 0) throw new ClaimAbort('CONFLICT', conflicts)

      // 7. Cap check — combined final row count, authoritative, under lock.
      const existingTargetCount = await tx.mobileCaptureItem.count({ where: { sessionId: targetSessionId } })
      const finalCount = existingTargetCount + newInserts.length
      if (finalCount > MAX_CAPTURE_ITEMS_PER_SESSION) throw new ClaimAbort('CAP_EXCEEDED')

      // 8A. Apply compatible-overlap merges — quantity only. Target id,
      // clientToken, payloadFingerprint, createdAt are all preserved untouched;
      // the fingerprint belongs to the original client add-idempotency event,
      // not current mutable row state (matches updateCaptureItem's own
      // semantics, which never recomputes it on a plain quantity edit either).
      for (const m of compatibleMerges) {
        await tx.mobileCaptureItem.update({
          where: { id: m.targetId },
          data:  { quantity: m.newQuantity },
        })
      }

      // 8B. Insert non-overlap guest items as new MobileCaptureItem rows.
      // clientToken is freshly minted (guest tokens are not portable — they only
      // ever served the guest session's own idempotency namespace).
      // payloadFingerprint is recomputed via the shared MobileCapture-shaped
      // function, never copied from the guest row (the two fingerprints hash a
      // different field set). acquisitionDate/isPublic are forced null/false,
      // matching every other sell-destination MobileCaptureItem. createdAt is
      // claim-time (ordinary DB default), never the original guest row's.
      for (const g of newInserts) {
        const clientToken = crypto.randomBytes(16).toString('hex')
        const payloadFingerprint = computeMobileCaptureFingerprint({
          catalogModelId:     g.catalogModelId,
          quantity:           g.quantity,
          acquisitionDate:    null,
          condition:          g.condition,
          notes:              g.notes,
          isPublic:           false,
          saleTypePreference: g.saleTypePreference,
        })
        await tx.mobileCaptureItem.create({
          data: {
            sessionId:          targetSessionId,
            catalogModelId:     g.catalogModelId,
            quantity:           g.quantity,
            acquisitionDate:    null,
            condition:          g.condition,
            notes:              g.notes,
            isPublic:           false,
            saleTypePreference: g.saleTypePreference,
            clientToken,
            payloadFingerprint,
          },
        })
      }

      // 8C. Consume the guest session — hard delete, no status field, no
      // claimedAt, no audit model. The transaction itself is the exactly-once
      // boundary: cascade-deletes every GuestSellerItem atomically with the
      // inserts/updates above.
      const deleted = await tx.guestSellerSession.deleteMany({ where: { id: guestCtx.id } })
      if (deleted.count !== 1) throw new ClaimAbort('GUEST_DELETE_MISMATCH')

      return { claimedCount: newInserts.length, mergedCount: compatibleMerges.length }
    }, { timeout: 15_000 })

    // Cookie cleared only AFTER the transaction has actually committed, and
    // only from this Server Action — never from a Server Component render path.
    const cookieStore = await cookies()
    cookieStore.set(GUEST_SELLER_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    })

    return ok(result)
  } catch (e) {
    if (e instanceof ClaimAbort) {
      if (e.code === 'GUEST_EXPIRED')  return err('Your saved selling batch has expired.')
      if (e.code === 'EMPTY_GUEST_BATCH') return err('No saved selling items were found.')
      if (e.code === 'TARGET_INVALID') return err('Please try again.')
      if (e.code === 'CAP_EXCEEDED') {
        return err(`Your combined selling batch would exceed ${MAX_CAPTURE_ITEMS_PER_SESSION} items. Remove some items and try again.`)
      }
      if (e.code === 'CONFLICT') {
        return err('This model is already in your selling batch with different details.', e.conflicts)
      }
      if (e.code === 'GUEST_DELETE_MISMATCH') return err('Please try again.')
    }
    throw e
  }
}
