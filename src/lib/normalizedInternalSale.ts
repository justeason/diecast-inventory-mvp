// 21C: query-layer normalization for Series 22 consumption. Reads ONLY
// OrderItem's own snapshot/identity fields + Order.completedAt — never
// dereferences current (mutable) ItemInstance physical facts. See
// scripts/normalizeHistoricalSales.ts for how legacy rows get these fields
// populated in the first place; this module only interprets what's already
// on the row.

export const SNAPSHOT_PROVENANCE = ['sale_time', 'intake_declared', 'legacy_model_only'] as const
export type SnapshotProvenance = (typeof SNAPSHOT_PROVENANCE)[number]

export function isValidSnapshotProvenance(value: string | null | undefined): value is SnapshotProvenance {
  return value === 'sale_time' || value === 'intake_declared' || value === 'legacy_model_only'
}

// The minimal shape this module needs — callers select exactly these fields,
// never a broader ItemInstance include.
export type NormalizedInternalSaleInput = {
  id: string
  catalogModelId: string | null
  marketVariantId: string | null
  snapshotPackagingType: string | null
  snapshotCondition: string | null
  snapshotProvenance: string | null
  price: number
  order: { status: string; completedAt: Date | null }
}

export type NormalizedInternalSale = {
  orderItemId: string
  catalogModelId: string
  marketVariantId: string | null
  packagingType: string | null
  condition: string | null
  snapshotProvenance: SnapshotProvenance
  price: number
  soldAt: Date
}

// §35: a sale is eligible for CatalogModel-level history when order is
// complete, completedAt/catalogModelId are known, and price is positive —
// regardless of whether variant/condition are known. Malformed rows (missing
// any of these) are rejected here, never emitted with fabricated defaults.
export function normalizeInternalSale(orderItem: NormalizedInternalSaleInput): NormalizedInternalSale | null {
  if (orderItem.order.status !== 'complete') return null
  if (!orderItem.order.completedAt) return null
  if (!orderItem.catalogModelId) return null
  if (!(orderItem.price > 0)) return null
  if (!isValidSnapshotProvenance(orderItem.snapshotProvenance)) return null

  return {
    orderItemId: orderItem.id,
    catalogModelId: orderItem.catalogModelId,
    marketVariantId: orderItem.marketVariantId,
    packagingType: orderItem.snapshotPackagingType,
    condition: orderItem.snapshotCondition,
    snapshotProvenance: orderItem.snapshotProvenance,
    price: orderItem.price,
    soldAt: orderItem.order.completedAt,
  }
}

// §36: variant-specific history requires BOTH marketVariantId and
// snapshotPackagingType — never inferred from current ItemInstance. Both
// sale_time and intake_declared rows may satisfy this; provenance stays
// exposed on the result so Series 22 can filter/weight by it if desired.
export function isEligibleForVariantHistory(sale: NormalizedInternalSale): boolean {
  return sale.marketVariantId !== null && sale.packagingType !== null
}

// §37: condition-specific history requires snapshotCondition alone.
export function isEligibleForConditionHistory(sale: NormalizedInternalSale): boolean {
  return sale.condition !== null
}
