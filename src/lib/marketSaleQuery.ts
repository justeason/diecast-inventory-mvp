// 22B: canonical read-time market-EVIDENCE query layer (Series 22A architecture:
// no MarketObservation table — Order/OrderItem/ExternalMarketObservation remain
// sole source of truth, normalized at read time). Hides from every later
// consumer: Order workflow/payment vocabulary, legacy OrderItem quirks,
// ExternalMarketObservation lifecycle, raw external condition, rawSnapshot,
// shipping-field differences, and Float-vs-Decimal storage differences.
//
// Return/refund limitation (22A §7/§80): this schema cannot represent a refund
// on Order (no Refund model, no 'refunded' status), and the seller return
// workflow (SellerLifecycleCase) never changes Order.status. 22B therefore uses
// the STRONGEST currently representable predicate — status='complete' AND
// paymentStatus='paid' — and does not attempt to infer invalidation from
// SellerLifecycleCase/ItemInstance.status/Listing.status, which would create
// incomplete hidden policy. A seller-return case that never flips Order.status
// remains, today, indistinguishable from a still-valid sale to this layer.
//
// NO valuation: no confidence, no outlier removal, no weighted estimate, no
// fallback broadening. History returns exactly the eligible raw evidence for
// the requested identity scope — nothing more.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { isValidPackagingType, type PackagingType } from '@/lib/marketVariant'
import {
  normalizeInternalSale,
  isValidSnapshotProvenance,
  SNAPSHOT_PROVENANCE,
  type NormalizedInternalSaleInput,
  type SnapshotProvenance,
} from '@/lib/normalizedInternalSale'
import {
  normalizeExternalComparableIdentity,
  EXTERNAL_COMPARABLE_SELECT,
  type ExternalComparableInput,
} from '@/lib/normalizedExternalComparable'
import { internalPriceToCents, externalPriceToCents } from '@/lib/marketMoney'

export const DEFAULT_HISTORY_LIMIT = 100
export const MAX_HISTORY_LIMIT = 500

export type MarketSourceType = 'internal' | 'external'

export type InternalMarketSale = {
  observationId: string
  sourceType: 'internal'
  sourceRecordId: string
  catalogModelId: string
  marketVariantId: string | null
  packagingType: PackagingType | null
  condition: string | null
  snapshotProvenance: SnapshotProvenance
  priceCents: number
  currency: 'USD'
  soldAt: Date
}

export type ExternalMarketSale = {
  observationId: string
  sourceType: 'external'
  sourceRecordId: string
  provider: string
  matchMethod: string | null
  catalogModelId: string
  marketVariantId: string | null
  packagingType: PackagingType | null
  condition: null
  priceCents: number
  currency: 'USD'
  soldAt: Date
}

export type MarketSaleObservation = InternalMarketSale | ExternalMarketSale

// ── Pure row -> normalized-observation mappers (no DB access) ────────────────

export type InternalSaleCandidateRow = NormalizedInternalSaleInput & {
  order: NormalizedInternalSaleInput['order'] & { paymentStatus: string }
}

// §2/§35: canonical eligibility strengthens 21C's generic historical predicate
// with paymentStatus='paid' — never done inside normalizeInternalSale itself
// (kept a generic historical normalizer, not a payment-workflow module).
// Reuses normalizeInternalSale for the identity/provenance mapping it already
// owns; never re-derives that logic here.
export function toInternalMarketSale(row: InternalSaleCandidateRow): InternalMarketSale | null {
  if (row.order.paymentStatus !== 'paid') return null
  const normalized = normalizeInternalSale(row)
  if (!normalized) return null

  return {
    observationId: `internal:${normalized.orderItemId}`,
    sourceType: 'internal',
    sourceRecordId: normalized.orderItemId,
    catalogModelId: normalized.catalogModelId,
    marketVariantId: normalized.marketVariantId,
    packagingType: isValidPackagingType(normalized.packagingType) ? normalized.packagingType : null,
    condition: normalized.condition,
    snapshotProvenance: normalized.snapshotProvenance,
    priceCents: internalPriceToCents(normalized.price),
    currency: 'USD',
    soldAt: normalized.soldAt,
  }
}

export type ExternalSaleCandidateRow = ExternalComparableInput & {
  observationType: string
  soldAt: Date | null
  currency: string
  price: Prisma.Decimal
}

// §9/§34: 21D's normalizer is the sole identity-correctness boundary — the DB
// WHERE clause may prefilter for performance, but every emitted row still
// passes through here. price is used (never totalPrice) — 22A proved
// totalPrice may be an explicit admin-supplied import value not guaranteed to
// equal price + shippingPrice, so it can never be trusted as validated
// per-item execution price.
export function toExternalMarketSale(row: ExternalSaleCandidateRow): ExternalMarketSale | null {
  const identity = normalizeExternalComparableIdentity(row)
  if (!identity) return null
  if (row.observationType !== 'sold') return null
  if (!row.soldAt) return null
  if (row.currency !== 'USD') return null
  if (!row.price.gt(0)) return null

  return {
    observationId: `external:${identity.externalObservationId}`,
    sourceType: 'external',
    sourceRecordId: identity.externalObservationId,
    provider: identity.provider,
    matchMethod: identity.matchMethod,
    catalogModelId: identity.catalogModelId,
    marketVariantId: identity.marketVariantId,
    packagingType: identity.packagingType,
    condition: null,
    priceCents: externalPriceToCents(row.price),
    currency: 'USD',
    soldAt: row.soldAt,
  }
}

// ── Canonical sort — soldAt DESC, then a deterministic global tie-break.
// sourceType compares as a plain ascending string ('external' < 'internal'),
// then sourceRecordId ascending. Never relies on incidental query/array order. ──
export function compareMarketSaleObservations(a: MarketSaleObservation, b: MarketSaleObservation): number {
  const t = b.soldAt.getTime() - a.soldAt.getTime()
  if (t !== 0) return t
  if (a.sourceType !== b.sourceType) return a.sourceType < b.sourceType ? -1 : 1
  return a.sourceRecordId.localeCompare(b.sourceRecordId)
}

function isNotNull<T>(v: T | null): v is T {
  return v !== null
}

// ── Filters ────────────────────────────────────────────────────────────────

type BaseFilter = {
  catalogModelId: string
  marketVariantId?: string
  condition?: string
  startDate?: Date // inclusive
  endDate?: Date // exclusive
  sources?: MarketSourceType[]
  // Admin/debug-only filters — never surfaced in public UI (22A §90/§91).
  internalProvenance?: SnapshotProvenance[]
  provider?: string
}

export type MarketSaleHistoryFilter = BaseFilter & { limit?: number }
export type LatestSaleFilter = BaseFilter
export type SaleCountFilter = BaseFilter

function activeSources(filter: BaseFilter): { internal: boolean; external: boolean } {
  const sources = filter.sources ?? ['internal', 'external']
  return {
    internal: sources.includes('internal'),
    // §17/§21: a condition filter can never be satisfied externally — normalizedCondition
    // is always null in 22B — so the external branch is skipped, not merely filtered to zero.
    external: sources.includes('external') && filter.condition === undefined,
  }
}

const INTERNAL_SALE_SELECT = {
  id: true,
  price: true,
  catalogModelId: true,
  marketVariantId: true,
  snapshotPackagingType: true,
  snapshotCondition: true,
  snapshotProvenance: true,
  order: { select: { status: true, paymentStatus: true, completedAt: true } },
} as const

// Semantic-consistency fix: snapshotProvenance is ALWAYS constrained to the
// valid closed set (SNAPSHOT_PROVENANCE), narrowed further by an explicit
// internalProvenance filter when supplied. Without this, a row with
// snapshotProvenance=null/garbage (not yet normalized by 21C's backfill,
// or otherwise malformed) would satisfy every other WHERE clause and be
// counted by getSaleCount, yet normalizeInternalSale rejects it outright in
// getMarketSaleHistory — this single line is what keeps DB count() exactly
// equal to "rows normalizeInternalSale would accept" with no drift risk,
// since both read from the same SNAPSHOT_PROVENANCE constant.
function buildInternalWhere(filter: BaseFilter): Prisma.OrderItemWhereInput {
  return {
    catalogModelId: filter.catalogModelId,
    ...(filter.marketVariantId !== undefined ? { marketVariantId: filter.marketVariantId } : {}),
    ...(filter.condition !== undefined ? { snapshotCondition: filter.condition } : {}),
    snapshotProvenance: { in: [...(filter.internalProvenance ?? SNAPSHOT_PROVENANCE)] },
    price: { gt: 0 },
    order: {
      status: 'complete',
      paymentStatus: 'paid',
      completedAt: {
        not: null,
        ...(filter.startDate !== undefined ? { gte: filter.startDate } : {}),
        ...(filter.endDate !== undefined ? { lt: filter.endDate } : {}),
      },
    },
  }
}

const EXTERNAL_SALE_SELECT = {
  ...EXTERNAL_COMPARABLE_SELECT,
  observationType: true,
  soldAt: true,
  currency: true,
  price: true,
} as const

function buildExternalWhere(filter: BaseFilter): Prisma.ExternalMarketObservationWhereInput {
  return {
    catalogModelId: filter.catalogModelId,
    matchStatus: 'matched',
    observationType: 'sold',
    currency: 'USD',
    price: { gt: 0 },
    ...(filter.marketVariantId !== undefined ? { marketVariantId: filter.marketVariantId } : {}),
    ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
    soldAt: {
      not: null,
      ...(filter.startDate !== undefined ? { gte: filter.startDate } : {}),
      ...(filter.endDate !== undefined ? { lt: filter.endDate } : {}),
    },
  }
}

// ── getMarketSaleHistory ───────────────────────────────────────────────────
// §22: no fallback — returns exactly the observations belonging to the
// requested identity scope. §30/§31: bounded (hard max), no cursor — fetching
// `take + 1` from EACH source (sorted desc) is provably sufficient to compute
// the true top-`take` of the two-source union (a single source can contribute
// at most `take` items to any top-`take` union slice), avoiding a two-source
// cursor while staying correct if a future page is ever added.
export async function getMarketSaleHistory(
  filter: MarketSaleHistoryFilter,
): Promise<{ observations: MarketSaleObservation[]; hasMore: boolean }> {
  const take = Math.min(filter.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
  const { internal, external } = activeSources(filter)

  const [internalRows, externalRows] = await Promise.all([
    internal
      ? prisma.orderItem.findMany({
          where: buildInternalWhere(filter),
          select: INTERNAL_SALE_SELECT,
          orderBy: [{ order: { completedAt: 'desc' } }, { id: 'asc' }],
          take: take + 1,
        })
      : Promise.resolve([]),
    external
      ? prisma.externalMarketObservation.findMany({
          where: buildExternalWhere(filter),
          select: EXTERNAL_SALE_SELECT,
          orderBy: [{ soldAt: 'desc' }, { id: 'asc' }],
          take: take + 1,
        })
      : Promise.resolve([]),
  ])

  const observations = [
    ...internalRows.map(toInternalMarketSale).filter(isNotNull),
    ...externalRows.map(toExternalMarketSale).filter(isNotNull),
  ].sort(compareMarketSaleObservations)

  // hasMore: "more eligible observations exist beyond this bounded result."
  // Correct as long as every raw row the WHERE matches also passes its pure
  // normalizer (true today: internal's WHERE now mirrors normalizeInternalSale
  // exactly, and external malformed-identity rows are structurally prevented
  // by the marketVariant FK's onDelete:SetNull — see toExternalMarketSale).
  // If a future write path ever made malformed rows reachable, a normalizer-
  // rejected row inside the fetched take+1 window could make this under-report;
  // that would need a wider per-source scan, not a bigger take+1 window.
  return {
    observations: observations.slice(0, take),
    hasMore: observations.length > take,
  }
}

// ── getLatestSale ────────────────────────────────────────────────────────────
// §26/§27: delegates entirely to canonical history logic (limit 1) — no
// bespoke second definition. `sources:['internal']` gives "Latest CollectNTrades
// Sale" without a separate implementation.
export async function getLatestSale(filter: LatestSaleFilter): Promise<MarketSaleObservation | null> {
  const { observations } = await getMarketSaleHistory({ ...filter, limit: 1 })
  return observations[0] ?? null
}

// ── getSaleCount ─────────────────────────────────────────────────────────────
// Semantic-consistency requirement: getSaleCount(...).total must equal the
// number of source records eligible to appear in getMarketSaleHistory(...)
// before limit/bounding — i.e. every row DB count() counts must be a row the
// pure normalizer would also accept.
//
// Internal: after the buildInternalWhere fix above, a plain DB count() is
// exactly equivalent to "rows normalizeInternalSale/toInternalMarketSale would
// accept" — every check that function performs is now mirrored in the WHERE,
// so counting rows (not fetching them) is correct and cheap.
//
// External: normalizeExternalComparableIdentity additionally fails closed on
// a classified variant whose joined MarketVariant is missing, id-mismatched,
// belongs to a different CatalogModel, or has an invalid packagingType — a
// relational consistency check a flat DB count() cannot safely replicate
// without a parallel, driftable re-implementation of 21D's own logic. Instead
// this fetches only the minimal identity+economics fields (the same select as
// history) in bounded batches via keyset pagination, and counts by re-running
// the SAME toExternalMarketSale used by getMarketSaleHistory — so the two can
// never independently drift. No N+1: one query per COUNT_BATCH_SIZE rows,
// never one query per observation.
const COUNT_BATCH_SIZE = 500

async function countExternalEligible(filter: BaseFilter): Promise<number> {
  const where = buildExternalWhere(filter)
  let count = 0
  let cursorId: string | undefined

  for (;;) {
    const batch = await prisma.externalMarketObservation.findMany({
      where,
      select: EXTERNAL_SALE_SELECT,
      orderBy: { id: 'asc' },
      take: COUNT_BATCH_SIZE,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })

    for (const row of batch) {
      if (toExternalMarketSale(row)) count++
    }

    if (batch.length < COUNT_BATCH_SIZE) break
    cursorId = batch[batch.length - 1].id
  }

  return count
}

export type SaleCountResult = { total: number; internal: number; external: number }

export async function getSaleCount(filter: SaleCountFilter): Promise<SaleCountResult> {
  const { internal, external } = activeSources(filter)

  const [internalCount, externalCount] = await Promise.all([
    internal ? prisma.orderItem.count({ where: buildInternalWhere(filter) }) : Promise.resolve(0),
    external ? countExternalEligible(filter) : Promise.resolve(0),
  ])

  return { total: internalCount + externalCount, internal: internalCount, external: externalCount }
}

// Re-exported so callers never need to import 21C's provenance guard directly
// just to validate a debug/admin-supplied provenance filter value.
export { isValidSnapshotProvenance }
export type { SnapshotProvenance }
