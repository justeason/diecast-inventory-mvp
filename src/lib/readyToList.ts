// 15J: the ONE authoritative, deterministic Ready-to-List policy engine. Pure — no
// DB access (see readyToListQuery.ts for that boundary), no randomness, no LLM, no
// external API. Same context always produces the same outcome.
//
// This answers exactly one question: "is this physical item operationally eligible
// to enter the listing workflow?" It does NOT create a Listing, choose a price,
// approve risk, bypass 15F, resolve intake exceptions, or alter commercial terms —
// see readyToListQuery.ts's structural safety tests for the enforced invariant that
// nothing in this module ever mutates.
//
// ── Inspection findings (Part A) — reason codes considered and DELIBERATELY
// OMITTED, not overlooked: ──────────────────────────────────────────────────────
//   catalog_missing   — ItemInstance.catalogId is a NOT NULL FK (schema-enforced);
//                        no existing row can ever lack a catalog. Structurally
//                        impossible, so this is never checked (matches the same
//                        "don't invent impossible data" principle 15E already
//                        applies to open-exception-on-a-converted-item).
//   condition_missing — ItemInstance.condition / cardedOrLoose are NOT NULL columns,
//                        and both ItemInstance creation paths (admin form via
//                        items.ts, intake conversion via intakeConversion.ts) run the
//                        same required Zod/classification validation before writing
//                        either field. Also structurally impossible in practice.
//   intake_exception_open — 15E's openIntakeExceptionWhere() requires
//                        convertedItemId: null; an ItemInstance only exists once its
//                        originating draft's convertedItemId IS set, which makes
//                        that draft's own exception state permanently closed to the
//                        "open" predicate. An existing ItemInstance's own draft can
//                        never still be an open exception.
//   shipment_lineage_problem / ownership_unresolved — no concrete domain rule
//                        requires shipment lineage or found no additional ownership
//                        concept beyond sourceType/agreement/portfolio (already
//                        covered below); shipmentLineageAmbiguous (15C) is a display
//                        nuance for legacy pre-15D items, not a listing eligibility
//                        rule, so it is not a blocker here.

import type { ItemContradiction } from '@/lib/itemLifecycle'
import type { Confidence } from '@/lib/resaleEstimator'

// 15J's own reason codes — every one gets a message from REASON_MESSAGES below.
export type ReadyToListOwnReasonCode =
  | 'item_not_available'
  | 'completed_sale_exists'
  | 'already_listed'
  | 'storage_missing'
  | 'agreement_missing'
  | 'agreement_not_accepted'
  | 'return_case_open'

// 15C's ItemContradiction.code is typed as a plain `string` (open-ended — new
// contradiction checks can be added to itemLifecycle.ts without a matching union
// edit here). These seven are the exact codes detectItemContradictions currently
// emits; listed explicitly (not derived from ItemContradiction['code'], which would
// collapse this whole union back down to `string`) so BLOCKER_ORDER stays type-safe.
export type ReadyToListContradictionReasonCode =
  | 'available_but_sold_evidence'
  | 'sold_but_listing_active'
  | 'active_listing_status_mismatch'
  | 'consignment_sold_missing_payout'
  | 'missing_storage_location'
  | 'portfolio_agreement_mismatch'
  | 'multiple_completed_sales'

export type ReadyToListReasonCode = ReadyToListOwnReasonCode | ReadyToListContradictionReasonCode

export type ReadyToListReviewCode = 'pricing_evidence_missing' | 'pricing_confidence_low'

export type ReadyToListBlocker = { code: ReadyToListReasonCode; message: string }
export type ReadyToListReview = { code: ReadyToListReviewCode; message: string }

export type PricingReadinessSummary = {
  status: 'supported' | 'low_confidence' | 'no_evidence' | 'not_evaluated'
  estimatedValueCents: number | null
  confidenceLevel: Confidence | null
  isAskOnly: boolean
}

export type ReadyToListOutcome = {
  status: 'ready' | 'blocked' | 'review_required'
  blockers: ReadyToListBlocker[]
  reviewReasons: ReadyToListReview[]
  // Which listing action would apply once/if ready — Listing.itemId is @unique, so
  // an item with an archived Listing row is reactivated (updateListing), never a
  // second Listing row created (createListing already refuses if any row exists).
  listingPath: 'create' | 'reactivate'
  pricing: PricingReadinessSummary
}

export type ReadyToListContext = {
  itemStatus: string // ItemInstance.status — authoritative, never a UI label
  locationId: string | null
  sourceType: string | null // 'consignment' | 'buyout' | 'company_owned' | null
  sellerAgreementId: string | null
  agreementStatus: string | null // null only when sellerAgreementId is also null
  listingStatus: string | null // null = no Listing row at all; else 'active'|'sold'|'archived'
  // Bounded COUNT, not a loaded list (mirrors detectItemContradictions' own
  // completedOrderCount input) — a physical item should only ever complete one sale.
  completedOrderCount: number
  hasOpenReturnCase: boolean
  // Reused verbatim from 15C's detectItemContradictions — never re-derived here.
  contradictions: ItemContradiction[]
  // null = pricing intelligence not evaluated for this context (e.g. bulk list
  // scan that intentionally skips 14C — see Part Q) — reported as 'not_evaluated',
  // never fabricated as 'no_evidence'.
  pricing: { estimatedValueCents: number | null; confidenceLevel: Confidence; isAskOnly: boolean } | null
}

// Messages only for 15J's OWN reason codes — contradiction-derived blockers use the
// ItemContradiction's own `.message` directly (single source of truth, never a
// second copy that could drift out of sync with itemLifecycle.ts).
const REASON_MESSAGES: Record<ReadyToListOwnReasonCode, string | ((ctx: ReadyToListContext) => string)> = {
  item_not_available: (ctx) => `Item status is "${ctx.itemStatus}", not "available".`,
  completed_sale_exists: 'This item already has a completed sale.',
  already_listed: 'This item already has an active or sold listing.',
  storage_missing: 'No storage location is assigned.',
  agreement_missing: 'This consignment item has no linked seller agreement.',
  agreement_not_accepted: 'The linked seller agreement has not been accepted.',
  return_case_open: 'This item has an open return-pending case.',
}

// Fixed evaluation/display order — deterministic regardless of which checks fire.
// Contradictions first (strongest evidence, section 35), then 15J's own checks.
// Any future contradiction code not listed here still displays (see sortBlockers'
// stable fallback) — it just isn't guaranteed a specific position relative to codes
// added after this file was last updated.
const BLOCKER_ORDER: ReadyToListReasonCode[] = [
  'available_but_sold_evidence',
  'sold_but_listing_active',
  'active_listing_status_mismatch',
  'consignment_sold_missing_payout',
  'missing_storage_location',
  'portfolio_agreement_mismatch',
  'multiple_completed_sales',
  'item_not_available',
  'completed_sale_exists',
  'already_listed',
  'storage_missing',
  'agreement_missing',
  'agreement_not_accepted',
  'return_case_open',
]

function sortBlockers(blockers: ReadyToListBlocker[]): ReadyToListBlocker[] {
  return [...blockers].sort((a, b) => {
    const ai = BLOCKER_ORDER.indexOf(a.code)
    const bi = BLOCKER_ORDER.indexOf(b.code)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.code.localeCompare(b.code) // stable fallback for an unrecognized future code
  })
}

function reasonMessage(code: ReadyToListOwnReasonCode, ctx: ReadyToListContext): string {
  const m = REASON_MESSAGES[code]
  return typeof m === 'function' ? m(ctx) : m
}

function pricingSummary(pricing: ReadyToListContext['pricing']): PricingReadinessSummary {
  if (!pricing) return { status: 'not_evaluated', estimatedValueCents: null, confidenceLevel: null, isAskOnly: false }
  const status: PricingReadinessSummary['status'] =
    pricing.confidenceLevel === 'insufficient' ? 'no_evidence'
      : pricing.confidenceLevel === 'low' ? 'low_confidence'
      : 'supported'
  return { status, estimatedValueCents: pricing.estimatedValueCents, confidenceLevel: pricing.confidenceLevel, isAskOnly: pricing.isAskOnly }
}

export function evaluateReadyToList(ctx: ReadyToListContext): ReadyToListOutcome {
  const blockers: ReadyToListBlocker[] = []

  // Section 35: contradictions are STRONGER evidence than any single status field —
  // always evaluated, unconditionally, never suppressed by other checks. Message
  // comes straight from the contradiction itself (single source of truth).
  for (const c of ctx.contradictions) {
    blockers.push({ code: c.code as ReadyToListReasonCode, message: c.message })
  }

  // Section 6/35: a completed sale is a hard blocker regardless of what itemStatus
  // currently claims — defensive, independent of the itemStatus check below.
  if (ctx.completedOrderCount > 0) {
    blockers.push({ code: 'completed_sale_exists', message: reasonMessage('completed_sale_exists', ctx) })
  }

  if (ctx.itemStatus !== 'available') {
    blockers.push({ code: 'item_not_available', message: reasonMessage('item_not_available', ctx) })
  } else {
    // The following only mean anything once the item is at least nominally
    // 'available' — evaluating them for a sold/reserved item would just be noise
    // restating facts that don't apply to that lifecycle state (15C already scopes
    // its own storage-location contradiction check the same way).
    if (ctx.listingStatus !== null && ctx.listingStatus !== 'archived') {
      blockers.push({ code: 'already_listed', message: reasonMessage('already_listed', ctx) })
    }
    if (!ctx.locationId) {
      blockers.push({ code: 'storage_missing', message: reasonMessage('storage_missing', ctx) })
    }
    if (ctx.sourceType === 'consignment') {
      if (!ctx.sellerAgreementId) blockers.push({ code: 'agreement_missing', message: reasonMessage('agreement_missing', ctx) })
      else if (ctx.agreementStatus !== 'accepted') blockers.push({ code: 'agreement_not_accepted', message: reasonMessage('agreement_not_accepted', ctx) })
    }
    if (ctx.hasOpenReturnCase) {
      blockers.push({ code: 'return_case_open', message: reasonMessage('return_case_open', ctx) })
    }
  }

  const sortedBlockers = sortBlockers(blockers)
  const listingPath: ReadyToListOutcome['listingPath'] = ctx.listingStatus === 'archived' ? 'reactivate' : 'create'
  const pricing = pricingSummary(ctx.pricing)

  if (sortedBlockers.length > 0) {
    return { status: 'blocked', blockers: sortedBlockers, reviewReasons: [], listingPath, pricing }
  }

  const reviewReasons: ReadyToListReview[] = []
  if (pricing.status === 'no_evidence') reviewReasons.push({ code: 'pricing_evidence_missing', message: 'No pricing evidence is available for this catalog model.' })
  else if (pricing.status === 'low_confidence') reviewReasons.push({ code: 'pricing_confidence_low', message: 'Pricing evidence exists but confidence is low.' })

  if (reviewReasons.length > 0) {
    return { status: 'review_required', blockers: [], reviewReasons, listingPath, pricing }
  }

  return { status: 'ready', blockers: [], reviewReasons: [], listingPath, pricing }
}
