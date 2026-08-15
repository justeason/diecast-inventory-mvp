// 15J: pure-engine tests for evaluateReadyToList. No DB, no mocking — same context
// must always produce the same outcome.
import { describe, it, expect } from 'vitest'
import { evaluateReadyToList, type ReadyToListContext } from '@/lib/readyToList'

function baseCtx(overrides: Partial<ReadyToListContext> = {}): ReadyToListContext {
  return {
    itemStatus: 'available',
    locationId: 'loc1',
    sourceType: 'buyout',
    sellerAgreementId: null,
    agreementStatus: null,
    listingStatus: null,
    completedOrderCount: 0,
    hasOpenReturnCase: false,
    contradictions: [],
    pricing: { estimatedValueCents: 5000, confidenceLevel: 'high', isAskOnly: false },
    ...overrides,
  }
}

describe('evaluateReadyToList — ready', () => {
  it('a valid owned/buyout item is ready', () => {
    const outcome = evaluateReadyToList(baseCtx({ sourceType: 'buyout' }))
    expect(outcome).toMatchObject({ status: 'ready', blockers: [], reviewReasons: [], listingPath: 'create' })
  })

  it('a valid company_owned item is ready', () => {
    const outcome = evaluateReadyToList(baseCtx({ sourceType: 'company_owned' }))
    expect(outcome.status).toBe('ready')
  })

  it('a legacy item with sourceType null (unknown) is ready — no consignment rules forced on it', () => {
    const outcome = evaluateReadyToList(baseCtx({ sourceType: null }))
    expect(outcome.status).toBe('ready')
  })

  it('a valid consignment item with an accepted agreement is ready', () => {
    const outcome = evaluateReadyToList(baseCtx({
      sourceType: 'consignment', sellerAgreementId: 'agr1', agreementStatus: 'accepted',
    }))
    expect(outcome.status).toBe('ready')
  })

  it('an item with an archived listing is ready, via the reactivation path', () => {
    const outcome = evaluateReadyToList(baseCtx({ listingStatus: 'archived' }))
    expect(outcome.status).toBe('ready')
    expect(outcome.listingPath).toBe('reactivate')
  })

  it('an item with no listing at all uses the create path', () => {
    const outcome = evaluateReadyToList(baseCtx({ listingStatus: null }))
    expect(outcome.listingPath).toBe('create')
  })
})

describe('evaluateReadyToList — lifecycle blockers (item_not_available)', () => {
  for (const status of ['draft', 'reserved', 'sold', 'not_for_sale']) {
    it(`blocks status "${status}"`, () => {
      const outcome = evaluateReadyToList(baseCtx({ itemStatus: status }))
      expect(outcome.status).toBe('blocked')
      expect(outcome.blockers.map((b) => b.code)).toContain('item_not_available')
      expect(outcome.blockers[0].message).toContain(status)
    })
  }

  it('an "exception" state is represented via contradictions, not a separate lifecycle code', () => {
    // 15C's deriveItemLifecycleStage returns 'exception' whenever contradictions
    // exist — readyToList reuses the contradictions directly rather than a second
    // 'exception' stage check.
    const outcome = evaluateReadyToList(baseCtx({
      itemStatus: 'available',
      contradictions: [{ code: 'available_but_sold_evidence', message: 'Item status is "available" but a completed order exists for it.' }],
    }))
    expect(outcome.status).toBe('blocked')
    expect(outcome.blockers.map((b) => b.code)).toContain('available_but_sold_evidence')
  })

  it('a non-available item does not also report storage/agreement noise — those checks are gated behind itemStatus === available', () => {
    const outcome = evaluateReadyToList(baseCtx({ itemStatus: 'sold', locationId: null, sourceType: 'consignment', sellerAgreementId: null }))
    expect(outcome.blockers.map((b) => b.code)).toEqual(['item_not_available'])
  })

  // 15J focused-review section 11: this is the formal proof that
  // readyToListQuery.ts's `status: 'available'` DB candidate pre-filter for
  // ready/review_required can never exclude a valid match — for EVERY possible
  // non-'available' status (and any unrecognized garbage value), item_not_available
  // fires unconditionally, so blockers.length is always > 0 and the outcome can
  // never be 'ready' or 'review_required'. Only 'available' items can ever reach
  // either of those statuses.
  it('no item with a non-"available" status can ever be "ready" or "review_required" — proves the DB candidate filter is a safe superset', () => {
    for (const status of ['draft', 'reserved', 'sold', 'not_for_sale', 'completed', 'archived', 'totally-unknown-value']) {
      const outcome = evaluateReadyToList(baseCtx({
        itemStatus: status,
        // Even a context that would otherwise be perfectly eligible...
        locationId: 'loc1', sourceType: 'buyout',
        pricing: { estimatedValueCents: 5000, confidenceLevel: 'high', isAskOnly: false },
      }))
      expect(outcome.status).not.toBe('ready')
      expect(outcome.status).not.toBe('review_required')
      expect(outcome.status).toBe('blocked')
    }
  })
})

describe('evaluateReadyToList — identity', () => {
  it('missing storage blocks an otherwise-eligible available item', () => {
    const outcome = evaluateReadyToList(baseCtx({ locationId: null }))
    expect(outcome.status).toBe('blocked')
    expect(outcome.blockers.map((b) => b.code)).toContain('storage_missing')
  })
})

describe('evaluateReadyToList — listing', () => {
  it('blocks when an active listing already exists', () => {
    const outcome = evaluateReadyToList(baseCtx({ listingStatus: 'active' }))
    expect(outcome.status).toBe('blocked')
    expect(outcome.blockers.map((b) => b.code)).toEqual(['already_listed'])
  })

  it('blocks when the listing is (anomalously) "sold" while item status is still available', () => {
    const outcome = evaluateReadyToList(baseCtx({ listingStatus: 'sold' }))
    expect(outcome.blockers.map((b) => b.code)).toContain('already_listed')
  })

  it('a completed-sale contradiction blocks regardless of what itemStatus claims (section 35 — stronger evidence wins)', () => {
    const outcome = evaluateReadyToList(baseCtx({ itemStatus: 'available', completedOrderCount: 1 }))
    expect(outcome.status).toBe('blocked')
    expect(outcome.blockers.map((b) => b.code)).toContain('completed_sale_exists')
  })

  it('archived listing semantics: not a blocker, produces reactivate path', () => {
    const outcome = evaluateReadyToList(baseCtx({ listingStatus: 'archived' }))
    expect(outcome.blockers).toEqual([])
    expect(outcome.listingPath).toBe('reactivate')
  })
})

describe('evaluateReadyToList — commercial (consignment lineage)', () => {
  it('missing agreement blocks a consignment item', () => {
    const outcome = evaluateReadyToList(baseCtx({ sourceType: 'consignment', sellerAgreementId: null }))
    expect(outcome.blockers.map((b) => b.code)).toContain('agreement_missing')
  })

  it('an unaccepted agreement blocks a consignment item', () => {
    const outcome = evaluateReadyToList(baseCtx({ sourceType: 'consignment', sellerAgreementId: 'agr1', agreementStatus: 'proposed' }))
    expect(outcome.blockers.map((b) => b.code)).toContain('agreement_not_accepted')
  })

  it('portfolio mismatch is caught via the reused 15C contradiction, not a second check', () => {
    const outcome = evaluateReadyToList(baseCtx({
      sourceType: 'consignment', sellerAgreementId: 'agr1', agreementStatus: 'accepted',
      contradictions: [{ code: 'portfolio_agreement_mismatch', message: "This item's portfolio does not match its linked agreement's portfolio." }],
    }))
    expect(outcome.status).toBe('blocked')
    expect(outcome.blockers.map((b) => b.code)).toContain('portfolio_agreement_mismatch')
  })

  it('a valid signed consignment item (agreement accepted) is ready', () => {
    const outcome = evaluateReadyToList(baseCtx({ sourceType: 'consignment', sellerAgreementId: 'agr1', agreementStatus: 'accepted' }))
    expect(outcome.status).toBe('ready')
  })

  it('buyout items are never forced through consignment agreement rules, even with no agreement at all', () => {
    const outcome = evaluateReadyToList(baseCtx({ sourceType: 'buyout', sellerAgreementId: null, agreementStatus: null }))
    expect(outcome.blockers.map((b) => b.code)).not.toContain('agreement_missing')
    expect(outcome.status).toBe('ready')
  })
})

describe('evaluateReadyToList — returns', () => {
  it('an open return-pending case blocks an otherwise-eligible item', () => {
    const outcome = evaluateReadyToList(baseCtx({ hasOpenReturnCase: true }))
    expect(outcome.blockers.map((b) => b.code)).toContain('return_case_open')
  })

  it('no return case present does not block', () => {
    const outcome = evaluateReadyToList(baseCtx({ hasOpenReturnCase: false }))
    expect(outcome.blockers.map((b) => b.code)).not.toContain('return_case_open')
  })
})

describe('evaluateReadyToList — multiple blockers, deterministic', () => {
  it('returns ALL applicable blockers, not just the first one found', () => {
    const outcome = evaluateReadyToList(baseCtx({
      locationId: null, sourceType: 'consignment', sellerAgreementId: null, hasOpenReturnCase: true,
    }))
    expect(outcome.blockers.map((b) => b.code).sort()).toEqual(
      ['agreement_missing', 'return_case_open', 'storage_missing'].sort(),
    )
  })

  it('blocker order is stable across repeated calls with the same context', () => {
    const ctx = baseCtx({ locationId: null, sourceType: 'consignment', sellerAgreementId: null, hasOpenReturnCase: true })
    const a = evaluateReadyToList(ctx).blockers.map((b) => b.code)
    const b = evaluateReadyToList(ctx).blockers.map((b) => b.code)
    expect(a).toEqual(b)
  })

  it('blocker order does not depend on which field was set first in the context object', () => {
    const ctx1 = { ...baseCtx(), locationId: null, hasOpenReturnCase: true }
    const ctx2 = { ...baseCtx(), hasOpenReturnCase: true, locationId: null }
    expect(evaluateReadyToList(ctx1).blockers.map((b) => b.code))
      .toEqual(evaluateReadyToList(ctx2).blockers.map((b) => b.code))
  })

  it('no generic "not_ready" reason ever appears — every blocker has a specific code', () => {
    const outcome = evaluateReadyToList(baseCtx({ itemStatus: 'sold' }))
    for (const b of outcome.blockers) {
      expect(b.code).not.toBe('not_ready')
      expect(b.message.length).toBeGreaterThan(0)
    }
  })

  it('contradictions are listed before 15J\'s own checks (section 35 — stronger evidence first)', () => {
    const outcome = evaluateReadyToList(baseCtx({
      locationId: null,
      contradictions: [{ code: 'multiple_completed_sales', message: 'This item has 2 completed sales — a physical item should only sell once.' }],
    }))
    expect(outcome.blockers[0].code).toBe('multiple_completed_sales')
  })
})

describe('evaluateReadyToList — pricing (Part F)', () => {
  it('high confidence: supported, no review needed', () => {
    const outcome = evaluateReadyToList(baseCtx({ pricing: { estimatedValueCents: 5000, confidenceLevel: 'high', isAskOnly: false } }))
    expect(outcome.status).toBe('ready')
    expect(outcome.pricing).toEqual({ status: 'supported', estimatedValueCents: 5000, confidenceLevel: 'high', isAskOnly: false })
  })

  it('medium confidence: also supported, ready (not just high)', () => {
    const outcome = evaluateReadyToList(baseCtx({ pricing: { estimatedValueCents: 4000, confidenceLevel: 'medium', isAskOnly: false } }))
    expect(outcome.status).toBe('ready')
  })

  it('low confidence: review_required, never a hard blocker', () => {
    const outcome = evaluateReadyToList(baseCtx({ pricing: { estimatedValueCents: 3000, confidenceLevel: 'low', isAskOnly: false } }))
    expect(outcome.status).toBe('review_required')
    expect(outcome.reviewReasons.map((r) => r.code)).toEqual(['pricing_confidence_low'])
    expect(outcome.blockers).toEqual([])
  })

  it('no valuation (insufficient): review_required with pricing_evidence_missing', () => {
    const outcome = evaluateReadyToList(baseCtx({ pricing: { estimatedValueCents: null, confidenceLevel: 'insufficient', isAskOnly: false } }))
    expect(outcome.status).toBe('review_required')
    expect(outcome.reviewReasons.map((r) => r.code)).toEqual(['pricing_evidence_missing'])
  })

  it('ask-only evidence never becomes validated fair value, and does not by itself force review', () => {
    const outcome = evaluateReadyToList(baseCtx({ pricing: { estimatedValueCents: 4500, confidenceLevel: 'high', isAskOnly: true } }))
    expect(outcome.status).toBe('ready')
    expect(outcome.pricing.isAskOnly).toBe(true)
  })

  it('pricing never fabricates a value — null estimatedValueCents stays null through to the outcome', () => {
    const outcome = evaluateReadyToList(baseCtx({ pricing: { estimatedValueCents: null, confidenceLevel: 'insufficient', isAskOnly: false } }))
    expect(outcome.pricing.estimatedValueCents).toBeNull()
  })

  it('pricing.pricing === null (not evaluated, e.g. bulk list scan) reports not_evaluated and never forces review', () => {
    const outcome = evaluateReadyToList(baseCtx({ pricing: null }))
    expect(outcome.pricing.status).toBe('not_evaluated')
    expect(outcome.status).toBe('ready')
  })

  it('a hard blocker always wins over a pricing review reason — status is "blocked", not "review_required"', () => {
    const outcome = evaluateReadyToList(baseCtx({
      locationId: null,
      pricing: { estimatedValueCents: null, confidenceLevel: 'insufficient', isAskOnly: false },
    }))
    expect(outcome.status).toBe('blocked')
    expect(outcome.reviewReasons).toEqual([])
  })

  it('Ready status is independent of 15F listing approval — the engine never inspects any approval state', () => {
    // The context type itself has no approval/risk field at all — this is a static
    // guarantee, verified structurally in readyToListSafety.test.ts. Behaviorally:
    // a fully "ready" context is ready regardless of what 15F would eventually do.
    const outcome = evaluateReadyToList(baseCtx())
    expect(outcome.status).toBe('ready')
  })
})
