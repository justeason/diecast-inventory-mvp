// Pure server-safe helper for seller payout calculations.
// Uses Prisma.Decimal for all authoritative financial arithmetic.
// No DB calls — safe to import in server actions and tests.

import { Prisma } from '@prisma/client'

// ─── Source keys ─────────────────────────────────────────────────────────────
// Deterministic unique keys prevent duplicate payout lines.

export function buildBuyoutSourceKey(agreementId: string): string {
  return `buyout:${agreementId}`
}

export function buildConsignmentSourceKey(orderItemId: string): string {
  return `consignment:${orderItemId}`
}

// ─── Consignment payout snapshot ─────────────────────────────────────────────

export type ConsignmentPayoutInput = {
  grossSalePriceFloat: number
  commissionPercent: Prisma.Decimal | null
  fixedFee: Prisma.Decimal | null
  minimumSellerPayout: Prisma.Decimal | null
}

export type ConsignmentPayoutSnapshot = {
  grossSalePrice: Prisma.Decimal
  commissionPercent: Prisma.Decimal | null
  commissionAmount: Prisma.Decimal
  fixedFee: Prisma.Decimal | null
  minimumSellerPayout: Prisma.Decimal | null
  minimumAdjustment: Prisma.Decimal
  netAmount: Prisma.Decimal
}

export function calculateConsignmentPayoutSnapshot(
  input: ConsignmentPayoutInput,
): ConsignmentPayoutSnapshot {
  const ZERO = new Prisma.Decimal(0)
  const DP = 2
  const ROUND = Prisma.Decimal.ROUND_HALF_UP

  // Convert Float price intentionally through two-decimal string to avoid
  // Float representation errors (e.g. 9.99 → "9.99" → exact Decimal).
  const grossSalePrice = new Prisma.Decimal(input.grossSalePriceFloat.toFixed(2))

  const commissionPercent = input.commissionPercent ?? null
  const commissionAmount = commissionPercent
    ? grossSalePrice.mul(commissionPercent).toDecimalPlaces(DP, ROUND)
    : new Prisma.Decimal(ZERO)

  const fixedFee = input.fixedFee ?? null

  const baseSellerAmount = grossSalePrice
    .minus(commissionAmount)
    .minus(fixedFee ?? ZERO)

  const nonNegativeBase = Prisma.Decimal.max(baseSellerAmount, ZERO).toDecimalPlaces(DP, ROUND)

  const minimumSellerPayout = input.minimumSellerPayout ?? null

  let minimumAdjustment = new Prisma.Decimal(ZERO)
  if (minimumSellerPayout && minimumSellerPayout.greaterThan(ZERO)) {
    const gap = minimumSellerPayout.minus(nonNegativeBase)
    if (gap.greaterThan(ZERO)) {
      minimumAdjustment = gap.toDecimalPlaces(DP, ROUND)
    }
  }

  const netAmount = nonNegativeBase.plus(minimumAdjustment).toDecimalPlaces(DP, ROUND)

  return {
    grossSalePrice,
    commissionPercent,
    commissionAmount,
    fixedFee,
    minimumSellerPayout,
    minimumAdjustment,
    netAmount,
  }
}

// ─── Buyout payout snapshot ───────────────────────────────────────────────────

export type BuyoutPayoutSnapshot = {
  agreedBuyoutAmount: Prisma.Decimal
  netAmount: Prisma.Decimal
}

export function calculateBuyoutPayoutSnapshot(
  agreedBuyoutAmount: Prisma.Decimal,
): BuyoutPayoutSnapshot {
  return { agreedBuyoutAmount, netAmount: agreedBuyoutAmount }
}

// ─── Eligibility gate helpers ─────────────────────────────────────────────────

export function shouldCreateBuyoutPayoutLine(sourceType: string | null): boolean {
  return sourceType === 'buyout'
}

export function isOrderStatusEligibleForConsignmentPayout(orderStatus: string): boolean {
  return orderStatus === 'complete'
}

export function isItemEligibleForConsignmentPayout(params: {
  sourceType: string | null
  agreementType: string | null
  agreementStatus: string | null
}): boolean {
  return (
    params.sourceType === 'consignment' &&
    params.agreementType === 'consignment' &&
    params.agreementStatus === 'accepted'
  )
}

// ─── Line state machine ───────────────────────────────────────────────────────

export function isLineHoldable(line: { status: string; payoutId: string | null }): boolean {
  return line.status === 'eligible' && line.payoutId === null
}

export function isLineReleasable(line: { status: string; payoutId: string | null }): boolean {
  return line.status === 'held' && line.payoutId === null
}

export function isLineVoidable(line: { status: string; payoutId: string | null }): boolean {
  return (line.status === 'eligible' || line.status === 'held') && line.payoutId === null
}

export function isLineBatchable(line: { status: string; payoutId: string | null }): boolean {
  return line.status === 'eligible' && line.payoutId === null
}

// ─── Display status derivation ────────────────────────────────────────────────

export function derivePayoutLineDisplayStatus(
  lineStatus: string,
  payout: { status: string } | null,
): string {
  if (lineStatus === 'held') return 'Held'
  if (lineStatus === 'voided') return 'Voided'
  if (!payout) return 'Eligible'
  if (payout.status === 'draft') return 'Payout being prepared'
  if (payout.status === 'approved') return 'Payout approved'
  if (payout.status === 'paid') return 'Paid'
  return 'Eligible'
}

// Seller-facing status descriptions (no internal details)
export function deriveSellerFacingPayoutStatus(
  lineStatus: string,
  payout: { status: string } | null,
): { label: string; description: string } {
  if (lineStatus === 'held') {
    return {
      label: 'On hold',
      description: 'This payment is under review. Contact CollectNTrades for additional information.',
    }
  }
  if (lineStatus === 'voided') {
    return {
      label: 'Cancelled',
      description: 'This payment obligation has been cancelled.',
    }
  }
  if (!payout) {
    return {
      label: 'Eligible',
      description: 'Your payment has been recorded as eligible. This does not mean payment has been sent yet.',
    }
  }
  if (payout.status === 'draft') {
    return {
      label: 'Payout being prepared',
      description: 'Your payout was approved but has not yet been recorded as paid.',
    }
  }
  if (payout.status === 'approved') {
    return {
      label: 'Approved',
      description: 'Your payout was approved but has not yet been recorded as paid.',
    }
  }
  if (payout.status === 'paid') {
    return {
      label: 'Paid',
      description: 'CollectNTrades recorded this payout as paid.',
    }
  }
  return { label: 'Eligible', description: 'Your payment has been recorded as eligible.' }
}

// ─── Payout batch validation ──────────────────────────────────────────────────

export type PayoutBatchValidation = { valid: true } | { valid: false; error: string }

export function validateLinesForPayout(
  lines: Array<{ status: string; payoutId: string | null; customerProfileId: string; currency: string }>,
  sellerProfile: { profileId: string; status: string } | null,
  targetCustomerProfileId: string,
): PayoutBatchValidation {
  if (lines.length === 0) {
    return { valid: false, error: 'At least one line must be selected.' }
  }
  if (!sellerProfile) {
    return { valid: false, error: 'An active SellerProfile is required to create a payout.' }
  }
  if (sellerProfile.status !== 'active') {
    return { valid: false, error: 'SellerProfile must be active to create a payout.' }
  }
  if (sellerProfile.profileId !== targetCustomerProfileId) {
    return { valid: false, error: 'SellerProfile does not belong to the selected customer.' }
  }
  const currency = lines[0].currency
  for (const line of lines) {
    if (line.status !== 'eligible') {
      return { valid: false, error: 'All selected lines must be in eligible status.' }
    }
    if (line.payoutId !== null) {
      return { valid: false, error: 'One or more lines are already assigned to a payout.' }
    }
    if (line.customerProfileId !== targetCustomerProfileId) {
      return { valid: false, error: 'All lines must belong to the same customer.' }
    }
    if (line.currency !== currency) {
      return { valid: false, error: 'All lines must use the same currency.' }
    }
  }
  return { valid: true }
}

export type PayoutApprovalValidation = { valid: true; recalculatedTotal: Prisma.Decimal } | { valid: false; error: string }

export function canApprovePayout(payout: {
  status: string
  customerProfileId: string
  lines: Array<{ netAmount: Prisma.Decimal }>
  sellerProfile: { status: string; profileId: string } | null
}): PayoutApprovalValidation {
  if (payout.status !== 'draft') {
    return { valid: false, error: 'Only draft payouts can be approved.' }
  }
  if (payout.lines.length === 0) {
    return { valid: false, error: 'Cannot approve a payout with no lines.' }
  }
  if (!payout.sellerProfile) {
    return { valid: false, error: 'An active SellerProfile is required to approve a payout.' }
  }
  if (payout.sellerProfile.status !== 'active') {
    return { valid: false, error: 'SellerProfile must be active to approve a payout.' }
  }
  if (payout.sellerProfile.profileId !== payout.customerProfileId) {
    return { valid: false, error: "SellerProfile does not belong to this payout's customer." }
  }
  const ZERO = new Prisma.Decimal(0)
  const recalculatedTotal = payout.lines
    .reduce((acc, l) => acc.plus(l.netAmount), ZERO)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  if (recalculatedTotal.lessThanOrEqualTo(ZERO)) {
    return { valid: false, error: 'Payout total must be greater than zero.' }
  }
  return { valid: true, recalculatedTotal }
}

// ─── Duplicate ID detection ───────────────────────────────────────────────────
// Used to reject submitted forms that include the same line ID multiple times.

export function checkForDuplicateLineIds(lineIds: string[]): {
  hasDuplicates: boolean
  duplicateIds: string[]
} {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of lineIds) {
    if (seen.has(id)) duplicates.add(id)
    else seen.add(id)
  }
  return { hasDuplicates: duplicates.size > 0, duplicateIds: [...duplicates] }
}

// ─── Paid status helpers ──────────────────────────────────────────────────────

export const ALLOWED_PAYMENT_METHODS = ['bank', 'paypal', 'venmo', 'check', 'cash', 'other'] as const
export type AllowedPaymentMethod = (typeof ALLOWED_PAYMENT_METHODS)[number]

export function isValidPaymentMethod(method: string): method is AllowedPaymentMethod {
  return (ALLOWED_PAYMENT_METHODS as readonly string[]).includes(method)
}

export function canMarkPayoutPaid(payout: { status: string }): boolean {
  return payout.status === 'approved'
}

export function canMarkPayoutApproved(payout: { status: string }): boolean {
  return payout.status === 'draft'
}
