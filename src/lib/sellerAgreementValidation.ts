export type AgreementDraftInput = {
  type: string
  agreedBuyoutAmount?: string | null
  commissionPercent?: string | null
  fixedFee?: string | null
  minimumSellerPayout?: string | null
  agreedListPrice?: string | null
  sellerTermsSummary?: string | null
  adminNotes?: string | null
  // 15A: presence of commissionPercent for a consignment agreement now means
  // "explicit agreement-level override" (normal flow leaves it blank and lets the
  // Commission Policy Engine auto-resolve) — a reason is then required.
  commissionOverrideReason?: string | null
  commissionMinimumFee?: string | null
  // 15A-review section 1: the authoritative volume-tier denominator for THIS
  // agreement — distinct from SellerSubmission.quantity (seller-requested). Required
  // for consignment (drives tiering even when no override is set). 15D-review (final
  // approval pass): also OPTIONAL for buyout — a value of exactly 1 is the
  // authoritative signal that the agreement's total is a true single-item price (see
  // intakeConversion.ts). The <= submission.quantity cap check needs DB access and
  // happens in the action layer, not here.
  acceptedItemCount?: string | null
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
        commissionOverrideReason: string | null
        commissionMinimumFee: string | null
        isCommissionOverride: boolean
        acceptedItemCount: number | null
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

type IntFieldResult = { ok: true; value: number | null } | { ok: false; reason: string }

function parseAcceptedItemCount(raw: string | null | undefined): IntFieldResult {
  if (raw == null || raw.trim() === '') return { ok: true, value: null }
  const str = raw.trim()
  if (!/^\d+$/.test(str)) {
    return { ok: false, reason: 'Must be a whole number' }
  }
  const n = parseInt(str, 10)
  if (n < 1) return { ok: false, reason: 'Must be 1 or greater' }
  return { ok: true, value: n }
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
  const acceptedItemCountResult = parseAcceptedItemCount(input.acceptedItemCount)

  if (!buyoutResult.ok) errors.agreedBuyoutAmount = [buyoutResult.reason]
  if (!commissionResult.ok) errors.commissionPercent = [commissionResult.reason]
  if (!fixedFeeResult.ok) errors.fixedFee = [fixedFeeResult.reason]
  if (!minPayoutResult.ok) errors.minimumSellerPayout = [minPayoutResult.reason]
  if (!listPriceResult.ok) errors.agreedListPrice = [listPriceResult.reason]
  if (!acceptedItemCountResult.ok) errors.acceptedItemCount = [acceptedItemCountResult.reason]

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
    // 15D-review (final approval pass): acceptedItemCount is OPTIONAL for buyout —
    // when set to exactly 1, it is the authoritative signal that agreedBuyoutAmount
    // is a true single-item price (intake then assigns it as that item's cost basis).
    // Left blank (null) or >1, item-level cost stays unallocated — never guessed. No
    // consignment-style commission-tier logic attaches to it for buyout.
  } else if (input.type === 'consignment') {
    // 15A: commissionPercent is no longer required — leaving it blank means "let the
    // Commission Policy Engine auto-resolve." Providing it is an explicit
    // agreement-level override and requires a reason (section 7).
    if (buyoutResult.ok && buyoutResult.value !== null) {
      errors.agreedBuyoutAmount = [
        'Agreed buyout amount is not applicable for consignment agreements',
      ]
    }
    // 15A-review section 1: required — it's the authoritative volume-tier
    // denominator and must never be silently absent for a consignment agreement.
    if (acceptedItemCountResult.ok && acceptedItemCountResult.value === null) {
      errors.acceptedItemCount = ['Accepted quantity is required for consignment agreements']
    }
  }

  const isCommissionOverride = input.type === 'consignment' && commissionResult.ok && commissionResult.value !== null
  const overrideMinFeeResult = parseAmount(input.commissionMinimumFee)
  if (!overrideMinFeeResult.ok) errors.commissionMinimumFee = [overrideMinFeeResult.reason]

  if (isCommissionOverride && !input.commissionOverrideReason?.trim()) {
    errors.commissionOverrideReason = ['A reason is required when manually overriding commission terms']
  }
  if ((input.commissionOverrideReason?.length ?? 0) > 500) {
    errors.commissionOverrideReason = ['Reason must be 500 characters or fewer']
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
      commissionOverrideReason: isCommissionOverride ? (input.commissionOverrideReason?.trim() || null) : null,
      commissionMinimumFee: isCommissionOverride && overrideMinFeeResult.ok ? overrideMinFeeResult.value : null,
      isCommissionOverride,
      fixedFee: fixedFeeResult.ok ? fixedFeeResult.value : null,
      minimumSellerPayout: minPayoutResult.ok ? minPayoutResult.value : null,
      agreedListPrice: listPriceResult.ok ? listPriceResult.value : null,
      sellerTermsSummary: input.sellerTermsSummary?.trim() || null,
      adminNotes: input.adminNotes?.trim() || null,
      acceptedItemCount: acceptedItemCountResult.ok ? acceptedItemCountResult.value : null,
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
