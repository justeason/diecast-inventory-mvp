// Pure helpers for seller-agreement ↔ inventory integration.
// No DB calls — safe to import from both server and client modules.

import { Prisma } from '@prisma/client'
import { calculateConsignmentPayoutSnapshot } from '@/lib/sellerPayoutCalculation'

export type SourceType = 'company_owned' | 'buyout' | 'consignment'

export type AgreementRecord = {
  id: string
  type: string
  status: string
}

export type ConversionEligibility =
  | { eligible: true; sourceType: SourceType; acceptedAgreementId: string | null }
  | { eligible: false; reason: string }

export function resolveConversionEligibility(
  sellerSubmissionId: string | null,
  agreements: AgreementRecord[],
): ConversionEligibility {
  if (!sellerSubmissionId) {
    return { eligible: true, sourceType: 'company_owned', acceptedAgreementId: null }
  }

  const active = agreements.filter((a) => a.status !== 'cancelled')

  if (active.length === 0) {
    const hasCancelled = agreements.some((a) => a.status === 'cancelled')
    if (hasCancelled) {
      return {
        eligible: false,
        reason:
          'The commercial agreement is cancelled. Create and accept a replacement agreement before conversion.',
      }
    }
    return {
      eligible: false,
      reason:
        'An accepted commercial agreement is required before converting seller-sourced intake.',
    }
  }

  if (active.length > 1) {
    return {
      eligible: false,
      reason: 'Multiple active agreements found. Resolve agreement records before conversion.',
    }
  }

  const agreement = active[0]

  if (agreement.status === 'draft') {
    return {
      eligible: false,
      reason:
        'The commercial agreement is still a draft. It must be proposed and accepted before conversion.',
    }
  }

  if (agreement.status === 'proposed') {
    return {
      eligible: false,
      reason: 'Seller acceptance has not been recorded for the proposed agreement.',
    }
  }

  if (agreement.status !== 'accepted') {
    return {
      eligible: false,
      reason: `Unexpected agreement status: "${agreement.status}".`,
    }
  }

  const sourceType = mapAgreementTypeToSourceType(agreement.type)
  if (!sourceType) {
    return {
      eligible: false,
      reason: `Unsupported agreement type: "${agreement.type}". Only buyout and consignment are supported.`,
    }
  }

  return { eligible: true, sourceType, acceptedAgreementId: agreement.id }
}

export function mapAgreementTypeToSourceType(type: string): SourceType | null {
  if (type === 'buyout') return 'buyout'
  if (type === 'consignment') return 'consignment'
  return null
}

export function validateConversionConfirmation(
  sourceType: SourceType,
  formConfirmBuyout: string | null,
  formConfirmConsignment: string | null,
): { valid: true } | { valid: false; error: string } {
  if (sourceType === 'buyout') {
    if (formConfirmBuyout !== 'on') {
      return {
        valid: false,
        error:
          'You must confirm the agreed buyout amount is the seller payment for this agreement.',
      }
    }
  } else if (sourceType === 'consignment') {
    if (formConfirmConsignment !== 'on') {
      return {
        valid: false,
        error:
          'You must confirm this item remains seller-owned under the accepted consignment agreement.',
      }
    }
  }
  return { valid: true }
}

export type ConsignmentPreviewInput = {
  listingPriceStr: string
  commissionPercent: string
  commissionMinimumFee: string | null
  fixedFee: string | null
  minimumSellerPayout: string | null
}

export type ConsignmentPreview =
  | { valid: false }
  | {
      valid: true
      listingPrice: number
      estimatedCommission: number
      estimatedFixedFee: number
      estimatedProceeds: number
      // True when the canonical minimum-payout top-up was applied — i.e. the
      // market-derived proceeds fell short and estimatedProceeds is now the
      // guaranteed floor, not a market-price-derived amount. Never "final
      // proceeds are below the minimum" — calculateConsignmentPayoutSnapshot
      // guarantees that can't happen once a minimum is set.
      belowMinimum: boolean
    }

// Admin Listing-form "Projected seller payout" preview — a thin UI-facing
// wrapper around the CANONICAL calculateConsignmentPayoutSnapshot (the same
// function actual settlement uses). Never a second, independently-derived fee
// formula: this function only parses form-input strings into Decimal and
// reshapes the canonical snapshot back into the preview's display shape.
export function calculateConsignmentPreview(input: ConsignmentPreviewInput): ConsignmentPreview {
  const listingPrice = parseFloat(input.listingPriceStr)
  if (!Number.isFinite(listingPrice) || listingPrice <= 0) {
    return { valid: false }
  }

  const commission = parseFloat(input.commissionPercent)
  if (!Number.isFinite(commission)) {
    return { valid: false }
  }

  const parseDecimalOrNull = (raw: string | null): Prisma.Decimal | null => {
    if (!raw) return null
    const n = parseFloat(raw)
    return Number.isFinite(n) ? new Prisma.Decimal(raw) : null
  }

  const snapshot = calculateConsignmentPayoutSnapshot({
    grossSalePriceFloat: listingPrice,
    commissionPercent: new Prisma.Decimal(commission),
    commissionMinimumFee: parseDecimalOrNull(input.commissionMinimumFee),
    fixedFee: parseDecimalOrNull(input.fixedFee),
    minimumSellerPayout: parseDecimalOrNull(input.minimumSellerPayout),
  })

  return {
    valid: true,
    listingPrice,
    estimatedCommission: snapshot.commissionAmount.toNumber(),
    estimatedFixedFee: (snapshot.fixedFee ?? new Prisma.Decimal(0)).toNumber(),
    estimatedProceeds: snapshot.netAmount.toNumber(),
    belowMinimum: snapshot.minimumAdjustment.greaterThan(0),
  }
}
