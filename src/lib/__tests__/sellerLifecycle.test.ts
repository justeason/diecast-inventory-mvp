import { describe, it, expect } from 'vitest'
import {
  deriveSellerLifecycleSummary,
  deriveLifecycleStage,
  deriveAttentionStatus,
  buildSellerLifecycleTimeline,
  findLifecycleFinancialWarnings,
  sellerSafeCaseLabel,
  CASE_TYPE_LABELS,
  STAGE_LABELS,
  ATTENTION_LABELS,
  agreementEventKey,
  intakeEventKey,
  listingEventKey,
  orderEventKey,
  payoutLineEventKey,
  payoutEventKey,
  caseEventKey,
  type LifecycleInput,
  type TimelineInput,
  type ReconciliationInput,
} from '@/lib/sellerLifecycle'

// ─── Helpers ────────────────────────────────────────────────────────────────────

function baseInput(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    submission: { status: 'submitted' },
    agreements: [],
    intakeDrafts: [],
    items: [],
    payoutLines: [],
    openCases: [],
    ...overrides,
  }
}

function baseTimeline(overrides: Partial<TimelineInput> = {}): TimelineInput {
  return {
    submission: { createdAt: new Date('2026-01-01'), status: 'submitted' },
    agreements: [],
    intakeDrafts: [],
    items: [],
    listings: [],
    orderItems: [],
    payoutLines: [],
    persistedEvents: [],
    ...overrides,
  }
}

function baseRecon(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    cases: [],
    payoutLines: [],
    items: [],
    intakeDrafts: [],
    ...overrides,
  }
}

// ─── Stage derivation (1-15) ────────────────────────────────────────────────────

describe('deriveLifecycleStage', () => {
  it('1. defaults to submitted', () => {
    expect(deriveLifecycleStage(baseInput())).toBe('submitted')
  })

  it('2. under_review from submission status', () => {
    expect(deriveLifecycleStage(baseInput({ submission: { status: 'under_review' } }))).toBe('under_review')
  })

  it('3. approved_for_intake from submission status', () => {
    expect(
      deriveLifecycleStage(baseInput({ submission: { status: 'approved_for_intake' } })),
    ).toBe('approved_for_intake')
  })

  it('4. agreement_pending when proposed agreement exists', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ agreements: [{ id: 'a1', type: 'buyout', status: 'proposed' }] }),
      ),
    ).toBe('agreement_pending')
  })

  it('5. awaiting_item when accepted agreement and no intake', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ agreements: [{ id: 'a1', type: 'consignment', status: 'accepted' }] }),
      ),
    ).toBe('awaiting_item')
  })

  it('6. intake_in_progress for draft intake', () => {
    expect(
      deriveLifecycleStage(
        baseInput({
          agreements: [{ id: 'a1', type: 'consignment', status: 'accepted' }],
          intakeDrafts: [{ status: 'draft', convertedItemId: null }],
        }),
      ),
    ).toBe('intake_in_progress')
  })

  it('7. intake_in_progress for reviewed intake', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ intakeDrafts: [{ status: 'reviewed', convertedItemId: null }] }),
      ),
    ).toBe('intake_in_progress')
  })

  it('8. intake_rejected for rejected intake with no conversion', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ intakeDrafts: [{ status: 'rejected', convertedItemId: null }] }),
      ),
    ).toBe('intake_rejected')
  })

  it('9. inventory_received for available buyout item', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ items: [{ status: 'available', sourceType: 'buyout', listing: null }] }),
      ),
    ).toBe('inventory_received')
  })

  it('10. ready_to_list for available consignment item without listing', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ items: [{ status: 'available', sourceType: 'consignment', listing: null }] }),
      ),
    ).toBe('ready_to_list')
  })

  it('11. listed when active listing exists', () => {
    expect(
      deriveLifecycleStage(
        baseInput({
          items: [{ status: 'available', sourceType: 'consignment', listing: { status: 'active' } }],
        }),
      ),
    ).toBe('listed')
  })

  it('12. sale_pending when item reserved', () => {
    expect(
      deriveLifecycleStage(
        baseInput({
          items: [{ status: 'reserved', sourceType: 'consignment', listing: { status: 'active' } }],
        }),
      ),
    ).toBe('sale_pending')
  })

  it('13. sold when item sold', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ items: [{ status: 'sold', sourceType: 'consignment', listing: null }] }),
      ),
    ).toBe('sold')
  })

  it('14. payout_eligible for eligible unbatched line', () => {
    expect(
      deriveLifecycleStage(
        baseInput({
          items: [{ status: 'sold', sourceType: 'consignment', listing: null }],
          payoutLines: [{ status: 'eligible', payoutId: null, payout: null }],
        }),
      ),
    ).toBe('payout_eligible')
  })

  it('15. payout state overrides item state (paid wins)', () => {
    expect(
      deriveLifecycleStage(
        baseInput({
          items: [{ status: 'sold', sourceType: 'consignment', listing: null }],
          payoutLines: [{ status: 'eligible', payoutId: 'p1', payout: { status: 'paid' } }],
        }),
      ),
    ).toBe('paid')
  })

  it('15b. payout_preparing for draft payout', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ payoutLines: [{ status: 'eligible', payoutId: 'p1', payout: { status: 'draft' } }] }),
      ),
    ).toBe('payout_preparing')
  })

  it('15c. payout_approved for approved payout', () => {
    expect(
      deriveLifecycleStage(
        baseInput({ payoutLines: [{ status: 'eligible', payoutId: 'p1', payout: { status: 'approved' } }] }),
      ),
    ).toBe('payout_approved')
  })
})

describe('deriveSellerLifecycleSummary', () => {
  it('returns label, description and nextStep for the derived stage', () => {
    const summary = deriveSellerLifecycleSummary(baseInput({ submission: { status: 'under_review' } }))
    expect(summary.stage).toBe('under_review')
    expect(summary.label).toBe(STAGE_LABELS.under_review)
    expect(summary.sellerDescription).toBeTruthy()
    expect(summary.attention).toBe('none')
  })

  it('paid stage has null nextStep', () => {
    const summary = deriveSellerLifecycleSummary(
      baseInput({ payoutLines: [{ status: 'eligible', payoutId: 'p1', payout: { status: 'paid' } }] }),
    )
    expect(summary.stage).toBe('paid')
    expect(summary.nextStep).toBeNull()
  })
})

// ─── Attention derivation ──────────────────────────────────────────────────────

describe('deriveAttentionStatus', () => {
  it('none by default', () => {
    expect(deriveAttentionStatus(baseInput())).toBe('none')
  })

  it('lost_or_damaged case', () => {
    expect(
      deriveAttentionStatus(baseInput({ openCases: [{ caseType: 'lost_or_damaged', status: 'open' }] })),
    ).toBe('lost_or_damaged')
  })

  it('dispute_open for buyer_return', () => {
    expect(
      deriveAttentionStatus(baseInput({ openCases: [{ caseType: 'buyer_return', status: 'open' }] })),
    ).toBe('dispute_open')
  })

  it('dispute_open for buyer_dispute', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'buyer_dispute', status: 'action_required' }] }),
      ),
    ).toBe('dispute_open')
  })

  it('expired for consignment_expiration', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'consignment_expiration', status: 'open' }] }),
      ),
    ).toBe('expired')
  })

  it('return_in_progress for return_to_seller', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'return_to_seller', status: 'open' }] }),
      ),
    ).toBe('return_in_progress')
  })

  it('withdrawal_requested for seller_withdrawal', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'seller_withdrawal', status: 'open' }] }),
      ),
    ).toBe('withdrawal_requested')
  })

  it('on_hold when payout line held and no open case', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ payoutLines: [{ status: 'held', payoutId: null, payout: null }] }),
      ),
    ).toBe('on_hold')
  })

  it('manual_review when open case coincides with approved payout', () => {
    expect(
      deriveAttentionStatus(
        baseInput({
          openCases: [{ caseType: 'buyer_dispute', status: 'open' }],
          payoutLines: [{ status: 'eligible', payoutId: 'p1', payout: { status: 'approved' } }],
        }),
      ),
    ).toBe('manual_review')
  })

  it('resolved cases do not trigger attention', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'buyer_return', status: 'resolved' }] }),
      ),
    ).toBe('none')
  })
})

// ─── Timeline (16-21) ───────────────────────────────────────────────────────────

describe('buildSellerLifecycleTimeline', () => {
  it('16. always includes submission_received', () => {
    const events = buildSellerLifecycleTimeline(baseTimeline())
    expect(events.some((e) => e.eventType === 'submission_received')).toBe(true)
  })

  it('17. synthesizes agreement proposed and accepted events', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        agreements: [
          {
            id: 'a1',
            proposedAt: new Date('2026-01-02'),
            acceptedAt: new Date('2026-01-03'),
            cancelledAt: null,
            type: 'buyout',
            status: 'accepted',
          },
        ],
      }),
    )
    expect(events.some((e) => e.eventType === 'agreement_proposed')).toBe(true)
    expect(events.some((e) => e.eventType === 'agreement_accepted')).toBe(true)
  })

  it('18. sorts chronologically', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        payoutLines: [
          {
            id: 'l1',
            eligibleAt: new Date('2026-02-01'),
            lineType: 'consignment',
            heldAt: null,
            voidedAt: null,
            payout: { status: 'paid', approvedAt: new Date('2026-03-01'), paidAt: new Date('2026-04-01') },
          },
        ],
      }),
    )
    for (let i = 1; i < events.length; i++) {
      expect(events[i].occurredAt.getTime()).toBeGreaterThanOrEqual(events[i - 1].occurredAt.getTime())
    }
  })

  it('19. persisted event overrides synthesized for the same key', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        agreements: [
          { id: 'a1', proposedAt: new Date('2026-01-02'), acceptedAt: null, cancelledAt: null, type: 'buyout', status: 'proposed' },
        ],
        persistedEvents: [
          {
            eventKey: agreementEventKey('agreement-proposed', 'a1'),
            eventType: 'agreement_proposed',
            sellerTitle: 'Custom title',
            sellerDescription: 'Custom desc',
            adminDescription: null,
            sellerVisible: true,
            occurredAt: new Date('2026-01-02'),
          },
        ],
      }),
    )
    const proposed = events.find((e) => e.eventType === 'agreement_proposed')
    expect(proposed?.source).toBe('persisted')
    expect(proposed?.title).toBe('Custom title')
  })

  it('20. sellerView filters out non-seller-visible events', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        payoutLines: [
          {
            id: 'l1',
            eligibleAt: new Date('2026-02-01'),
            lineType: 'consignment',
            heldAt: null,
            voidedAt: null,
            payout: null,
          },
        ],
      }),
      { sellerView: true },
    )
    // payout_eligible is synthesized with sellerVisible=false → excluded.
    expect(events.some((e) => e.eventType === 'payout_eligible')).toBe(false)
    expect(events.every((e) => e.sellerVisible)).toBe(true)
  })

  it('21. sellerView strips adminDescription', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        persistedEvents: [
          {
            eventKey: 'x:1',
            eventType: 'custom',
            sellerTitle: 'Visible',
            sellerDescription: 'desc',
            adminDescription: 'SECRET admin note',
            sellerVisible: true,
            occurredAt: new Date('2026-01-05'),
          },
        ],
      }),
      { sellerView: true },
    )
    const e = events.find((ev) => ev.eventType === 'custom')
    expect(e?.adminDescription).toBeNull()
  })

  it('includes order_completed when order has completedAt', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        orderItems: [
          { id: 'oi1', order: { id: 'o1', status: 'complete', completedAt: new Date('2026-05-01') } },
        ],
      }),
    )
    expect(events.some((e) => e.eventType === 'order_completed')).toBe(true)
  })
})

// ─── Event key builders (structural) ────────────────────────────────────────────

describe('event key builders', () => {
  it('agreementEventKey', () => {
    expect(agreementEventKey('agreement-proposed', 'a1')).toBe('agreement-proposed:a1')
  })
  it('intakeEventKey', () => {
    expect(intakeEventKey('intake-rejected', 'd1')).toBe('intake-rejected:d1')
  })
  it('listingEventKey', () => {
    expect(listingEventKey('listing-created', 'l1')).toBe('listing-created:l1')
  })
  it('orderEventKey', () => {
    expect(orderEventKey('order-completed', 'o1')).toBe('order-completed:o1')
  })
  it('payoutLineEventKey without suffix', () => {
    expect(payoutLineEventKey('payout-line-voided', 'pl1')).toBe('payout-line-voided:pl1')
  })
  it('payoutLineEventKey with suffix', () => {
    expect(payoutLineEventKey('payout-line-held', 'pl1', '123')).toBe('payout-line-held:pl1:123')
  })
  it('payoutEventKey', () => {
    expect(payoutEventKey('payout-paid', 'p1')).toBe('payout-paid:p1')
  })
  it('caseEventKey', () => {
    expect(caseEventKey('case-opened', 'c1')).toBe('case-opened:c1')
  })
})

// ─── Intake rejection (22-27) ────────────────────────────────────────────────────

describe('intake rejection derivation', () => {
  it('22. rejected intake with no conversion yields intake_rejected stage', () => {
    expect(
      deriveLifecycleStage(baseInput({ intakeDrafts: [{ status: 'rejected', convertedItemId: null }] })),
    ).toBe('intake_rejected')
  })

  it('23. rejected intake but with an available item still shows inventory', () => {
    expect(
      deriveLifecycleStage(
        baseInput({
          intakeDrafts: [{ status: 'rejected', convertedItemId: null }],
          items: [{ status: 'available', sourceType: 'buyout', listing: null }],
        }),
      ),
    ).toBe('inventory_received')
  })

  it('24. intake_rejection is a seller-safe label', () => {
    expect(sellerSafeCaseLabel('intake_rejection')).toBe('Intake review completed')
  })

  it('25. reconciliation flags rejected + converted item as critical', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({ intakeDrafts: [{ status: 'rejected', convertedItemId: 'item_1' }] }),
    )
    expect(warnings.some((w) => w.code === 'intake_rejected_with_conversion' && w.severity === 'critical')).toBe(true)
  })

  it('26. no warning when rejected intake has no conversion', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({ intakeDrafts: [{ status: 'rejected', convertedItemId: null }] }),
    )
    expect(warnings.some((w) => w.code === 'intake_rejected_with_conversion')).toBe(false)
  })

  it('27. converted (non-rejected) intake produces no rejection warning', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({ intakeDrafts: [{ status: 'converted', convertedItemId: 'item_1' }] }),
    )
    expect(warnings.some((w) => w.code === 'intake_rejected_with_conversion')).toBe(false)
  })
})

// ─── Withdrawal and expiration (28-35) ───────────────────────────────────────────

describe('withdrawal and expiration', () => {
  it('28. seller_withdrawal open case → withdrawal_requested', () => {
    expect(
      deriveAttentionStatus(baseInput({ openCases: [{ caseType: 'seller_withdrawal', status: 'open' }] })),
    ).toBe('withdrawal_requested')
  })

  it('29. seller_withdrawal safe label', () => {
    expect(sellerSafeCaseLabel('seller_withdrawal')).toBe('Withdrawal recorded')
  })

  it('30. consignment_expiration open → expired', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'consignment_expiration', status: 'open' }] }),
      ),
    ).toBe('expired')
  })

  it('31. consignment_expiration safe label', () => {
    expect(sellerSafeCaseLabel('consignment_expiration')).toBe('Consignment ended')
  })

  it('32. return_to_seller open → return_in_progress', () => {
    expect(
      deriveAttentionStatus(baseInput({ openCases: [{ caseType: 'return_to_seller', status: 'open' }] })),
    ).toBe('return_in_progress')
  })

  it('33. return_to_seller safe label', () => {
    expect(sellerSafeCaseLabel('return_to_seller')).toBe('Return in progress')
  })

  it('34. action_required status counts as open for attention', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'consignment_expiration', status: 'action_required' }] }),
      ),
    ).toBe('expired')
  })

  it('35. cancelled withdrawal case does not trigger attention', () => {
    expect(
      deriveAttentionStatus(
        baseInput({ openCases: [{ caseType: 'seller_withdrawal', status: 'cancelled' }] }),
      ),
    ).toBe('none')
  })
})

// ─── Post-sale cases (36-43) ──────────────────────────────────────────────────────

describe('post-sale cases reconciliation', () => {
  it('36. open dispute + eligible unbatched line → suggest_hold', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'open' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'suggest_hold')).toBe(true)
  })

  it('37. open return + eligible unbatched line → suggest_hold', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_return', status: 'open' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'suggest_hold')).toBe(true)
  })

  it('38. no suggest_hold when the eligible line is already held', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'open' }],
        payoutLines: [{ id: 'l1', status: 'held', payoutId: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'suggest_hold')).toBe(false)
  })

  it('39. open case + draft payout line → action_required_draft_payout', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'open' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: 'p1', payout: { status: 'draft' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'action_required_draft_payout')).toBe(true)
  })

  it('40. open case + approved payout → critical', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'open' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: 'p1', payout: { status: 'approved' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'critical_approved_payout' && w.severity === 'critical')).toBe(true)
  })

  it('41. open case + paid payout → critical', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'action_required' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: 'p1', payout: { status: 'paid' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'critical_paid_payout' && w.severity === 'critical')).toBe(true)
  })

  it('42. buyer_dispute safe label', () => {
    expect(sellerSafeCaseLabel('buyer_dispute')).toBe('Payment under review')
  })

  it('43. buyer_return safe label', () => {
    expect(sellerSafeCaseLabel('buyer_return')).toBe('Return in progress')
  })
})

// ─── Case lifecycle (44-50) ──────────────────────────────────────────────────────

describe('case lifecycle reconciliation', () => {
  it('44. resolved case + held line → suggest_release', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'resolved' }],
        payoutLines: [{ id: 'l1', status: 'held', payoutId: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'suggest_release')).toBe(true)
  })

  it('45. resolved case with no held line → no suggest_release', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'resolved' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'suggest_release')).toBe(false)
  })

  it('46. returned item with active listing → returned_item_active_listing', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [
          { id: 'c1', caseType: 'buyer_return', status: 'resolved', returnedAt: new Date('2026-06-01'), itemInstanceId: 'item_1' },
        ],
        items: [{ id: 'item_1', status: 'available', listing: { status: 'active' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'returned_item_active_listing')).toBe(true)
  })

  it('47. returned item with archived listing → no warning', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [
          { id: 'c1', caseType: 'buyer_return', status: 'resolved', returnedAt: new Date('2026-06-01'), itemInstanceId: 'item_1' },
        ],
        items: [{ id: 'item_1', status: 'not_for_sale', listing: { status: 'archived' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'returned_item_active_listing')).toBe(false)
  })

  it('48. return case resolved without returnedAt → warning', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_return', status: 'resolved', returnedAt: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'return_resolved_without_returned_at')).toBe(true)
  })

  it('49. return_to_seller resolved without returnedAt → warning', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'return_to_seller', status: 'resolved', returnedAt: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'return_resolved_without_returned_at')).toBe(true)
  })

  it('50. resolved return with returnedAt → no return_resolved_without_returned_at', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_return', status: 'resolved', returnedAt: new Date('2026-06-01') }],
      }),
    )
    expect(warnings.some((w) => w.code === 'return_resolved_without_returned_at')).toBe(false)
  })
})

// ─── Reconciliation combinations (51-57) ─────────────────────────────────────────

describe('reconciliation combinations', () => {
  it('51. clean state produces no warnings', () => {
    expect(findLifecycleFinancialWarnings(baseRecon())).toEqual([])
  })

  it('52. cancelled case does not count as open', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'cancelled' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: 'p1', payout: { status: 'approved' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'critical_approved_payout')).toBe(false)
  })

  it('53. multiple warnings can coexist', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_dispute', status: 'open' }],
        payoutLines: [
          { id: 'l1', status: 'eligible', payoutId: null },
          { id: 'l2', status: 'eligible', payoutId: 'p1', payout: { status: 'draft' } },
        ],
      }),
    )
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('54. critical severity present when paid payout under open case', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'lost_or_damaged', status: 'open' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: 'p1', payout: { status: 'paid' } }],
      }),
    )
    expect(warnings.some((w) => w.severity === 'critical')).toBe(true)
  })

  it('55. draft-payout warning does not fire without open case', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: 'p1', payout: { status: 'draft' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'action_required_draft_payout')).toBe(false)
  })

  it('56. suggest_hold requires an open dispute/return specifically', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'lost_or_damaged', status: 'open' }],
        payoutLines: [{ id: 'l1', status: 'eligible', payoutId: null }],
      }),
    )
    expect(warnings.some((w) => w.code === 'suggest_hold')).toBe(false)
  })

  it('57. returned item warning skipped when itemInstanceId not linked', () => {
    const warnings = findLifecycleFinancialWarnings(
      baseRecon({
        cases: [{ id: 'c1', caseType: 'buyer_return', status: 'resolved', returnedAt: new Date(), itemInstanceId: null }],
        items: [{ id: 'item_1', status: 'available', listing: { status: 'active' } }],
      }),
    )
    expect(warnings.some((w) => w.code === 'returned_item_active_listing')).toBe(false)
  })
})

// ─── Privacy (58-62) ─────────────────────────────────────────────────────────────

describe('privacy of seller-facing surfaces', () => {
  it('58. every case type maps to a seller-safe label (no raw internal type leaks)', () => {
    for (const key of Object.keys(CASE_TYPE_LABELS)) {
      const label = sellerSafeCaseLabel(key)
      expect(label).not.toContain('_')
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('59. unknown case type falls back to a safe generic label', () => {
    expect(sellerSafeCaseLabel('some_internal_secret')).toBe('Issue under review')
  })

  it('60. sellerView timeline never exposes adminDescription', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        persistedEvents: [
          {
            eventKey: 'k:1',
            eventType: 'e',
            sellerTitle: 'T',
            sellerDescription: 'D',
            adminDescription: 'internal only',
            sellerVisible: true,
            occurredAt: new Date('2026-01-02'),
          },
        ],
      }),
      { sellerView: true },
    )
    expect(events.every((e) => e.adminDescription === null)).toBe(true)
  })

  it('61. sellerView excludes events flagged not seller-visible', () => {
    const events = buildSellerLifecycleTimeline(
      baseTimeline({
        persistedEvents: [
          {
            eventKey: 'k:hidden',
            eventType: 'internal_event',
            sellerTitle: null,
            sellerDescription: null,
            adminDescription: 'hidden',
            sellerVisible: false,
            occurredAt: new Date('2026-01-02'),
          },
        ],
      }),
      { sellerView: true },
    )
    expect(events.some((e) => e.eventType === 'internal_event')).toBe(false)
  })

  it('62. attention labels are human-readable (no snake_case leak)', () => {
    for (const label of Object.values(ATTENTION_LABELS)) {
      expect(label).not.toContain('_')
    }
  })
})

// ─── Milestone 12C-G-F review coverage (63-79) ───────────────────────────────────
// A subset of behaviours in the server actions cannot run without a database, so
// they are verified structurally against the action source. The static source is
// read once and asserted on — this locks in the safety-critical invariants.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const lifecycleSource = readFileSync(
  join(__dir, '..', 'actions', 'sellerLifecycle.ts'),
  'utf-8',
)
const ordersSource = readFileSync(join(__dir, '..', 'actions', 'orders.ts'), 'utf-8')

function actionBody(source: string, fnName: string): string {
  const start = source.indexOf(`export async function ${fnName}`)
  if (start === -1) throw new Error(`function ${fnName} not found`)
  const nextExport = source.indexOf('\nexport async function ', start + 1)
  return source.slice(start, nextExport === -1 ? undefined : nextExport)
}

describe('12C-G-F: intake rejection case defaults', () => {
  const body = actionBody(lifecycleSource, 'rejectSellerIntake')

  it('63. intake_rejection case is created with action_required, not resolved', () => {
    expect(body).toContain("caseType: 'intake_rejection'")
    expect(body).toContain("status: 'action_required'")
    // The intake_rejection case block must not force an immediate resolution.
    expect(body).not.toContain("status: 'resolved'")
  })

  it('64. intake rejection is not auto-resolved (no resolvedAt on the case create)', () => {
    // resolvedAt must not be set when the rejection case is opened.
    const caseCreateIdx = body.indexOf("caseType: 'intake_rejection'")
    const nearby = body.slice(caseCreateIdx, caseCreateIdx + 400)
    expect(nearby).not.toContain('resolvedAt')
  })

  it('65. duplicate intake rejection does not create a second case (existence check)', () => {
    expect(body).toContain('findFirst')
    expect(body).toContain("caseType: 'intake_rejection'")
    expect(body).toMatch(/if \(existingCase\)/)
  })
})

describe('12C-G-F: withdrawal validation', () => {
  const body = actionBody(lifecycleSource, 'recordSellerWithdrawal')

  it('66. withdrawal blocks reserved items', () => {
    expect(body).toContain("item.status === 'reserved'")
    expect(body).toContain('active buyer order')
  })

  it('67. withdrawal blocks sold items', () => {
    expect(body).toContain("item.status === 'sold'")
  })

  it('68. withdrawal archives an active listing and opens an OPEN return_to_seller case', () => {
    expect(body).toContain("status: 'archived'")
    expect(body).toContain("caseType: 'return_to_seller'")
    expect(body).toContain("status: 'open'")
    // Withdrawal must not immediately mark the physical return complete.
    const returnCaseIdx = body.indexOf("caseType: 'return_to_seller'")
    const nearby = body.slice(returnCaseIdx, returnCaseIdx + 300)
    expect(nearby).not.toContain('returnedAt')
  })
})

describe('12C-G-F: physical return', () => {
  const body = actionBody(lifecycleSource, 'markSellerItemReturned')

  it('69. physical return runs in a transaction and archives the listing', () => {
    expect(body).toContain('prisma.$transaction')
    expect(body).toContain("status: 'archived'")
    expect(body).toContain('listing.updateMany')
  })

  it('70. physical return sets item not_for_sale and resolves the case', () => {
    expect(body).toContain("status: 'not_for_sale'")
    expect(body).toContain('returnedAt')
    expect(body).toContain("status: 'resolved'")
  })

  it('71. physical return cannot be recorded twice (returnedAt guard)', () => {
    expect(body).toContain('lifecycleCase.returnedAt')
    expect(body).toContain('already marked as returned')
  })
})

describe('12C-G-F: post-sale payout safeguards', () => {
  const body = actionBody(lifecycleSource, 'openPostSaleSellerCase')

  it('72. eligible unbatched line is held (not draft/approved/paid touched)', () => {
    expect(body).toContain("line.status === 'eligible' && !line.payoutId")
    expect(body).toContain("status: 'held'")
    expect(body).toContain('heldAt')
  })

  it('73. already-held line is left in place (no overwrite branch)', () => {
    expect(body).toContain("line.status === 'held'")
    expect(body).toContain('Leave existing hold in place')
  })

  it('74. draft payout line is NOT auto-removed — only flagged action_required', () => {
    expect(body).toContain("payoutStatus === 'draft'")
    expect(body).toContain("caseStatus = 'action_required'")
    expect(body).not.toContain('sellerPayoutLine.delete')
    expect(body).not.toMatch(/payoutLine\.update[\s\S]{0,120}payoutId: null/)
  })

  it('75. approved payout is NOT reversed — only a critical warning is recorded', () => {
    expect(body).toContain("payoutStatus === 'approved'")
    expect(body).toContain('CRITICAL')
    expect(body).not.toContain('approvedAt: null')
  })

  it('76. paid payout fields are unchanged — no paidAt/paymentReference mutation', () => {
    expect(body).toContain("payoutStatus === 'paid'")
    expect(body).not.toContain('paidAt: null')
    expect(body).not.toContain('paymentReference')
    // No negative payout line is created.
    expect(body).not.toMatch(/netAmount:\s*-/)
  })

  it('77. resolve/cancel case actions never release holds or reverse payouts', () => {
    const resolveBody = actionBody(lifecycleSource, 'resolveSellerLifecycleCase')
    const cancelBody = actionBody(lifecycleSource, 'cancelSellerLifecycleCase')
    for (const b of [resolveBody, cancelBody]) {
      expect(b).not.toContain('sellerPayoutLine.update')
      expect(b).not.toContain('sellerPayout.update')
      expect(b).not.toContain('order.update')
      expect(b).not.toContain('refund')
    }
  })
})

describe('12C-G-F: order completion event isolation', () => {
  it('78. lifecycle event emission is outside the completion transaction and non-blocking', () => {
    // Scope to the order-completion branch.
    const completeIdx = ordersSource.indexOf("status === 'complete'")
    expect(completeIdx).toBeGreaterThan(-1)
    const completionScope = ordersSource.slice(completeIdx)
    const txIdx = completionScope.indexOf('prisma.$transaction')
    // The call to ensureSellerLifecycleEvent (not the import) inside this branch.
    const eventCallIdx = completionScope.indexOf('await ensureSellerLifecycleEvent')
    expect(txIdx).toBeGreaterThan(-1)
    expect(eventCallIdx).toBeGreaterThan(-1)
    // Event emission occurs after the transaction block closes.
    const txEndIdx = completionScope.indexOf('})', txIdx)
    expect(eventCallIdx).toBeGreaterThan(txEndIdx)
    // Event emission is wrapped in try/catch so a failure cannot roll back the order.
    const sliceAround = completionScope.slice(eventCallIdx - 500, eventCallIdx + 200)
    expect(sliceAround).toContain('try {')
    expect(ordersSource).toContain('lifecycle event generation failed')
  })
})

describe('12C-G-F: cross-seller safety and signed-out access', () => {
  it('79. openPostSaleSellerCase rejects order items from a different submission', () => {
    const body = actionBody(lifecycleSource, 'openPostSaleSellerCase')
    expect(body).toContain('agreement.submissionId !== sellerSubmissionId')
    expect(body).toContain('does not belong to the given seller submission')
  })

  it('80. signed-out /account/sell renders the access form, never notFound', () => {
    const sellPageSource = readFileSync(
      join(__dir, '..', '..', 'app', '(store)', 'account', 'sell', 'page.tsx'),
      'utf-8',
    )
    // No session → BuyerOrderAccessForm is returned; there is no notFound() path.
    expect(sellPageSource).toContain('if (!session)')
    expect(sellPageSource).toContain('BuyerOrderAccessForm')
    expect(sellPageSource).not.toContain('notFound')
  })
})
