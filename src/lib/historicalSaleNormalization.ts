// 21C: pure classification logic for one-time legacy OrderItem normalization.
// Kept separate from scripts/normalizeHistoricalSales.ts (which owns all DB I/O
// — batched reads, cursor pagination, conditional writes) so the evidence rules
// themselves are unit-testable without a live database. The ONLY evidence source
// is the converted IntakeDraft for the sold ItemInstance — never current
// ItemInstance state, never SellerSubmission, never Listing, never timestamps
// used as proof of non-mutation.

import { isValidPackagingType } from './marketVariant'
import { ITEM_CONDITIONS } from './itemMutations'

export const NORMALIZATION_MIGRATION_NAME = '20260912000000_add_market_variant_packaging'

export type LegacyCandidateRow = {
  id: string
  itemId: string
  catalogModelId: string | null
  marketVariantId: string | null
  snapshotPackagingType: string | null
  snapshotCondition: string | null
  price: number
  createdAt: Date
  completedAt: Date | null
}

// The converted IntakeDraft's frozen physical fields — undefined when no
// converted draft is linked to this item at all (e.g. manually created item).
export type DraftEvidence = { cardedOrLoose: string | null; condition: string | null } | undefined

export type MalformedBucket =
  | 'postCutoverMalformed'
  | 'writeConflictExistingPartialState'
  | 'malformedMissingCatalog'
  | 'malformedMissingCompletedAt'
  | 'malformedNonPositivePrice'

export type RecoveryBucket = 'recoveredFull' | 'recoveredPackagingOnly' | 'recoveredConditionOnly' | 'modelOnly'

export type Classification =
  | { bucket: MalformedBucket }
  | {
      bucket: RecoveryBucket
      provenance: 'intake_declared' | 'legacy_model_only'
      marketVariantId: string | null
      snapshotPackagingType: string | null
      snapshotCondition: string | null
      variantResolutionError: boolean
    }

// resolveVariantId is a synchronous lookup against a pre-batch-fetched map — the
// caller is responsible for never querying the DB per row (see the script).
export function classifyLegacyOrderItem(
  row: LegacyCandidateRow,
  cutover: Date,
  draft: DraftEvidence,
  resolveVariantId: (catalogModelId: string, packagingType: string) => string | null,
): Classification {
  // §7/§8: post-cutover rows lacking snapshotProvenance are never auto-repaired
  // — that would hide a broken post-21B write path.
  if (row.createdAt > cutover) return { bucket: 'postCutoverMalformed' }

  // §29: any pre-existing partial physical fact with null provenance is an
  // unexplained state — never assume intake_declared, never overwrite.
  if (row.marketVariantId !== null || row.snapshotPackagingType !== null || row.snapshotCondition !== null) {
    return { bucket: 'writeConflictExistingPartialState' }
  }

  // §16: malformed model-level facts are reported separately, never normalized
  // as legacy_model_only — "unknown physical facts" and "broken sale record"
  // are different states.
  if (!row.catalogModelId) return { bucket: 'malformedMissingCatalog' }
  if (!row.completedAt) return { bucket: 'malformedMissingCompletedAt' }
  if (!(row.price > 0)) return { bucket: 'malformedNonPositivePrice' }

  // ── §9-§14: recovery, IntakeDraft evidence only, field-independent. ────────
  let snapshotPackagingType: string | null = null
  let marketVariantId: string | null = null
  let variantResolutionError = false
  if (draft && isValidPackagingType(draft.cardedOrLoose)) {
    const variantId = resolveVariantId(row.catalogModelId, draft.cardedOrLoose)
    if (variantId) {
      snapshotPackagingType = draft.cardedOrLoose
      marketVariantId = variantId
    } else {
      // §25: 21B's own invariant says every CatalogModel already has both
      // packaging variants — a miss here is unexpected. Never guess, never
      // create one from this script.
      variantResolutionError = true
    }
  }

  let snapshotCondition: string | null = null
  if (draft && (ITEM_CONDITIONS as readonly string[]).includes(draft.condition ?? '')) {
    snapshotCondition = draft.condition
  }

  const recoveredSomething = snapshotPackagingType !== null || snapshotCondition !== null
  const provenance: 'intake_declared' | 'legacy_model_only' = recoveredSomething ? 'intake_declared' : 'legacy_model_only'
  const bucket: RecoveryBucket =
    snapshotPackagingType !== null && snapshotCondition !== null ? 'recoveredFull'
    : snapshotPackagingType !== null ? 'recoveredPackagingOnly'
    : snapshotCondition !== null ? 'recoveredConditionOnly'
    : 'modelOnly'

  return { bucket, provenance, marketVariantId, snapshotPackagingType, snapshotCondition, variantResolutionError }
}
