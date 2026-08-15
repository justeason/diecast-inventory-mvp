'use server'

// 15D: Bulk Intake Workbench mutations. 15D-review section 1: this file owns NO
// conversion logic of its own — every ItemInstance creation goes through the single
// authoritative `convertIntakeDraft` primitive (src/lib/intakeConversion.ts), shared
// verbatim with the manual admin intake flow (actions/intake.ts convertDraft). This
// file only classifies each confirm as normal-vs-exception, creates the IntakeDraft
// row, and — for the normal path — hands that draft to the shared converter.

import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { resolveConversionEligibility } from '@/lib/sellerAgreementInventory'
import { convertIntakeDraft } from '@/lib/intakeConversion'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import {
  MAX_WORKBENCH_BATCH_QUANTITY,
  WORKBENCH_LEASE_TTL_MS,
  DEFAULT_HIGH_VALUE_THRESHOLD_CENTS,
  wouldExceedReceived,
  deriveIntakeRiskFlags,
  computeObservedPhysical,
  computeReconciliationVariance,
} from '@/lib/intakeWorkbench'
import { openIntakeExceptionWhere } from '@/lib/intakeExceptions'

type TxClient = Prisma.TransactionClient

// ── Shared lease guard (15D-review section 2/5) — the ACTUAL write guard against two
// admins independently confirming or reconciling the same shipment, used by both
// confirmWorkbenchItem and reconcileWorkbenchShipment inside their own transactions.
// A session with no lease row, or an EXPIRED one, is claimable by any token (first
// writer wins via the caller's own shipment row lock); an ACTIVE lease held by a
// different token is rejected outright. Explicit takeover (claimWorkbenchLease with
// takeover=true) updates the row directly, so the stale former holder's next call here
// lands on the new claimToken and is rejected. ─────────────────────────────────────
type LeaseGuardResult = { ok: true } | { ok: false; error: string }

async function assertLeaseOwnership(tx: TxClient, shipmentId: string, claimToken: string): Promise<LeaseGuardResult> {
  const now = new Date()
  const existingLease = await tx.intakeWorkbenchSession.findUnique({ where: { sellerInboundShipmentId: shipmentId } })
  if (existingLease && existingLease.claimToken !== claimToken && existingLease.expiresAt.getTime() > now.getTime()) {
    return { ok: false, error: 'Another session is actively processing this shipment. Wait for the lease to expire or take over from the shipment page.' }
  }
  await tx.intakeWorkbenchSession.upsert({
    where: { sellerInboundShipmentId: shipmentId },
    create: { sellerInboundShipmentId: shipmentId, claimToken, claimedAt: now, expiresAt: new Date(now.getTime() + WORKBENCH_LEASE_TTL_MS) },
    update: {
      claimToken,
      claimedAt: existingLease?.claimToken === claimToken ? existingLease.claimedAt : now,
      expiresAt: new Date(now.getTime() + WORKBENCH_LEASE_TTL_MS),
      renewedAt: now,
    },
  })
  return { ok: true }
}

// ─── Lease (section 21) ─────────────────────────────────────────────────────────────
// Informational claim/renew/release, used for the page-load "active elsewhere" banner
// and the explicit takeover button. The ACTUAL write guard against two simultaneous
// confirmers lives inside confirmWorkbenchItem's transaction (see below) — this alone
// is never sufficient on its own (a best-effort call outside the conversion tx cannot
// stop a second admin's confirm from racing in between).

export type WorkbenchLeaseState = { held: boolean; heldByMe: boolean; expiresAt: string | null }

export async function claimWorkbenchLease(
  shipmentId: string,
  claimToken: string,
  takeover = false,
): Promise<WorkbenchLeaseState> {
  if (!(await isAdminAuthenticated())) return { held: false, heldByMe: false, expiresAt: null }
  if (!shipmentId || !claimToken) return { held: false, heldByMe: false, expiresAt: null }

  const now = new Date()
  const existing = await prisma.intakeWorkbenchSession.findUnique({ where: { sellerInboundShipmentId: shipmentId } })
  if (existing && existing.claimToken !== claimToken && existing.expiresAt.getTime() > now.getTime() && !takeover) {
    return { held: true, heldByMe: false, expiresAt: existing.expiresAt.toISOString() }
  }

  const expiresAt = new Date(now.getTime() + WORKBENCH_LEASE_TTL_MS)
  const session = await prisma.intakeWorkbenchSession.upsert({
    where: { sellerInboundShipmentId: shipmentId },
    create: { sellerInboundShipmentId: shipmentId, claimToken, claimedAt: now, expiresAt },
    update: { claimToken, claimedAt: now, expiresAt, renewedAt: null },
  })
  return { held: true, heldByMe: true, expiresAt: session.expiresAt.toISOString() }
}

export async function renewWorkbenchLease(shipmentId: string, claimToken: string): Promise<WorkbenchLeaseState> {
  if (!(await isAdminAuthenticated())) return { held: false, heldByMe: false, expiresAt: null }
  const now = new Date()
  const expiresAt = new Date(now.getTime() + WORKBENCH_LEASE_TTL_MS)
  const result = await prisma.intakeWorkbenchSession.updateMany({
    where: { sellerInboundShipmentId: shipmentId, claimToken },
    data: { expiresAt, renewedAt: now },
  })
  if (result.count === 0) {
    const existing = await prisma.intakeWorkbenchSession.findUnique({ where: { sellerInboundShipmentId: shipmentId } })
    const stillActive = !!existing && existing.expiresAt.getTime() > now.getTime()
    return { held: stillActive, heldByMe: false, expiresAt: stillActive ? existing!.expiresAt.toISOString() : null }
  }
  return { held: true, heldByMe: true, expiresAt: expiresAt.toISOString() }
}

export async function releaseWorkbenchLease(shipmentId: string, claimToken: string): Promise<void> {
  if (!(await isAdminAuthenticated())) return
  await prisma.intakeWorkbenchSession.deleteMany({ where: { sellerInboundShipmentId: shipmentId, claimToken } })
}

// ─── Pricing advisory (14C reuse, section 18/19) ───────────────────────────────────

export type WorkbenchPricingAdvisory = {
  estimatedValueCents: number | null
  lowCents: number | null
  targetCents: number | null
  highCents: number | null
  confidence: 'high' | 'medium' | 'low' | 'insufficient'
  isAskOnly: boolean
  riskFlags: { code: string; message: string }[]
}

export async function getWorkbenchPricingAdvisory(
  catalogModelId: string,
  catalogConfidence: 'exact' | 'strong' | 'possible' | null = null,
): Promise<WorkbenchPricingAdvisory | null> {
  if (!(await isAdminAuthenticated())) return null
  if (!catalogModelId) return null

  const intel = await getPricingIntelligence(catalogModelId)
  if (!intel) return null

  const riskFlags = deriveIntakeRiskFlags({
    pricingConfidence: intel.confidence.level,
    catalogConfidence,
    estimatedValueCents: intel.estimatedValueCents,
    highValueThresholdCents: DEFAULT_HIGH_VALUE_THRESHOLD_CENTS,
  })

  return {
    estimatedValueCents: intel.estimatedValueCents,
    lowCents: intel.recommendedListing.lowCents,
    targetCents: intel.recommendedListing.targetCents,
    highCents: intel.recommendedListing.highCents,
    confidence: intel.confidence.level,
    isAskOnly: intel.isAskOnly,
    riskFlags,
  }
}

// ─── Confirm & Next (section 11/12/16/17) ──────────────────────────────────────────

export type ConfirmWorkbenchItemInput = {
  shipmentId: string
  // Session/lease identity (15D-review section 2) — distinct from clientToken below.
  // One claimToken per browser tab/session; proven inside the transaction against the
  // durable IntakeWorkbenchSession lease before any draft/item is created.
  claimToken: string
  clientToken: string
  quantity: number
  catalogModelId: string | null
  condition: string | null
  cardedOrLoose: string | null
  conditionNotes: string | null
  storageLocationId: string | null
  notes: string | null
}

export type WorkbenchUnitResult =
  | { outcome: 'converted'; itemId: string; sku: string; catalogLabel: string; storageLabel: string }
  | { outcome: 'exception'; draftId: string; code: string; note: string }

export type ConfirmWorkbenchItemResult =
  | { ok: true; units: WorkbenchUnitResult[] }
  | { ok: false; error: string }

async function unitResultFromDraft(
  tx: TxClient,
  draft: { id: string; status: string; convertedItemId: string | null; workbenchExceptionCode: string | null; workbenchExceptionNote: string | null },
): Promise<WorkbenchUnitResult> {
  if (draft.status === 'converted' && draft.convertedItemId) {
    const item = await tx.itemInstance.findUnique({
      where: { id: draft.convertedItemId },
      select: { id: true, sku: true, catalog: { select: { brand: true, name: true } }, location: { select: { label: true } } },
    })
    if (item) {
      return {
        outcome: 'converted', itemId: item.id, sku: item.sku,
        catalogLabel: `${item.catalog.brand} ${item.catalog.name}`, storageLabel: item.location?.label ?? '',
      }
    }
  }
  return {
    outcome: 'exception', draftId: draft.id,
    code: draft.workbenchExceptionCode ?? 'unknown', note: draft.workbenchExceptionNote ?? '',
  }
}

export async function confirmWorkbenchItem(input: ConfirmWorkbenchItemInput): Promise<ConfirmWorkbenchItemResult> {
  if (!(await isAdminAuthenticated())) return { ok: false, error: 'Admin authentication required.' }
  if (!input.shipmentId) return { ok: false, error: 'Shipment is required.' }
  if (!input.claimToken) return { ok: false, error: 'Missing session token — reload and try again.' }
  if (!input.clientToken) return { ok: false, error: 'Missing client token — reload and try again.' }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_WORKBENCH_BATCH_QUANTITY) {
    return { ok: false, error: `Quantity must be between 1 and ${MAX_WORKBENCH_BATCH_QUANTITY}.` }
  }

  // One token per physical unit — deterministic from the single per-action client
  // token, so a retried confirm (double-click, Enter twice, network retry) regenerates
  // the exact same set of tokens and hits the idempotent-replay path below rather than
  // creating new drafts/items.
  const unitTokens = Array.from({ length: input.quantity }, (_, i) => `${input.clientToken}:${i}`)

  let txError: string | null = null
  let sellerSubmissionId: string | null = null
  let units: WorkbenchUnitResult[] = []

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SellerInboundShipment" WHERE id = ${input.shipmentId} FOR UPDATE`

      const shipment = await tx.sellerInboundShipment.findUnique({
        where: { id: input.shipmentId },
        select: { id: true, status: true, receivedQuantity: true, sellerSubmissionId: true, sellerPortfolioId: true },
      })
      if (!shipment) { txError = 'Shipment not found.'; throw new Error('TX_VALIDATION') }
      if (shipment.status !== 'received' && shipment.status !== 'issue') {
        txError = 'This shipment must be marked received before intake can begin.'
        throw new Error('TX_VALIDATION')
      }
      sellerSubmissionId = shipment.sellerSubmissionId

      // ── Idempotency (section 12) — checked under the shipment lock so a genuinely
      // concurrent duplicate confirm can never race past this point. A pure replay of
      // an already-processed action never touches the lease below: it creates nothing
      // new, so it must succeed regardless of which session currently holds intake
      // (e.g. a delayed network retry arriving after a legitimate takeover). ─────────
      const existingDrafts = await tx.intakeDraft.findMany({
        where: { sellerInboundShipmentId: input.shipmentId, workbenchClientToken: { in: unitTokens } },
        select: { id: true, workbenchClientToken: true, status: true, convertedItemId: true, workbenchExceptionCode: true, workbenchExceptionNote: true },
      })
      if (existingDrafts.length > 0) {
        if (existingDrafts.length !== unitTokens.length) {
          txError = 'This confirmation was partially processed already. Reload and check recent items before retrying.'
          throw new Error('TX_VALIDATION')
        }
        const byToken = new Map(existingDrafts.map((d) => [d.workbenchClientToken, d]))
        units = await Promise.all(unitTokens.map((t) => unitResultFromDraft(tx, byToken.get(t)!)))
        return
      }

      // ── Lease enforcement (15D-review section 2) — the actual write guard against
      // two admins independently processing physical units from the same shipment.
      // clientToken (idempotency) alone cannot solve this: two different admins
      // scanning the SAME physical car each generate a unique, valid clientToken, so
      // idempotency would let both through. Checked and claimed/renewed atomically,
      // inside the same transaction as the draft/item creation it guards. ───────────
      const leaseCheck = await assertLeaseOwnership(tx, input.shipmentId, input.claimToken)
      if (!leaseCheck.ok) { txError = leaseCheck.error; throw new Error('TX_VALIDATION') }

      // ── Batch eligibility — a whole-shipment/session gate, not a per-unit concern:
      // resolved fresh, inside the lock, never trusted from pre-transaction state. If
      // ineligible, NOTHING is created (not even an exception draft) — this indicates
      // the whole workbench session shouldn't be usable, matching getWorkbenchContext's
      // page-level eligibilityBlocked gate. ──────────────────────────────────────────
      const agreements = await tx.sellerAgreement.findMany({
        where: { submissionId: shipment.sellerSubmissionId, status: { not: 'cancelled' } },
        select: { id: true, type: true, status: true, agreedBuyoutAmount: true, sellerPortfolioId: true },
      })
      const eligibility = resolveConversionEligibility(shipment.sellerSubmissionId, agreements)
      if (!eligibility.eligible) { txError = eligibility.reason; throw new Error('TX_VALIDATION') }

      // ── Per-unit validation → exception vs normal path (section 16/17). Uniform for
      // the whole batch quantity: a homogeneous scan (same model/condition/storage)
      // either all convert or all become exceptions together — never half-and-half. ──
      let exceptionCode: string | null = null
      let exceptionNote: string | null = null

      const catalog = input.catalogModelId
        ? await tx.catalogModel.findUnique({ where: { id: input.catalogModelId }, select: { id: true } })
        : null
      if (!catalog) {
        exceptionCode = 'unknown_model'
        exceptionNote = 'No catalog model was resolved for this item.'
      }

      let location: { id: string } | null = null
      if (!exceptionCode) {
        location = input.storageLocationId
          ? await tx.storageLocation.findUnique({ where: { id: input.storageLocationId }, select: { id: true } })
          : null
        if (!location) {
          exceptionCode = 'invalid_storage'
          exceptionNote = 'Storage location is missing or no longer exists.'
        }
      }

      if (!exceptionCode && (!input.condition || !input.cardedOrLoose)) {
        exceptionCode = 'missing_condition'
        exceptionNote = 'Condition and carded/loose are required.'
      }

      if (!exceptionCode && shipment.receivedQuantity != null) {
        // 15D-review section 5: PHYSICAL-UNIT counts, not IntakeDraft-row counts —
        // itemInstance.count is one row per converted physical unit, and the exception
        // count below is one row per exception-flagged draft, and a quantity>1 batch
        // that becomes an exception creates one draft PER unit (see the exception loop
        // below), so this already accounts for every physical unit individually, never
        // merely "one action."
        const [processedCount, exceptionCount] = await Promise.all([
          tx.itemInstance.count({ where: { sellerInboundShipmentId: input.shipmentId } }),
          tx.intakeDraft.count({
            where: { sellerInboundShipmentId: input.shipmentId, ...openIntakeExceptionWhere() },
          }),
        ])
        if (wouldExceedReceived(shipment.receivedQuantity, processedCount + exceptionCount, input.quantity)) {
          exceptionCode = 'unexpected_overage'
          exceptionNote = `Processing this would exceed the ${shipment.receivedQuantity} physical unit(s) recorded as received.`
        }
      }

      if (exceptionCode) {
        // One IntakeDraft PER physical unit — a quantity=5 batch routed to exception
        // contributes 5, not 1, to the exception count (section 5).
        for (const token of unitTokens) {
          const draft = await tx.intakeDraft.create({
            data: {
              status: 'draft',
              sellerInboundShipmentId: input.shipmentId,
              sellerSubmissionId: shipment.sellerSubmissionId,
              catalogModelId: catalog?.id ?? null,
              condition: input.condition, cardedOrLoose: input.cardedOrLoose,
              conditionNotes: input.conditionNotes, storageLocationId: location?.id ?? null,
              notes: input.notes, workbenchClientToken: token,
              workbenchExceptionCode: exceptionCode, workbenchExceptionNote: exceptionNote,
              // 15E-review section 1: this draft is being created directly WITH an
              // exception code, so this is unconditionally its first occurrence —
              // immutable initial evidence is written here exactly once, never touched
              // again regardless of how the live fields above evolve during resolution.
              initialExceptionCode: exceptionCode, initialExceptionNote: exceptionNote, initialExceptionAt: new Date(),
            },
            select: { id: true, status: true, convertedItemId: true, workbenchExceptionCode: true, workbenchExceptionNote: true },
          })
          units.push(await unitResultFromDraft(tx, draft))
        }
        return
      }

      // ── Normal path — 15D-review section 1: create the IntakeDraft FIRST (its own
      // persisted row, status 'reviewed' — the workbench's per-unit checks above ARE
      // its review step), THEN hand it to the one authoritative conversion primitive.
      // Exactly one ItemInstance per physical unit; never one item with quantity=N. ──
      for (const token of unitTokens) {
        const draft = await tx.intakeDraft.create({
          data: {
            status: 'reviewed',
            sellerInboundShipmentId: input.shipmentId,
            sellerSubmissionId: shipment.sellerSubmissionId,
            catalogModelId: catalog!.id,
            condition: input.condition, cardedOrLoose: input.cardedOrLoose,
            conditionNotes: input.conditionNotes, storageLocationId: location!.id,
            notes: input.notes, workbenchClientToken: token,
          },
          select: { id: true },
        })

        const result = await convertIntakeDraft(tx, { draftId: draft.id, locationId: location!.id })

        if (!result.ok) {
          // Extremely rare race (e.g. the catalog/storage row vanished between this
          // batch's pre-check above and the primitive's own re-validation). The
          // physical item still exists — route it to an exception rather than
          // aborting the whole confirm, and never leave the draft stuck in 'reviewed'
          // limbo (section 7: never converted-without-item or reviewed-without-either).
          await tx.intakeDraft.update({
            where: { id: draft.id },
            data: {
              status: 'draft', workbenchExceptionCode: 'conversion_failed', workbenchExceptionNote: result.message,
              // 15E-review section 1: this draft was created moments earlier in this
              // same transaction WITHOUT an exception code — this is its first
              // transition into exception state, so initial evidence is written here too.
              initialExceptionCode: 'conversion_failed', initialExceptionNote: result.message, initialExceptionAt: new Date(),
            },
          })
          units.push({ outcome: 'exception', draftId: draft.id, code: 'conversion_failed', note: result.message })
          continue
        }

        const item = await tx.itemInstance.findUnique({
          where: { id: result.itemId },
          select: { catalog: { select: { brand: true, name: true } }, location: { select: { label: true } } },
        })
        units.push({
          outcome: 'converted', itemId: result.itemId, sku: result.sku,
          catalogLabel: item ? `${item.catalog.brand} ${item.catalog.name}` : '', storageLabel: item?.location?.label ?? '',
        })
      }
    }, { timeout: 20_000 })
  } catch (e) {
    if (txError) return { ok: false, error: txError }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: false, error: 'This action conflicted with a concurrent request. Please retry — no duplicate item was created.' }
    }
    throw e
  }

  if (sellerSubmissionId) {
    for (const unit of units) {
      if (unit.outcome !== 'converted') continue
      try {
        await ensureSellerLifecycleEvent({
          eventKey: `intake-converted:${unit.itemId}`,
          sellerSubmissionId,
          eventType: 'intake_converted',
          sourceEntityType: 'item_instance',
          sourceEntityId: unit.itemId,
          sellerVisible: true,
          sellerTitle: 'Item received',
          sellerDescription: 'Your item has been received and added to inventory.',
          occurredAt: new Date(),
        })
      } catch (err) {
        console.error('[confirmWorkbenchItem] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
      }
    }
  }

  revalidatePath(`/admin/intake/workbench/${input.shipmentId}`)
  revalidatePath('/admin/items')
  if (sellerSubmissionId) {
    revalidatePath(`/admin/seller-submissions/${sellerSubmissionId}`)
    revalidatePath('/admin/seller-payouts')
  }

  return { ok: true, units }
}

// ─── Reconciliation ("Finish intake") — section 2/3/4/5 of the reconciliation pass ──
//
// This action NEVER creates or converts anything (no fabricated missing physical
// items), NEVER writes SellerInboundShipment.receivedQuantity, SellerAgreement, or
// SellerPortfolio — it only re-counts and persists an audited snapshot. Completion is
// therefore never silently implied by remaining===0; it requires this explicit,
// audited action, and even then only ever marks THIS shipment's physical-count
// reconciliation — never the SellerPortfolio.

export type ReconcileShipmentResult =
  | { ok: true; recordedReceived: number; observedPhysical: number; variance: number; hasUnresolvedExceptions: boolean }
  | { ok: false; error: string }

// 15D-review (final approval pass) section 2: actor attribution. This codebase has no
// per-admin identity — one shared ADMIN_PASSWORD derives one session cookie (see
// adminAuth.ts / proxy.ts), with no AdminUser row or per-admin id anywhere in the
// schema (confirmed by inspection). 'admin' is therefore the actual, already-
// established convention for "who did this" elsewhere in the codebase (see
// actions/commissionPolicies.ts's `createdBy: 'admin'`) — not a placeholder invented
// here. It comes ONLY from the isAdminAuthenticated() server-side gate immediately
// below; reconcileWorkbenchShipment's signature has no actor/adminId parameter at
// all, so a caller cannot supply or override it from client input.
const RECONCILED_BY_ACTOR = 'admin'

export async function reconcileWorkbenchShipment(shipmentId: string, claimToken: string): Promise<ReconcileShipmentResult> {
  if (!(await isAdminAuthenticated())) return { ok: false, error: 'Admin authentication required.' }
  if (!shipmentId) return { ok: false, error: 'Shipment is required.' }
  if (!claimToken) return { ok: false, error: 'Missing session token — reload and try again.' }

  let txError: string | null = null
  let output: { recordedReceived: number; observedPhysical: number; variance: number; hasUnresolvedExceptions: boolean } | null = null

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Lock shipment — the same serialization boundary confirmWorkbenchItem uses.
      await tx.$queryRaw`SELECT id FROM "SellerInboundShipment" WHERE id = ${shipmentId} FOR UPDATE`

      const shipment = await tx.sellerInboundShipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, status: true, receivedQuantity: true, sellerSubmissionId: true },
      })
      if (!shipment) { txError = 'Shipment not found.'; throw new Error('TX_VALIDATION') }
      if (shipment.status !== 'received' && shipment.status !== 'issue') {
        txError = 'This shipment must be marked received before it can be reconciled.'
        throw new Error('TX_VALIDATION')
      }
      if (shipment.receivedQuantity == null) {
        txError = 'This shipment has no recorded received quantity to reconcile against.'
        throw new Error('TX_VALIDATION')
      }

      // 2. Lease/takeover check — a stale session (superseded by an explicit takeover)
      // must not be able to finalize reconciliation any more than it can confirm items.
      const leaseCheck = await assertLeaseOwnership(tx, shipmentId, claimToken)
      if (!leaseCheck.ok) { txError = leaseCheck.error; throw new Error('TX_VALIDATION') }

      // 3. Re-fetch processed + exception counts — never trusted from page state.
      const [processedCount, exceptionCount] = await Promise.all([
        tx.itemInstance.count({ where: { sellerInboundShipmentId: shipmentId } }),
        tx.intakeDraft.count({
          where: { sellerInboundShipmentId: shipmentId, ...openIntakeExceptionWhere() },
        }),
      ])

      // 4. Calculate observed quantity / variance.
      const observedPhysical = computeObservedPhysical(processedCount, exceptionCount)
      const variance = computeReconciliationVariance(shipment.receivedQuantity, observedPhysical)
      const hasUnresolvedExceptions = exceptionCount > 0

      // 5. Persist reconciliation result/audit — reuses the existing seller lifecycle
      // event infrastructure (section 4). Required evidence fields and where each one
      // lives: shipment -> sourceEntityId (top-level column, not duplicated into
      // metadata); reconciledAt -> occurredAt (top-level column); actor,
      // recordedReceived, observedPhysical, processedCount, exceptionCount, variance,
      // hasUnresolvedExceptions -> metadata (SellerLifecycleEvent has no dedicated
      // actor/createdBy column, so metadata is the only place these can live).
      //
      // eventKey is keyed by the exact counts being reconciled (NOT by actor) — so
      // re-running with UNCHANGED state (same recordedReceived/observedPhysical) is a
      // safe idempotent no-op (ensureSellerLifecycleEvent skips an existing row) even
      // across an accidental double-click or two different admin sessions reconciling
      // the same true state; a genuinely changed physical state (e.g. an exception
      // later resolved) produces a fresh, superseding snapshot with its own actor,
      // rather than silently mutating the old one. sellerVisible: false — this is
      // internal warehouse/ops evidence, not a seller-facing event, and carries no
      // buyer or seller PII (only counts and the fixed 'admin' actor literal).
      await ensureSellerLifecycleEvent({
        eventKey: `shipment-intake-reconciled:${shipmentId}:${shipment.receivedQuantity}:${observedPhysical}`,
        sellerSubmissionId: shipment.sellerSubmissionId,
        eventType: 'shipment_intake_reconciled',
        sourceEntityType: 'SellerInboundShipment',
        sourceEntityId: shipmentId,
        sellerVisible: false,
        adminDescription:
          `Intake reconciled: recorded received ${shipment.receivedQuantity}, physically observed ${observedPhysical} ` +
          `(processed ${processedCount} + exceptions ${exceptionCount}), variance ${variance}.`,
        metadata: {
          recordedReceived: shipment.receivedQuantity, observedPhysical, processedCount, exceptionCount,
          variance, hasUnresolvedExceptions, actor: RECONCILED_BY_ACTOR,
        },
        occurredAt: new Date(),
        tx,
      })

      // Never touched: SellerInboundShipment.receivedQuantity, SellerAgreement (signed
      // quantity/commission tier), SellerPortfolio.status.
      output = { recordedReceived: shipment.receivedQuantity, observedPhysical, variance, hasUnresolvedExceptions }
    })
  } catch (e) {
    if (txError) return { ok: false, error: txError }
    throw e
  }

  revalidatePath(`/admin/intake/workbench/${shipmentId}`)
  return { ok: true, ...output! }
}
