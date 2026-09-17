// 26B: durable ownership ledger — AcquisitionLot + CollectionDisposal +
// CollectionDisposalAllocation. CollectionItem is the required, durable
// identity anchor (26A follow-up) — every write here is scoped to exactly one
// CollectionItem, never profileId/catalogId directly.
//
// All mutating functions here take an open Prisma.TransactionClient — callers
// own the `$transaction` boundary (order completion, intake conversion,
// collection actions) so acquisition/disposal + the CollectionItem.quantity
// cache update are always atomic, all-or-nothing.
//
// FIFO is load-bearing: allocation order depends ONLY on ownership chronology
// (COALESCE(acquiredAt, ledgerEffectiveAt), then createdAt, then id) — NEVER
// on cost knowledge. An unknown-cost lot is allocated exactly like any other
// when it is chronologically oldest; the resulting allocation's
// allocatedRecordedCostCents is simply null, and Recorded Realized Gain/Loss
// becomes partial/unavailable for that disposal. Ownership correctness always
// outranks calculable gain.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { internalPriceToCents } from '@/lib/marketMoney'

export type CostKnowledge = 'known' | 'ambiguous_legacy' | 'unknown'
export type AcquisitionSource = 'manual' | 'i_own_it' | 'quick_capture' | 'legacy_backfill' | 'correction'
export type DisposalType = 'platform_sale' | 'external_sale' | 'gift' | 'trade' | 'other_removal' | 'correction'

// Disposal types that ever carry proceeds/Recorded Realized Gain/Loss — the
// realized-coverage denominator (§57 of the 26B spec) is scoped to these only.
export const SALE_DISPOSAL_TYPES: readonly DisposalType[] = ['platform_sale', 'external_sale']

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`INVALID_QUANTITY: ${label} must be a positive integer`)
  }
}

function assertValidCentsOrNull(value: number | null | undefined, label: string): void {
  if (value === null || value === undefined) return
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`INVALID_CENTS: ${label} must be >= 0 or null`)
  }
}

// ── FIFO ordering — pure, directly testable ─────────────────────────────────

type FifoLot = { acquiredAt: Date | null; ledgerEffectiveAt: Date; createdAt: Date; id: string }

export function compareLotsForFifo(a: FifoLot, b: FifoLot): number {
  const aTime = (a.acquiredAt ?? a.ledgerEffectiveAt).getTime()
  const bTime = (b.acquiredAt ?? b.ledgerEffectiveAt).getTime()
  if (aTime !== bTime) return aTime - bTime
  const createdDiff = a.createdAt.getTime() - b.createdAt.getTime()
  if (createdDiff !== 0) return createdDiff
  return a.id.localeCompare(b.id)
}

// ── Legacy cost backfill resolution — pure, directly testable ──────────────

export type LegacyCostResolution = {
  unitRecordedCostCents: number | null
  legacyRecordedPriceCents: number | null
  costKnowledge: CostKnowledge
}

// quantity=1 + valid price -> known (per-unit and total interpretations
// coincide). quantity>1 + valid price -> ambiguous_legacy, raw value
// preserved for display/audit only, NEVER entered into cost math. Invalid
// (negative/non-finite) or null price -> unknown. Never invents a cost.
export function resolveLegacyCostKnowledge(quantity: number, purchasePrice: number | null): LegacyCostResolution {
  if (purchasePrice === null || !Number.isFinite(purchasePrice) || purchasePrice < 0) {
    return { unitRecordedCostCents: null, legacyRecordedPriceCents: null, costKnowledge: 'unknown' }
  }
  if (quantity === 1) {
    return { unitRecordedCostCents: internalPriceToCents(purchasePrice), legacyRecordedPriceCents: null, costKnowledge: 'known' }
  }
  return { unitRecordedCostCents: null, legacyRecordedPriceCents: internalPriceToCents(purchasePrice), costKnowledge: 'ambiguous_legacy' }
}

// The backfill runs as a separate manual step, sometime after the ledger
// migration itself — a CollectionItem can legitimately be created in that
// gap. Ownership must never be projected as ledger-known before the
// CollectionItem existed, so such a row uses its own (later) createdAt
// instead of the earlier shared cutover; every pre-cutover row still shares
// the one cutover timestamp.
export function resolveLedgerEffectiveAt(cutover: Date, collectionItemCreatedAt: Date): Date {
  return collectionItemCreatedAt > cutover ? collectionItemCreatedAt : cutover
}

// ── Acquisition ──────────────────────────────────────────────────────────────

export type CreateAcquisitionLotInput = {
  collectionItemId: string
  quantityAcquired: number
  unitRecordedCostCents?: number | null
  legacyRecordedPriceCents?: number | null
  costKnowledge: CostKnowledge
  acquiredAt?: Date | null
  ledgerEffectiveAt: Date
  source: AcquisitionSource
  sourceKey?: string | null
  // Default true — increments CollectionItem.quantity by quantityAcquired.
  // The legacy backfill script passes false: a backfilled CollectionItem's
  // quantity already reflects the correct pre-ledger value from years of
  // direct writes, so the founding lot must NOT increment it again.
  syncCollectionItemQuantity?: boolean
}

export type CreateAcquisitionLotResult = { lot: Prisma.AcquisitionLotGetPayload<object>; created: boolean }

export async function createAcquisitionLot(
  tx: Prisma.TransactionClient,
  input: CreateAcquisitionLotInput,
): Promise<CreateAcquisitionLotResult> {
  assertPositiveInt(input.quantityAcquired, 'quantityAcquired')
  assertValidCentsOrNull(input.unitRecordedCostCents, 'unitRecordedCostCents')
  assertValidCentsOrNull(input.legacyRecordedPriceCents, 'legacyRecordedPriceCents')

  if (input.sourceKey) {
    const existing = await tx.acquisitionLot.findUnique({ where: { sourceKey: input.sourceKey } })
    if (existing) return { lot: existing, created: false }
  }

  const lot = await tx.acquisitionLot.create({
    data: {
      collectionItemId: input.collectionItemId,
      quantityAcquired: input.quantityAcquired,
      remainingQuantity: input.quantityAcquired,
      unitRecordedCostCents: input.unitRecordedCostCents ?? null,
      legacyRecordedPriceCents: input.legacyRecordedPriceCents ?? null,
      costKnowledge: input.costKnowledge,
      acquiredAt: input.acquiredAt ?? null,
      ledgerEffectiveAt: input.ledgerEffectiveAt,
      source: input.source,
      sourceKey: input.sourceKey ?? null,
    },
  })

  if (input.syncCollectionItemQuantity ?? true) {
    await tx.collectionItem.update({
      where: { id: input.collectionItemId },
      data: { quantity: { increment: input.quantityAcquired } },
    })
  }

  return { lot, created: true }
}

// ── Disposal ─────────────────────────────────────────────────────────────────

export type CreateDisposalInput = {
  collectionItemId: string
  quantity: number
  disposalType: DisposalType
  disposedAt: Date
  grossProceedsCents?: number | null
  netProceedsCents?: number | null
  sourceKey?: string | null
  notes?: string | null
}

export type CreateDisposalResult =
  | { status: 'created'; disposal: Prisma.CollectionDisposalGetPayload<object> }
  | { status: 'already_exists'; disposal: Prisma.CollectionDisposalGetPayload<object> }
  | { status: 'insufficient_quantity'; available: number; requested: number }

type ExistingDisposal = Prisma.CollectionDisposalGetPayload<object>

// Consignment proceeds arrive in two waves: grossProceedsCents is known at
// order completion, but netProceedsCents depends on SellerPayoutLine, which
// can legitimately be generated later (e.g. after a transient failure in
// ensureConsignmentPayoutLinesForCompletedOrder, backfilled via the admin
// "generate missing payout lines" tool) — and that tool never re-invokes
// reconciliation. Without enrichment, a disposal created before the payout
// line exists would be permanently stuck with netProceedsCents=null: the
// unique sourceKey makes every later createDisposal call for the same
// sourceKey a pure no-op. This computes ONLY the fields that are currently
// null and differ from the incoming value — never touches quantity,
// disposedAt, or allocations — and throws rather than silently overwriting a
// populated value that conflicts with a new one (a historical fact must
// never be silently rewritten).
function computeProceedsEnrichment(
  existing: Pick<ExistingDisposal, 'id' | 'grossProceedsCents' | 'netProceedsCents'>,
  input: Pick<CreateDisposalInput, 'grossProceedsCents' | 'netProceedsCents'>,
): { grossProceedsCents?: number; netProceedsCents?: number } {
  const patch: { grossProceedsCents?: number; netProceedsCents?: number } = {}

  if (input.grossProceedsCents != null) {
    if (existing.grossProceedsCents === null) {
      patch.grossProceedsCents = input.grossProceedsCents
    } else if (existing.grossProceedsCents !== input.grossProceedsCents) {
      throw new Error(
        `PROCEEDS_CONFLICT: disposal ${existing.id} already has grossProceedsCents=${existing.grossProceedsCents}, refusing to silently overwrite with ${input.grossProceedsCents}`,
      )
    }
  }
  if (input.netProceedsCents != null) {
    if (existing.netProceedsCents === null) {
      patch.netProceedsCents = input.netProceedsCents
    } else if (existing.netProceedsCents !== input.netProceedsCents) {
      throw new Error(
        `PROCEEDS_CONFLICT: disposal ${existing.id} already has netProceedsCents=${existing.netProceedsCents}, refusing to silently overwrite with ${input.netProceedsCents}`,
      )
    }
  }
  return patch
}

async function enrichExistingDisposalProceeds(
  tx: Prisma.TransactionClient,
  existing: ExistingDisposal,
  input: CreateDisposalInput,
): Promise<ExistingDisposal> {
  const patch = computeProceedsEnrichment(existing, input) // throws on conflict
  if (patch.grossProceedsCents === undefined && patch.netProceedsCents === undefined) {
    return existing // already fully populated and consistent, or nothing new to add — ordinary no-op retry
  }

  // Conditional claim: only write fields that are STILL null at write time —
  // guards the (rare) case of two reconciliation runs enriching concurrently.
  const claimWhere: Record<string, unknown> = { id: existing.id }
  if (patch.grossProceedsCents !== undefined) claimWhere.grossProceedsCents = null
  if (patch.netProceedsCents !== undefined) claimWhere.netProceedsCents = null

  const claimed = await tx.collectionDisposal.updateMany({ where: claimWhere, data: patch })
  if (claimed.count === 0) {
    // Lost the race — re-read and re-validate against the fresh row rather
    // than assuming our write succeeded or silently dropping the mismatch.
    const fresh = await tx.collectionDisposal.findUniqueOrThrow({ where: { id: existing.id } })
    computeProceedsEnrichment(fresh, input) // throws if genuinely conflicting against the fresh state
    return fresh
  }

  return { ...existing, ...patch }
}

// §29/§30/§31 of the 26B spec: one atomic step — validate, FIFO-select,
// conditionally decrement each allocated lot (never allowing negative
// remaining), create the disposal + its allocations, update the
// CollectionItem.quantity cache. All within the caller's transaction — any
// failure (insufficient quantity, concurrent overdraw) must roll back
// everything, never a partial allocation.
export async function createDisposal(tx: Prisma.TransactionClient, input: CreateDisposalInput): Promise<CreateDisposalResult> {
  assertPositiveInt(input.quantity, 'disposal quantity')
  assertValidCentsOrNull(input.grossProceedsCents, 'grossProceedsCents')
  assertValidCentsOrNull(input.netProceedsCents, 'netProceedsCents')

  if (input.sourceKey) {
    const existing = await tx.collectionDisposal.findUnique({ where: { sourceKey: input.sourceKey } })
    if (existing) {
      const enriched = await enrichExistingDisposalProceeds(tx, existing, input)
      return { status: 'already_exists', disposal: enriched }
    }
  }

  const candidateLots = await tx.acquisitionLot.findMany({
    where: { collectionItemId: input.collectionItemId, remainingQuantity: { gt: 0 } },
  })
  candidateLots.sort(compareLotsForFifo)

  const totalAvailable = candidateLots.reduce((sum, lot) => sum + lot.remainingQuantity, 0)
  if (totalAvailable < input.quantity) {
    return { status: 'insufficient_quantity', available: totalAvailable, requested: input.quantity }
  }

  const allocations: Array<{ lotId: string; quantity: number; allocatedRecordedCostCents: number | null }> = []
  let remaining = input.quantity
  for (const lot of candidateLots) {
    if (remaining <= 0) break
    const take = Math.min(lot.remainingQuantity, remaining)
    allocations.push({
      lotId: lot.id,
      quantity: take,
      allocatedRecordedCostCents: lot.unitRecordedCostCents !== null ? lot.unitRecordedCostCents * take : null,
    })
    remaining -= take
  }

  for (const allocation of allocations) {
    const result = await tx.acquisitionLot.updateMany({
      where: { id: allocation.lotId, remainingQuantity: { gte: allocation.quantity } },
      data: { remainingQuantity: { decrement: allocation.quantity } },
    })
    if (result.count !== 1) {
      throw new Error('CONCURRENT_OVERDRAW: acquisition lot remaining quantity changed concurrently')
    }
  }

  const disposal = await tx.collectionDisposal.create({
    data: {
      collectionItemId: input.collectionItemId,
      quantity: input.quantity,
      disposalType: input.disposalType,
      disposedAt: input.disposedAt,
      grossProceedsCents: input.grossProceedsCents ?? null,
      netProceedsCents: input.netProceedsCents ?? null,
      sourceKey: input.sourceKey ?? null,
      notes: input.notes ?? null,
    },
  })

  await tx.collectionDisposalAllocation.createMany({
    data: allocations.map((a) => ({
      disposalId: disposal.id,
      acquisitionLotId: a.lotId,
      quantity: a.quantity,
      allocatedRecordedCostCents: a.allocatedRecordedCostCents,
    })),
  })

  await tx.collectionItem.update({
    where: { id: input.collectionItemId },
    data: { quantity: { decrement: input.quantity } },
  })

  return { status: 'created', disposal }
}

// ── Reversal ─────────────────────────────────────────────────────────────────

export type ReverseDisposalResult =
  | { status: 'reversed'; disposal: Prisma.CollectionDisposalGetPayload<object> }
  | { status: 'already_reversed'; disposal: Prisma.CollectionDisposalGetPayload<object> }
  | { status: 'not_found' }

// §32/§33: reversal, never deletion. Idempotent via a conditional claim
// (reversedAt: null -> now) — a retried reversal finds zero rows to claim and
// returns 'already_reversed' without restoring quantity a second time.
// Allocation rows remain historical; only lot.remainingQuantity and the
// CollectionItem.quantity cache are restored.
export async function reverseDisposal(
  tx: Prisma.TransactionClient,
  disposalId: string,
  reversalReason: string,
): Promise<ReverseDisposalResult> {
  const claimed = await tx.collectionDisposal.updateMany({
    where: { id: disposalId, reversedAt: null },
    data: { reversedAt: new Date(), reversalReason },
  })

  if (claimed.count !== 1) {
    const existing = await tx.collectionDisposal.findUnique({ where: { id: disposalId } })
    if (!existing) return { status: 'not_found' }
    return { status: 'already_reversed', disposal: existing }
  }

  const allocations = await tx.collectionDisposalAllocation.findMany({ where: { disposalId } })
  for (const allocation of allocations) {
    await tx.acquisitionLot.update({
      where: { id: allocation.acquisitionLotId },
      data: { remainingQuantity: { increment: allocation.quantity } },
    })
  }

  const disposal = await tx.collectionDisposal.findUniqueOrThrow({ where: { id: disposalId } })

  await tx.collectionItem.update({
    where: { id: disposal.collectionItemId },
    data: { quantity: { increment: disposal.quantity } },
  })

  return { status: 'reversed', disposal }
}

// ── Recorded Realized Gain/Loss — pure ──────────────────────────────────────

// 26C §28: a disposal's Recorded Cost — the SUM of its allocations'
// snapshotted allocatedRecordedCostCents — ONLY when every allocated unit has
// a known snapshot cost. Never reconstructed from current (possibly since-
// edited) lot cost; never partial-summed and never treated as $0 when any
// allocation's cost is unknown.
export function computeAllocatedCostCents(
  allocations: Array<{ allocatedRecordedCostCents: number | null }>,
): number | null {
  if (allocations.length === 0 || allocations.some((a) => a.allocatedRecordedCostCents === null)) return null
  return allocations.reduce((sum, a) => sum + (a.allocatedRecordedCostCents ?? 0), 0)
}

export type RealizedGainResult =
  | { status: 'calculable'; recordedRealizedGainLossCents: number; recordedRealizedGainLossPercent: number | null }
  | { status: 'unavailable' }

// §43: eligible only when net proceeds are known AND every allocation's
// snapshotted cost is known — missing cost is never treated as zero. Type-
// level eligibility (platform_sale/external_sale, not reversed) is the
// caller's job; this only judges whether the numbers themselves are complete.
export function computeRealizedGain(
  netProceedsCents: number | null,
  allocations: Array<{ allocatedRecordedCostCents: number | null }>,
): RealizedGainResult {
  if (netProceedsCents === null) return { status: 'unavailable' }
  const totalAllocatedCostCents = computeAllocatedCostCents(allocations)
  if (totalAllocatedCostCents === null) return { status: 'unavailable' }
  const gain = netProceedsCents - totalAllocatedCostCents
  return {
    status: 'calculable',
    recordedRealizedGainLossCents: gain,
    recordedRealizedGainLossPercent: totalAllocatedCostCents > 0 ? gain / totalAllocatedCostCents : null,
  }
}

// ── 27B: read-only FIFO Recorded Cost preview ───────────────────────────────
// Previews which remaining lot(s) a hypothetical disposal of `quantity` would
// consume and at what cost, using the EXACT SAME ordering as createDisposal's
// real allocation (compareLotsForFifo) — never a second, divergent allocation
// rule. Pure/no I/O — never writes, never decrements, never creates a
// CollectionDisposal/Allocation. An older unknown-cost lot still allocates
// first (ownership chronology is never skipped for a prettier cost preview);
// if any allocated unit's cost is unknown, the preview cost stays unavailable
// (status 'partial'/'unknown'), never fabricated as $0.
export type RecordedCostPreviewStatus = 'known' | 'partial' | 'unknown' | 'insufficient_quantity'

export type RecordedCostPreview = {
  quantityRequested: number
  totalAllocatedCopies: number
  knownCostCopies: number
  // Only non-null when status === 'known' (every allocated copy has a known cost).
  recordedCostCents: number | null
  status: RecordedCostPreviewStatus
}

type FifoLotForCostPreview = FifoLot & { remainingQuantity: number; unitRecordedCostCents: number | null }

export function previewFifoAllocation(lots: FifoLotForCostPreview[], quantity: number): RecordedCostPreview {
  const sorted = [...lots].sort(compareLotsForFifo)
  const totalAvailable = sorted.reduce((sum, lot) => sum + lot.remainingQuantity, 0)
  if (totalAvailable < quantity) {
    return { quantityRequested: quantity, totalAllocatedCopies: totalAvailable, knownCostCopies: 0, recordedCostCents: null, status: 'insufficient_quantity' }
  }

  let remaining = quantity
  let knownCostCopies = 0
  let knownCostCents = 0
  let anyUnknown = false
  for (const lot of sorted) {
    if (remaining <= 0) break
    const take = Math.min(lot.remainingQuantity, remaining)
    if (lot.unitRecordedCostCents !== null) {
      knownCostCopies += take
      knownCostCents += lot.unitRecordedCostCents * take
    } else {
      anyUnknown = true
    }
    remaining -= take
  }

  const status: RecordedCostPreviewStatus = knownCostCopies === 0 ? 'unknown' : anyUnknown ? 'partial' : 'known'
  return {
    quantityRequested: quantity,
    totalAllocatedCopies: quantity,
    knownCostCopies,
    recordedCostCents: status === 'known' ? knownCostCents : null,
    status,
  }
}

// DB-boundary wrapper: scoped to the requesting profile (never another
// customer's CollectionItem) — returns null when the item doesn't belong to
// this profile, rather than leaking existence. No transaction needed (no
// writes); a focused query, never getPortfolio's whole-collection load.
export async function previewRecordedCostForSale(
  profileId: string,
  collectionItemId: string,
  quantity: number,
): Promise<RecordedCostPreview | null> {
  const item = await prisma.collectionItem.findFirst({ where: { id: collectionItemId, profileId }, select: { id: true } })
  if (!item) return null

  const lots = await prisma.acquisitionLot.findMany({
    where: { collectionItemId, remainingQuantity: { gt: 0 } },
    select: { id: true, remainingQuantity: true, unitRecordedCostCents: true, acquiredAt: true, ledgerEffectiveAt: true, createdAt: true },
  })

  return previewFifoAllocation(lots, quantity)
}
