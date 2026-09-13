// 21D: pure identity normalization for external market comparables. Answers
// "what collectible/variant/condition does this observation describe" — never
// "what price should it contribute" (that stays Series 22). No DB query here —
// callers select exactly the fields below (see EXTERNAL_COMPARABLE_SELECT).
//
// normalizedCondition is always null in 21D: this codebase's external import is
// a generic provider-agnostic CSV pipeline (provider is admin-typed free text,
// no structured packaging column, zero evidenced condition vocabulary in any
// fixture/test) — building a raw→internal condition mapping now would be
// invented, not evidence-based. Reopens only once real vocabulary exists.
import { isValidPackagingType, type PackagingType } from './marketVariant'

export type ExternalComparableInput = {
  id: string
  provider: string
  matchStatus: string
  matchMethod: string | null
  catalogModelId: string | null
  marketVariantId: string | null
  marketVariant: { id: string; catalogModelId: string; packagingType: string } | null
}

// Reusable Prisma select shape — identity fields only, never rawSnapshot/title/
// price/date columns merely to normalize identity.
export const EXTERNAL_COMPARABLE_SELECT = {
  id: true,
  provider: true,
  matchStatus: true,
  matchMethod: true,
  catalogModelId: true,
  marketVariantId: true,
  marketVariant: { select: { id: true, catalogModelId: true, packagingType: true } },
} as const

export type NormalizedExternalComparable = {
  externalObservationId: string
  provider: string
  catalogModelId: string
  marketVariantId: string | null
  packagingType: PackagingType | null
  normalizedCondition: null
  matchMethod: string | null
}

// §6: only a matched, model-identified observation is a usable comparable.
// Workflow-state internals (unmatched/rejected, any stale FK they may retain)
// never leak past this boundary — matchStatus is the sole eligibility gate.
export function normalizeExternalComparableIdentity(
  observation: ExternalComparableInput,
): NormalizedExternalComparable | null {
  if (observation.matchStatus !== 'matched') return null
  if (!observation.catalogModelId) return null

  let marketVariantId: string | null = null
  let packagingType: PackagingType | null = null

  if (observation.marketVariantId !== null) {
    const mv = observation.marketVariant
    // §9: a classified variant must be internally consistent — joined row
    // present, ids match, belongs to the SAME model, valid packaging type.
    // Any inconsistency fails closed (null), never silently degrades to
    // model-only identity for a structurally broken row.
    if (
      !mv ||
      mv.id !== observation.marketVariantId ||
      mv.catalogModelId !== observation.catalogModelId ||
      !isValidPackagingType(mv.packagingType)
    ) {
      return null
    }
    marketVariantId = mv.id
    packagingType = mv.packagingType
  }

  return {
    externalObservationId: observation.id,
    provider: observation.provider,
    catalogModelId: observation.catalogModelId,
    marketVariantId,
    packagingType,
    normalizedCondition: null,
    matchMethod: observation.matchMethod,
  }
}

// §15/§16-19: null never establishes equality — these helpers make that
// explicit rather than leaving callers to write `a === b` (which is true, and
// wrong, for `null === null`).
export function isExternalVariantComparable(identity: NormalizedExternalComparable): boolean {
  return identity.marketVariantId !== null && identity.packagingType !== null
}

export function isExternalConditionComparable(identity: NormalizedExternalComparable): boolean {
  return identity.normalizedCondition !== null
}

export function sameModelBucket(a: NormalizedExternalComparable, b: NormalizedExternalComparable): boolean {
  return a.catalogModelId === b.catalogModelId
}

export function sameVariantBucket(a: NormalizedExternalComparable, b: NormalizedExternalComparable): boolean {
  return a.marketVariantId !== null && b.marketVariantId !== null && a.marketVariantId === b.marketVariantId
}

export function sameConditionBucket(a: NormalizedExternalComparable, b: NormalizedExternalComparable): boolean {
  return a.normalizedCondition !== null && b.normalizedCondition !== null && a.normalizedCondition === b.normalizedCondition
}
