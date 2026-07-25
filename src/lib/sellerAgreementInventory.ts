// Pure helpers for seller-agreement ↔ inventory integration.
// No DB calls, no server imports — safe to import from both server and client modules.

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
          'You must confirm that the buyout amount will be recorded as the inventory acquisition cost.',
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
      belowMinimum: boolean
    }

export function calculateConsignmentPreview(input: ConsignmentPreviewInput): ConsignmentPreview {
  const listingPrice = parseFloat(input.listingPriceStr)
  if (!Number.isFinite(listingPrice) || listingPrice <= 0) {
    return { valid: false }
  }

  const commission = parseFloat(input.commissionPercent)
  if (!Number.isFinite(commission)) {
    return { valid: false }
  }

  const estimatedCommission = roundCents(listingPrice * commission)

  const rawFixedFee = input.fixedFee ? parseFloat(input.fixedFee) : 0
  const estimatedFixedFee = Number.isFinite(rawFixedFee) ? rawFixedFee : 0

  const estimatedProceeds = roundCents(
    Math.max(0, listingPrice - estimatedCommission - estimatedFixedFee),
  )

  let belowMinimum = false
  if (input.minimumSellerPayout) {
    const minPayout = parseFloat(input.minimumSellerPayout)
    if (Number.isFinite(minPayout) && minPayout > 0) {
      belowMinimum = estimatedProceeds < minPayout
    }
  }

  return {
    valid: true,
    listingPrice,
    estimatedCommission,
    estimatedFixedFee,
    estimatedProceeds,
    belowMinimum,
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100
}
