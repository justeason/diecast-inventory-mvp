import { describe, it, expect } from 'vitest'
import {
  validateAgreementDraft,
  canTransitionStatus,
} from '@/lib/sellerAgreementValidation'

// ── validateAgreementDraft ────────────────────────────────────────────────────

describe('validateAgreementDraft — type validation', () => {
  it('rejects unknown type', () => {
    const result = validateAgreementDraft({ type: 'unknown' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.type).toBeDefined()
  })

  it('rejects empty type', () => {
    const result = validateAgreementDraft({ type: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.type).toBeDefined()
  })
})

describe('validateAgreementDraft — buyout', () => {
  it('accepts a valid buyout with required amount', () => {
    const result = validateAgreementDraft({ type: 'buyout', agreedBuyoutAmount: '50.00' })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.type).toBe('buyout')
      expect(result.data.agreedBuyoutAmount).toBe('50.00')
      expect(result.data.currency).toBe('USD')
    }
  })

  it('rejects buyout with missing agreedBuyoutAmount', () => {
    const result = validateAgreementDraft({ type: 'buyout' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.agreedBuyoutAmount).toBeDefined()
  })

  it('rejects buyout with zero agreedBuyoutAmount', () => {
    const result = validateAgreementDraft({ type: 'buyout', agreedBuyoutAmount: '0' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.agreedBuyoutAmount).toBeDefined()
  })

  it('rejects buyout with commission present', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      commissionPercent: '20',
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.commissionPercent).toBeDefined()
  })

  it('rejects buyout with fixedFee present', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      fixedFee: '5',
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.fixedFee).toBeDefined()
  })

  it('rejects buyout with minimumSellerPayout present', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      minimumSellerPayout: '50',
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.minimumSellerPayout).toBeDefined()
  })

  it('accepts buyout with optional agreedListPrice', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      agreedListPrice: '150',
    })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.agreedListPrice).toBe('150.00')
  })
})

describe('validateAgreementDraft — consignment', () => {
  it('accepts a valid consignment with commission', () => {
    const result = validateAgreementDraft({ type: 'consignment', commissionPercent: '20' })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.type).toBe('consignment')
      expect(result.data.commissionPercent).toBe('0.2000')
    }
  })

  it('rejects consignment with missing commission', () => {
    const result = validateAgreementDraft({ type: 'consignment' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.commissionPercent).toBeDefined()
  })

  it('rejects consignment with commission over 100', () => {
    const result = validateAgreementDraft({ type: 'consignment', commissionPercent: '101' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.commissionPercent).toBeDefined()
  })

  it('rejects consignment with agreedBuyoutAmount present', () => {
    const result = validateAgreementDraft({
      type: 'consignment',
      commissionPercent: '20',
      agreedBuyoutAmount: '100',
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.agreedBuyoutAmount).toBeDefined()
  })

  it('accepts consignment with all optional consignment fields', () => {
    const result = validateAgreementDraft({
      type: 'consignment',
      commissionPercent: '15.5',
      fixedFee: '10',
      minimumSellerPayout: '40',
      agreedListPrice: '120',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.commissionPercent).toBe('0.1550')
      expect(result.data.fixedFee).toBe('10.00')
      expect(result.data.minimumSellerPayout).toBe('40.00')
      expect(result.data.agreedListPrice).toBe('120.00')
    }
  })
})

describe('validateAgreementDraft — amount format', () => {
  it('rejects amounts with more than 2 decimal places', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100.123',
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.agreedBuyoutAmount).toBeDefined()
  })

  it('rejects non-numeric amounts', () => {
    const result = validateAgreementDraft({ type: 'buyout', agreedBuyoutAmount: 'abc' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.agreedBuyoutAmount).toBeDefined()
  })

  it('rejects agreedListPrice of zero', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      agreedListPrice: '0',
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.agreedListPrice).toBeDefined()
  })
})

describe('validateAgreementDraft — text fields', () => {
  it('rejects sellerTermsSummary over 2000 chars', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      sellerTermsSummary: 'x'.repeat(2001),
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.sellerTermsSummary).toBeDefined()
  })

  it('accepts sellerTermsSummary exactly 2000 chars', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      sellerTermsSummary: 'x'.repeat(2000),
    })
    expect(result.valid).toBe(true)
  })

  it('rejects adminNotes over 2000 chars', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '100',
      adminNotes: 'x'.repeat(2001),
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.adminNotes).toBeDefined()
  })

  it('trims and nullifies empty sellerTermsSummary', () => {
    const result = validateAgreementDraft({
      type: 'buyout',
      agreedBuyoutAmount: '50',
      sellerTermsSummary: '   ',
    })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.sellerTermsSummary).toBeNull()
  })
})

// ── canTransitionStatus ───────────────────────────────────────────────────────

describe('canTransitionStatus', () => {
  it('allows draft → proposed', () => {
    const r = canTransitionStatus('draft', 'proposed')
    expect(r.allowed).toBe(true)
  })

  it('allows draft → cancelled', () => {
    const r = canTransitionStatus('draft', 'cancelled')
    expect(r.allowed).toBe(true)
  })

  it('allows proposed → accepted', () => {
    const r = canTransitionStatus('proposed', 'accepted')
    expect(r.allowed).toBe(true)
  })

  it('allows proposed → cancelled', () => {
    const r = canTransitionStatus('proposed', 'cancelled')
    expect(r.allowed).toBe(true)
  })

  it('allows accepted → cancelled', () => {
    const r = canTransitionStatus('accepted', 'cancelled')
    expect(r.allowed).toBe(true)
  })

  it('blocks draft → accepted (skip proposed)', () => {
    const r = canTransitionStatus('draft', 'accepted')
    expect(r.allowed).toBe(false)
  })

  it('blocks accepted → proposed (no going back)', () => {
    const r = canTransitionStatus('accepted', 'proposed')
    expect(r.allowed).toBe(false)
  })

  it('blocks proposed → draft (no going back)', () => {
    const r = canTransitionStatus('proposed', 'draft')
    expect(r.allowed).toBe(false)
  })

  it('blocks cancelled → any (terminal)', () => {
    expect(canTransitionStatus('cancelled', 'draft').allowed).toBe(false)
    expect(canTransitionStatus('cancelled', 'proposed').allowed).toBe(false)
    expect(canTransitionStatus('cancelled', 'accepted').allowed).toBe(false)
    expect(canTransitionStatus('cancelled', 'cancelled').allowed).toBe(false)
  })

  it('reports unknown status', () => {
    const r = canTransitionStatus('unknown', 'proposed')
    expect(r.allowed).toBe(false)
  })
})
