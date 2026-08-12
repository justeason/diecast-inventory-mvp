import { describe, it, expect } from 'vitest'
import {
  derivePortfolioStage,
  canMarkPortfolioCompleted,
  evaluatePortfolioAttentionSignals,
  type PortfolioStageInput,
} from '@/lib/sellerPortfolio'

const BASE: PortfolioStageInput = {
  status: 'open',
  hasAcceptedAgreement: false,
  hasNonCancelledShipment: false,
  anyShipmentInTransit: false,
  receivedItemCount: 0,
  intakeCompleteCount: 0,
  allInventoryResolved: false,
  hasOutstandingPayoutLiability: false,
  hasOpenIntakeException: false,
  hasUnresolvedInboundDiscrepancy: false,
}

describe('derivePortfolioStage', () => {
  it('cancelled status always wins, regardless of underlying data', () => {
    const r = derivePortfolioStage({ ...BASE, status: 'cancelled', hasAcceptedAgreement: true, allInventoryResolved: true })
    expect(r.stage).toBe('cancelled')
    expect(r.statusMismatch).toBe(false)
  })

  it('no accepted agreement -> awaiting_agreement', () => {
    expect(derivePortfolioStage(BASE).stage).toBe('awaiting_agreement')
  })

  it('agreement accepted + no shipment -> awaiting_shipment', () => {
    const r = derivePortfolioStage({ ...BASE, hasAcceptedAgreement: true })
    expect(r.stage).toBe('awaiting_shipment')
  })

  it('shipment in transit -> inbound', () => {
    const r = derivePortfolioStage({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true, anyShipmentInTransit: true,
    })
    expect(r.stage).toBe('inbound')
  })

  it('received > intakeComplete -> intake', () => {
    const r = derivePortfolioStage({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 10, intakeCompleteCount: 7,
    })
    expect(r.stage).toBe('intake')
  })

  it('intake caught up, not fully resolved -> active', () => {
    const r = derivePortfolioStage({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 10, intakeCompleteCount: 10,
    })
    expect(r.stage).toBe('active')
  })

  it('all resolved + no outstanding liability -> completed (data-derived, even without stored completed status)', () => {
    const r = derivePortfolioStage({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 10, intakeCompleteCount: 10, allInventoryResolved: true,
    })
    expect(r.stage).toBe('completed')
  })

  it('stored status=completed but data no longer supports it -> reports the data-derived stage with mismatch=true', () => {
    const r = derivePortfolioStage({
      ...BASE, status: 'completed', hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 10, intakeCompleteCount: 10, allInventoryResolved: false,
    })
    expect(r.stage).toBe('active')
    expect(r.statusMismatch).toBe(true)
  })

  it('stored status=completed and data agrees -> completed, no mismatch', () => {
    const r = derivePortfolioStage({
      ...BASE, status: 'completed', hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 10, intakeCompleteCount: 10, allInventoryResolved: true,
    })
    expect(r.stage).toBe('completed')
    expect(r.statusMismatch).toBe(false)
  })

  it('outstanding payout liability blocks the completed stage even when inventory is otherwise resolved', () => {
    const r = derivePortfolioStage({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 10, intakeCompleteCount: 10, allInventoryResolved: true,
      hasOutstandingPayoutLiability: true,
    })
    expect(r.stage).toBe('active')
  })
})

describe('canMarkPortfolioCompleted', () => {
  it('rejects when outstanding payout liability remains — never allow false completion (section 16)', () => {
    const result = canMarkPortfolioCompleted({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 5, intakeCompleteCount: 5, allInventoryResolved: true,
      hasOutstandingPayoutLiability: true,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects when inventory/intake is unresolved', () => {
    const result = canMarkPortfolioCompleted(BASE)
    expect(result.ok).toBe(false)
  })

  it('allows completion when data-derived stage is already completed', () => {
    const result = canMarkPortfolioCompleted({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 5, intakeCompleteCount: 5, allInventoryResolved: true,
    })
    expect(result.ok).toBe(true)
  })

  // 15B-review section 4: the two previously-missing blocking conditions.
  it('rejects completion while an intake exception (rejected draft / open case) is open, even if inventory/payout are otherwise resolved', () => {
    const result = canMarkPortfolioCompleted({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 5, intakeCompleteCount: 5, allInventoryResolved: true,
      hasOpenIntakeException: true,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/intake exception/)
  })

  it('rejects completion while an inbound shipment is flagged "issue" (unresolved discrepancy), even if inventory/payout are otherwise resolved', () => {
    const result = canMarkPortfolioCompleted({
      ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
      receivedItemCount: 5, intakeCompleteCount: 5, allInventoryResolved: true,
      hasUnresolvedInboundDiscrepancy: true,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/inbound shipment issue/)
  })

  it('a fully valid portfolio (agreement accepted, shipment received, intake caught up, inventory resolved, no liability, no exceptions, no discrepancy) can be completed', () => {
    const result = canMarkPortfolioCompleted({
      status: 'open',
      hasAcceptedAgreement: true,
      hasNonCancelledShipment: true,
      anyShipmentInTransit: false,
      receivedItemCount: 12,
      intakeCompleteCount: 12,
      allInventoryResolved: true,
      hasOutstandingPayoutLiability: false,
      hasOpenIntakeException: false,
      hasUnresolvedInboundDiscrepancy: false,
    })
    expect(result.ok).toBe(true)
  })
})

describe('derivePortfolioStage — the two new completion-blocking facts (section 4)', () => {
  const RESOLVED_EXCEPT_NEW_FACTS: PortfolioStageInput = {
    ...BASE, hasAcceptedAgreement: true, hasNonCancelledShipment: true,
    receivedItemCount: 5, intakeCompleteCount: 5, allInventoryResolved: true,
  }

  it('an open intake exception keeps the stage at "active", never "completed"', () => {
    const r = derivePortfolioStage({ ...RESOLVED_EXCEPT_NEW_FACTS, hasOpenIntakeException: true })
    expect(r.stage).toBe('active')
  })

  it('an unresolved inbound discrepancy (shipment flagged issue) keeps the stage at "active", never "completed"', () => {
    const r = derivePortfolioStage({ ...RESOLVED_EXCEPT_NEW_FACTS, hasUnresolvedInboundDiscrepancy: true })
    expect(r.stage).toBe('active')
  })

  it('a stored status=completed is downgraded (with mismatch=true) when an intake exception reappears', () => {
    const r = derivePortfolioStage({ ...RESOLVED_EXCEPT_NEW_FACTS, status: 'completed', hasOpenIntakeException: true })
    expect(r.stage).toBe('active')
    expect(r.statusMismatch).toBe(true)
  })
})

describe('evaluatePortfolioAttentionSignals', () => {
  const CLEAN = {
    status: 'open',
    hasAnyAgreement: true,
    hasAcceptedAgreement: true,
    acceptedCount: 75,
    expectedShipmentQuantity: 75,
    receivedShipmentQuantity: 75,
    hasAnyShipment: true,
    receivedItemCount: 10,
    intakeCompleteCount: 10,
    hasOpenIntakeException: false,
    soldWithoutPayoutObligation: false,
    outstandingEligiblePayoutCount: 0,
  }

  it('a normal, fully-consistent portfolio has no false warnings', () => {
    expect(evaluatePortfolioAttentionSignals(CLEAN)).toEqual([])
  })

  it('flags a received-vs-expected quantity discrepancy', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, receivedShipmentQuantity: 73 })
    expect(signals.some(s => s.code === 'received_quantity_mismatch')).toBe(true)
  })

  it('flags an accepted-vs-expected mismatch', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, expectedShipmentQuantity: 60 })
    expect(signals.some(s => s.code === 'accepted_vs_expected_mismatch')).toBe(true)
  })

  it('flags items received but intake incomplete', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, receivedItemCount: 10, intakeCompleteCount: 8 })
    expect(signals.some(s => s.code === 'received_not_intaken')).toBe(true)
  })

  it('flags a missing agreement for a non-draft portfolio', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, hasAnyAgreement: false, hasAcceptedAgreement: false, acceptedCount: null, hasAnyShipment: false, expectedShipmentQuantity: null, receivedShipmentQuantity: null })
    expect(signals.some(s => s.code === 'agreement_missing')).toBe(true)
  })

  it('does not flag a missing agreement while still in draft', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, status: 'draft', hasAnyAgreement: false, hasAcceptedAgreement: false, acceptedCount: null, hasAnyShipment: false, expectedShipmentQuantity: null, receivedShipmentQuantity: null })
    expect(signals.some(s => s.code === 'agreement_missing')).toBe(false)
  })

  it('flags a missing shipment after agreement acceptance', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, hasAnyShipment: false, expectedShipmentQuantity: null, receivedShipmentQuantity: null })
    expect(signals.some(s => s.code === 'shipment_missing')).toBe(true)
  })

  it('flags an open intake exception', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, hasOpenIntakeException: true })
    expect(signals.some(s => s.code === 'intake_exception')).toBe(true)
  })

  it('flags a sold item missing its payout obligation', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, soldWithoutPayoutObligation: true })
    expect(signals.some(s => s.code === 'sold_missing_payout_obligation')).toBe(true)
  })

  it('flags outstanding eligible payout lines needing action', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, outstandingEligiblePayoutCount: 3 })
    expect(signals.some(s => s.code === 'payout_action_needed')).toBe(true)
  })

  it('suppresses all signals for a cancelled portfolio', () => {
    const signals = evaluatePortfolioAttentionSignals({ ...CLEAN, status: 'cancelled', receivedShipmentQuantity: 1, expectedShipmentQuantity: 99 })
    expect(signals).toEqual([])
  })
})
