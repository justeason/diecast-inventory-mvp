// 15D: DB boundary for the bulk intake workbench. Read-only — never mutates (see
// actions/intakeWorkbench.ts for the confirm/lease mutations). Bounded, targeted
// queries only (section 28): no full portfolio/shipment item load, no full
// CatalogModel load, counts computed DB-side, recent items capped.
//
// ── 15D-review section 3: the normal shipment → intake sequence, and why it does NOT
// require counting the same box of physical items twice ─────────────────────────────
//   1. Carrier delivers the package.
//   2. Admin marks the shipment received (existing 15B `receiveSellerInboundShipment`,
//      unchanged by 15D): a SINGLE quick tally — receivedQuantity, typically read
//      straight off the packing slip or a fast box count — plus a condition status
//      (good/issue). This is a RECEIVING-DOCK reconciliation step: "how many units did
//      the carrier hand over," not per-unit identification. The workbench never asks
//      for this number again and never writes SellerInboundShipment.receivedQuantity.
//   3. Admin clicks "Start / Continue Intake" from the portfolio page — the workbench
//      opens immediately; there is no separate "confirm a count before you can start"
//      screen.
//   4. The workbench processes physical units ONE AT A TIME: scan/search model ->
//      confirm storage -> Confirm & Next. Each confirm is per-unit IDENTIFICATION and
//      cataloging (which model, which condition, which shelf) — a fundamentally
//      different activity from step 2's bulk tally, not a redundant re-count of the
//      same box. `processed`/`exceptions` accumulate against the SAME step-2 total
//      (see computeWorkbenchProgress) with no second manual entry point.
//   5. Overage beyond the step-2 total is flagged (wouldExceedReceived), never
//      silently absorbed; the shipment is never shown "complete" while exceptions
//      remain (evaluateWorkbenchCompletion).

import { prisma } from '@/lib/prisma'
import { resolveConversionEligibility, type SourceType } from '@/lib/sellerAgreementInventory'
import {
  computeWorkbenchProgress, isLeaseActive, computeObservedPhysical, computeReconciliationVariance,
  isReconciliationCurrent, deriveIntakeReconciliationStatus,
  type WorkbenchProgress, type IntakeReconciliationStatus,
} from '@/lib/intakeWorkbench'

const RECENT_ITEMS_LIMIT = 10

// Loosely-typed shape of the metadata JSON persisted by reconcileWorkbenchShipment
// (actions/intakeWorkbench.ts) — validated field-by-field before use, never trusted
// blindly (Json columns carry no schema guarantee).
function parseReconciliationMetadata(metadata: unknown): { recordedReceived: number; observedPhysical: number } | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as Record<string, unknown>
  if (typeof m.recordedReceived !== 'number' || typeof m.observedPhysical !== 'number') return null
  return { recordedReceived: m.recordedReceived, observedPhysical: m.observedPhysical }
}

export type WorkbenchContext = {
  shipment: {
    id: string
    status: string
    carrier: string | null
    trackingNumber: string | null
    expectedQuantity: number
    receivedQuantity: number | null
    shippedAt: Date | null
    receivedAt: Date | null
  }
  submission: { id: string; quantity: number; status: string }
  portfolio: { id: string; name: string | null; acceptedItemCount: number | null } | null
  seller: { sellerProfileId: string | null; label: string }
  agreement: {
    id: string
    type: string
    status: string
    commissionPercent: string | null
    commissionSource: string | null
  } | null
  // Authoritative only once an agreement is accepted — see resolveConversionEligibility.
  // `eligibilityBlocked` carries the reason when intake cannot proceed at all (e.g. no
  // accepted agreement yet); the workbench page surfaces this instead of the entry form.
  sourceType: SourceType | null
  eligibilityBlocked: string | null
  defaults: { condition: string | null; cardedOrLoose: string | null }
  progress: WorkbenchProgress
  recentItems: Array<{ id: string; sku: string; catalogLabel: string; storageLabel: string | null; createdAt: Date }>
  lease: { held: boolean; expiresAt: Date | null }
  // 15D-review (reconciliation pass) section 2/3: `observedPhysical`/`variance` are
  // ALWAYS live (recomputed from current counts), so the admin can preview them before
  // ever running the explicit reconciliation action. `status` only becomes
  // 'reconciled'/'reconciled_with_variance' when a PRIOR reconciliation event still
  // matches those live numbers (see isReconciliationCurrent) — a stale one (state
  // changed since) reverts to 'in_progress', never silently kept.
  reconciliation: {
    status: IntakeReconciliationStatus
    observedPhysical: number
    variance: number | null // null only if receivedQuantity is still unset
    hasUnresolvedExceptions: boolean
    lastReconciledAt: Date | null
  }
}

export async function getWorkbenchContext(shipmentId: string): Promise<WorkbenchContext | null> {
  const shipment = await prisma.sellerInboundShipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true, status: true, carrier: true, trackingNumber: true,
      expectedQuantity: true, receivedQuantity: true, shippedAt: true, receivedAt: true,
      sellerSubmissionId: true, sellerPortfolioId: true,
    },
  })
  if (!shipment) return null

  const [submission, agreements, portfolio, processedCount, exceptionCount, recentItems, lease, latestReconciliation] = await Promise.all([
    prisma.sellerSubmission.findUnique({
      where: { id: shipment.sellerSubmissionId },
      select: { id: true, quantity: true, status: true, condition: true, cardedOrLoose: true, profileId: true },
    }),
    prisma.sellerAgreement.findMany({
      where: { submissionId: shipment.sellerSubmissionId, status: { not: 'cancelled' } },
      select: { id: true, type: true, status: true, commissionPercent: true, commissionSource: true, sellerPortfolioId: true },
    }),
    shipment.sellerPortfolioId
      ? prisma.sellerPortfolio.findUnique({
          where: { id: shipment.sellerPortfolioId },
          select: { id: true, name: true, acceptedItemCount: true },
        })
      : Promise.resolve(null),
    // Bounded COUNT — never a loaded list (section 28). Every workbench-converted item
    // carries this FK directly (section 2 of the 15D lineage requirement), so this is a
    // simple, authoritative, single-table count.
    prisma.itemInstance.count({ where: { sellerInboundShipmentId: shipmentId } }),
    prisma.intakeDraft.count({
      where: { sellerInboundShipmentId: shipmentId, status: { not: 'converted' }, workbenchExceptionCode: { not: null } },
    }),
    // Bounded, presentation-only recent-items strip (section 27) — never the full
    // shipment's item list.
    prisma.itemInstance.findMany({
      where: { sellerInboundShipmentId: shipmentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_ITEMS_LIMIT,
      select: { id: true, sku: true, createdAt: true, catalog: { select: { brand: true, name: true } }, location: { select: { label: true } } },
    }),
    prisma.intakeWorkbenchSession.findUnique({ where: { sellerInboundShipmentId: shipmentId } }),
    // Most recent reconciliation evidence (section 4 auditability) — bounded (take 1
    // via findFirst on an indexed [sourceEntityType, sourceEntityId] pair).
    prisma.sellerLifecycleEvent.findFirst({
      where: { sourceEntityType: 'SellerInboundShipment', sourceEntityId: shipmentId, eventType: 'shipment_intake_reconciled' },
      orderBy: { occurredAt: 'desc' },
      select: { metadata: true, occurredAt: true },
    }),
  ])
  if (!submission) return null

  const eligibility = resolveConversionEligibility(shipment.sellerSubmissionId, agreements)
  const agreementId = eligibility.eligible ? eligibility.acceptedAgreementId : null
  const agreement = agreements.find((a) => a.id === agreementId) ?? null

  let sellerLabel = 'Unknown seller'
  let sellerProfileId: string | null = null
  if (submission.profileId) {
    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { profileId: submission.profileId },
      select: { id: true, profile: { select: { name: true, email: true } } },
    })
    if (sellerProfile) {
      sellerProfileId = sellerProfile.id
      sellerLabel = sellerProfile.profile.name ?? sellerProfile.profile.email
    }
  }

  const now = new Date()

  const observedPhysical = computeObservedPhysical(processedCount, exceptionCount)
  const variance = shipment.receivedQuantity == null ? null : computeReconciliationVariance(shipment.receivedQuantity, observedPhysical)
  const priorSnapshot = latestReconciliation ? parseReconciliationMetadata(latestReconciliation.metadata) : null
  const reconciliationIsCurrent = shipment.receivedQuantity != null
    && isReconciliationCurrent(priorSnapshot, { recordedReceived: shipment.receivedQuantity, observedPhysical })

  return {
    shipment: {
      id: shipment.id, status: shipment.status, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber,
      expectedQuantity: shipment.expectedQuantity, receivedQuantity: shipment.receivedQuantity,
      shippedAt: shipment.shippedAt, receivedAt: shipment.receivedAt,
    },
    submission: { id: submission.id, quantity: submission.quantity, status: submission.status },
    portfolio,
    seller: { sellerProfileId, label: sellerLabel },
    agreement: agreement
      ? {
          id: agreement.id, type: agreement.type, status: agreement.status,
          commissionPercent: agreement.commissionPercent?.toString() ?? null,
          commissionSource: agreement.commissionSource,
        }
      : null,
    sourceType: eligibility.eligible ? eligibility.sourceType : null,
    eligibilityBlocked: eligibility.eligible ? null : eligibility.reason,
    defaults: { condition: submission.condition, cardedOrLoose: submission.cardedOrLoose },
    progress: computeWorkbenchProgress({
      expectedQuantity: shipment.expectedQuantity,
      receivedQuantity: shipment.receivedQuantity,
      processedCount,
      exceptionCount,
    }),
    recentItems: recentItems.map((i) => ({
      id: i.id, sku: i.sku, catalogLabel: `${i.catalog.brand} ${i.catalog.name}`,
      storageLabel: i.location?.label ?? null, createdAt: i.createdAt,
    })),
    lease: isLeaseActive(lease, now) ? { held: true, expiresAt: lease!.expiresAt } : { held: false, expiresAt: null },
    reconciliation: {
      status: deriveIntakeReconciliationStatus(reconciliationIsCurrent && variance != null ? { variance } : null),
      observedPhysical,
      variance,
      hasUnresolvedExceptions: exceptionCount > 0,
      lastReconciledAt: reconciliationIsCurrent ? latestReconciliation!.occurredAt : null,
    },
  }
}
