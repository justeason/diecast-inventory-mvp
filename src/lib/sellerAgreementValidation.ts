export type AgreementDraftInput = {
  type: string
  agreedBuyoutAmount?: string | null
  commissionPercent?: string | null
  fixedFee?: string | null
  minimumSellerPayout?: string | null
  agreedListPrice?: string | null
  sellerTermsSummary?: string | null
  adminNotes?: string | null
}

export type ValidationErrors = Record<string, string[]>

export type AgreementValidationResult =
  | { valid: false; errors: ValidationErrors }
  | {
      valid: true
      data: {
        type: 'buyout' | 'consignment'
        currency: 'USD'
        agreedBuyoutAmount: string | null
        commissionPercent: string | null
        fixedFee: string | null
        minimumSellerPayout: string | null
        agreedListPrice: string | null
        sellerTermsSummary: string | null
        adminNotes: string | null
      }
    }

type FieldResult = { ok: true; value: string | null } | { ok: false; reason: string }

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

function parseAmount(raw: string | null | undefined): FieldResult {
  if (raw == null || raw.trim() === '') return { ok: true, value: null }
  const str = raw.trim()
  if (!AMOUNT_RE.test(str)) {
    return { ok: false, reason: 'Must be a valid number with at most 2 decimal places' }
  }
  const n = parseFloat(str)
  if (n < 0) return { ok: false, reason: 'Must be 0 or greater' }
  return { ok: true, value: n.toFixed(2) }
}

function parseCommissionPercent(raw: string | null | undefined): FieldResult {
  if (raw == null || raw.trim() === '') return { ok: true, value: null }
  const str = raw.trim()
  if (!AMOUNT_RE.test(str)) {
    return { ok: false, reason: 'Must be a valid percentage with at most 2 decimal places' }
  }
  const n = parseFloat(str)
  if (n < 0 || n > 100) {
    return { ok: false, reason: 'Must be between 0 and 100' }
  }
  return { ok: true, value: (n / 100).toFixed(4) }
}

export function validateAgreementDraft(input: AgreementDraftInput): AgreementValidationResult {
  const errors: ValidationErrors = {}

  const buyoutResult = parseAmount(input.agreedBuyoutAmount)
  const commissionResult = parseCommissionPercent(input.commissionPercent)
  const fixedFeeResult = parseAmount(input.fixedFee)
  const minPayoutResult = parseAmount(input.minimumSellerPayout)
  const listPriceResult = parseAmount(input.agreedListPrice)

  if (!buyoutResult.ok) errors.agreedBuyoutAmount = [buyoutResult.reason]
  if (!commissionResult.ok) errors.commissionPercent = [commissionResult.reason]
  if (!fixedFeeResult.ok) errors.fixedFee = [fixedFeeResult.reason]
  if (!minPayoutResult.ok) errors.minimumSellerPayout = [minPayoutResult.reason]
  if (!listPriceResult.ok) errors.agreedListPrice = [listPriceResult.reason]

  if (listPriceResult.ok && listPriceResult.value !== null) {
    if (parseFloat(listPriceResult.value) <= 0) {
      errors.agreedListPrice = ['Agreed list price must be greater than 0']
    }
  }

  if ((input.sellerTermsSummary?.length ?? 0) > 2000) {
    errors.sellerTermsSummary = ['Seller terms summary must be 2000 characters or fewer']
  }
  if ((input.adminNotes?.length ?? 0) > 2000) {
    errors.adminNotes = ['Admin notes must be 2000 characters or fewer']
  }

  if (!['buyout', 'consignment'].includes(input.type)) {
    errors.type = ['Type must be buyout or consignment']
  } else if (input.type === 'buyout') {
    if (!buyoutResult.ok || buyoutResult.value === null) {
      errors.agreedBuyoutAmount = ['Agreed buyout amount is required for buyout agreements']
    } else if (parseFloat(buyoutResult.value) <= 0) {
      errors.agreedBuyoutAmount = ['Agreed buyout amount must be greater than 0']
    }
    if (commissionResult.ok && commissionResult.value !== null) {
      errors.commissionPercent = ['Commission percent is not applicable for buyout agreements']
    }
    if (fixedFeeResult.ok && fixedFeeResult.value !== null) {
      errors.fixedFee = ['Fixed fee is not applicable for buyout agreements']
    }
    if (minPayoutResult.ok && minPayoutResult.value !== null) {
      errors.minimumSellerPayout = [
        'Minimum seller payout is not applicable for buyout agreements',
      ]
    }
  } else if (input.type === 'consignment') {
    if (!commissionResult.ok || commissionResult.value === null) {
      errors.commissionPercent = ['Commission percent is required for consignment agreements']
    }
    if (buyoutResult.ok && buyoutResult.value !== null) {
      errors.agreedBuyoutAmount = [
        'Agreed buyout amount is not applicable for consignment agreements',
      ]
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    data: {
      type: input.type as 'buyout' | 'consignment',
      currency: 'USD',
      agreedBuyoutAmount: buyoutResult.ok ? buyoutResult.value : null,
      commissionPercent: commissionResult.ok ? commissionResult.value : null,
      fixedFee: fixedFeeResult.ok ? fixedFeeResult.value : null,
      minimumSellerPayout: minPayoutResult.ok ? minPayoutResult.value : null,
      agreedListPrice: listPriceResult.ok ? listPriceResult.value : null,
      sellerTermsSummary: input.sellerTermsSummary?.trim() || null,
      adminNotes: input.adminNotes?.trim() || null,
    },
  }
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ['proposed', 'cancelled'],
  proposed: ['accepted', 'cancelled'],
  accepted: ['cancelled'],
  cancelled: [],
}

export function canTransitionStatus(
  currentStatus: string,
  newStatus: string,
): { allowed: true } | { allowed: false; reason: string } {
  const allowed = VALID_TRANSITIONS[currentStatus]
  if (!allowed) return { allowed: false, reason: `Unknown status: ${currentStatus}` }
  if (!allowed.includes(newStatus)) {
    return { allowed: false, reason: `Cannot transition from ${currentStatus} to ${newStatus}` }
  }
  return { allowed: true }
}
