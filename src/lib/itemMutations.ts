// 15I (focused-review pass): the ONE authoritative place for ItemInstance mutation
// rules — storage-move eligibility, condition enum, and catalog-reassignment risk
// context. Every real runtime caller (single-item admin edit, the dedicated "move"
// action, and the bulk item-action engine) delegates here instead of maintaining
// its own copy. Transaction-aware primitives (the `InTx` / `validate*` functions)
// take an already-open `tx` and never open their own — callers own transaction
// boundaries so a multi-field single-item edit can validate+apply storage AND
// catalog AND everything else in exactly one atomic transaction, while bulk callers
// still get one independent transaction per physical item (partial success).

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'
import type { ItemCatalogReassignmentContext } from '@/lib/riskPolicy'

type TxClient = Prisma.TransactionClient

export type ItemMutationOutcome =
  | { outcome: 'updated' }
  | { outcome: 'unchanged' }
  | { outcome: 'approval_required'; approvalRequestId: string }
  | { outcome: 'denied'; reason: string }
  | { outcome: 'not_found' }
  | { outcome: 'validation_failed'; reason: string }

// ── Storage (Part D) — the authoritative domain rules, moved here from the
// previously-unwired moveInventoryItem/bulkMoveInventoryItems in
// actions/intakeOperations.ts (focused-review section 8: a shared primitive should
// not import business-validation constants from an action module — the dependency
// now runs the other way, intakeOperations.ts imports FROM here). No new rule is
// invented; this is exactly what moveInventoryItem already enforced. ─────────────
export const IMMOVABLE_STATUSES = ['sold', 'reserved', 'not_for_sale'] as const
export const RETURN_PENDING_CASE_TYPES = ['return_to_seller', 'consignment_expiration', 'seller_withdrawal'] as const

export type StorageMoveValidation =
  | { ok: true; unchanged: boolean }
  | { ok: false; outcome: 'not_found' }
  | { ok: false; outcome: 'validation_failed'; reason: string }

// Row-locks and validates ONLY — never writes. This is what lets a multi-field
// single-item edit (updateItemInstance) fold the storage rule into its own single
// combined `data: {...}` update rather than issuing a second, separately-atomic
// write (focused-review section 4 — "do not update some fields and then fail
// storage afterward"). Single-purpose callers that just want "validate AND write"
// use setItemStorageInTx below instead.
export async function validateItemStorageMove(
  tx: TxClient,
  params: { itemId: string; locationId: string },
): Promise<StorageMoveValidation> {
  await tx.$queryRaw`SELECT id FROM "ItemInstance" WHERE id = ${params.itemId} FOR UPDATE`

  const item = await tx.itemInstance.findUnique({ where: { id: params.itemId }, select: { id: true, status: true, locationId: true } })
  if (!item) return { ok: false, outcome: 'not_found' }
  if ((IMMOVABLE_STATUSES as readonly string[]).includes(item.status)) {
    return { ok: false, outcome: 'validation_failed', reason: `Cannot move item with status '${item.status}'.` }
  }

  const openReturnCase = await tx.sellerLifecycleCase.findFirst({
    where: { itemInstanceId: params.itemId, caseType: { in: [...RETURN_PENDING_CASE_TYPES] }, status: { in: ['open', 'action_required'] } },
    select: { caseType: true },
  })
  if (openReturnCase) {
    return { ok: false, outcome: 'validation_failed', reason: `Cannot move item: it has an open ${openReturnCase.caseType} case.` }
  }

  if (item.locationId === params.locationId) return { ok: true, unchanged: true }

  // Re-validate location inside the transaction — it may have been deleted between
  // any pre-check and acquiring this item's lock.
  const locInTx = await tx.storageLocation.findUnique({ where: { id: params.locationId }, select: { id: true } })
  if (!locInTx) return { ok: false, outcome: 'validation_failed', reason: 'Storage location was deleted.' }

  return { ok: true, unchanged: false }
}

// Validate AND write, inside the caller's transaction — used by callers whose
// ENTIRE consequential mutation is "move this item's storage" (moveInventoryItem,
// and the per-item transaction each bulk set_storage call opens).
export async function setItemStorageInTx(tx: TxClient, params: { itemId: string; locationId: string }): Promise<ItemMutationOutcome> {
  const v = await validateItemStorageMove(tx, params)
  if (!v.ok) return v.outcome === 'not_found' ? { outcome: 'not_found' } : { outcome: 'validation_failed', reason: v.reason }
  if (v.unchanged) return { outcome: 'unchanged' }
  await tx.itemInstance.update({ where: { id: params.itemId }, data: { locationId: params.locationId } })
  return { outcome: 'updated' }
}

// Bulk-facing convenience wrapper — opens its OWN transaction (one per physical
// item; the bulk engine calls this once per selected id, so a failure on one item
// never affects another's).
export async function setItemStorage(itemId: string, locationId: string): Promise<ItemMutationOutcome> {
  const location = await prisma.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } })
  if (!location) return { outcome: 'validation_failed', reason: 'Storage location not found.' }

  try {
    return await prisma.$transaction((tx) => setItemStorageInTx(tx, { itemId, locationId }))
  } catch {
    return { outcome: 'validation_failed', reason: 'Storage update failed. Please retry.' }
  }
}

// ── Condition (Part E) — the ONE shared enum every caller validates against. No
// condition is lifecycle-immutable in the current domain model (a condition change
// is allowed regardless of item status), so there is no transaction-level rule to
// centralize the way storage has one — enum identity is the only real "rule", and
// sharing this constant is what keeps single-item and bulk validation from drifting. ──
export const ITEM_CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'] as const

export async function setItemCondition(itemId: string, condition: string): Promise<ItemMutationOutcome> {
  if (!(ITEM_CONDITIONS as readonly string[]).includes(condition)) {
    return { outcome: 'validation_failed', reason: 'Invalid condition.' }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ItemInstance" WHERE id = ${itemId} FOR UPDATE`
      const item = await tx.itemInstance.findUnique({ where: { id: itemId }, select: { id: true, condition: true } })
      if (!item) return { outcome: 'not_found' } as const
      if (item.condition === condition) return { outcome: 'unchanged' } as const
      await tx.itemInstance.update({ where: { id: itemId }, data: { condition } })
      return { outcome: 'updated' } as const
    })
  } catch {
    return { outcome: 'validation_failed', reason: 'Condition update failed. Please retry.' }
  }
}

// ── Catalog reassignment (Part F) — the ONLY path that may change catalogId; always
// through the 15F item_catalog_reassignment risk gate. buildItemCatalogReassignmentContext
// is the single shared context builder — updateItemInstance and the bulk engine both
// call it with their own freshly-fetched item data, so the two can never silently
// diverge in what they tell the risk engine. ─────────────────────────────────────
export type CatalogReassignmentSourceItem = {
  catalogId: string
  status: string
  listing: { price: number } | null
  orderItems: { price: number }[]
  sellerAgreement: { type: string; agreedBuyoutAmount: { toString(): string } | null; acceptedItemCount: number | null } | null
}

export function buildItemCatalogReassignmentContext(
  itemId: string,
  newCatalogModelId: string,
  existing: CatalogReassignmentSourceItem,
  estimatedValueCents: number | null,
): ItemCatalogReassignmentContext {
  return {
    itemId,
    oldCatalogModelId: existing.catalogId,
    newCatalogModelId,
    hasCompletedSale: existing.status === 'sold' || existing.orderItems.length > 0,
    completedSaleAmountCents: existing.orderItems[0] ? Math.round(existing.orderItems[0].price * 100) : null,
    currentListingPriceCents: existing.listing ? Math.round(existing.listing.price * 100) : null,
    estimatedValueCents,
    agreementBuyoutTotalCents:
      existing.sellerAgreement?.type === 'buyout' && existing.sellerAgreement.acceptedItemCount === 1 && existing.sellerAgreement.agreedBuyoutAmount
        ? Math.round(parseFloat(existing.sellerAgreement.agreedBuyoutAmount.toString()) * 100)
        : null,
  }
}

const CATALOG_REASSIGNMENT_SELECT = {
  catalogId: true, status: true,
  listing: { select: { price: true } },
  orderItems: { where: { order: { paymentStatus: 'paid' } }, select: { price: true }, take: 1 },
  sellerAgreement: { select: { type: true, agreedBuyoutAmount: true, acceptedItemCount: true } },
} as const

export async function setItemCatalog(itemId: string, catalogId: string, requestedBy: string): Promise<ItemMutationOutcome> {
  const [catalog, existing] = await Promise.all([
    prisma.catalogModel.findUnique({ where: { id: catalogId }, select: { id: true } }),
    prisma.itemInstance.findUnique({ where: { id: itemId }, select: CATALOG_REASSIGNMENT_SELECT }),
  ])
  if (!existing) return { outcome: 'not_found' }
  if (!catalog) return { outcome: 'validation_failed', reason: 'Catalog model not found.' }
  // Idempotent — reassigning to the item's own current model is a no-op and must
  // never generate an approval request (section 25).
  if (catalogId === existing.catalogId) return { outcome: 'unchanged' }

  const intel = await getPricingIntelligence(catalogId)
  const riskContext = buildItemCatalogReassignmentContext(itemId, catalogId, existing, intel?.estimatedValueCents ?? null)

  const gate = await checkRiskGate({ action: 'item_catalog_reassignment', context: riskContext, targetType: 'item_instance', targetId: itemId, requestedBy })
  if (gate.decision === 'deny') return { outcome: 'denied', reason: gate.reasons.join(' ') }
  // Each item independently reaches its own pending approval request — one approved
  // request can never authorize a different item's reassignment (contextFingerprint
  // binds action+targetId+context, see computeContextFingerprint).
  if (gate.decision === 'pending') return { outcome: 'approval_required', approvalRequestId: gate.approvalRequestId }

  if (gate.decision === 'consume_approved') {
    let result: ItemMutationOutcome = { outcome: 'updated' }
    await prisma.$transaction(async (tx) => {
      const consumed = await consumeApprovedRiskGate(tx, {
        approvalRequestId: gate.approvalRequestId, action: 'item_catalog_reassignment', targetId: itemId,
        context: riskContext as unknown as Record<string, unknown>,
      })
      if (!consumed.ok) { result = { outcome: 'validation_failed', reason: consumed.error }; throw new Error('TX_VALIDATION') }
      await tx.itemInstance.update({ where: { id: itemId }, data: { catalogId } })
      await markApprovalConsumed(tx, gate.approvalRequestId)
    }).catch((e) => { if ((e as Error).message !== 'TX_VALIDATION') throw e })
    return result
  }

  // decision === 'allow'
  await prisma.itemInstance.update({ where: { id: itemId }, data: { catalogId } })
  return { outcome: 'updated' }
}
