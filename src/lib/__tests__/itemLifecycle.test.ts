import { describe, it, expect } from 'vitest'
import {
  deriveItemLifecycleStage,
  detectItemContradictions,
  selectCurrentOrder,
  type ItemLifecycleStageInput,
  type ItemContradictionInput,
} from '@/lib/itemLifecycle'

const BASE: ItemLifecycleStageInput = {
  itemStatus: 'available',
  sourceType: null,
  hasActiveListing: false,
  hasCompletedOrder: false,
  currentOrderStatus: null,
  currentOrderPaymentStatus: null,
  consignmentPayoutSettled: null,
  contradictions: [],
}

describe('deriveItemLifecycleStage', () => {
  it('draft -> processing', () => {
    expect(deriveItemLifecycleStage({ ...BASE, itemStatus: 'draft' })).toBe('processing')
  })

  it('available, no listing -> available', () => {
    expect(deriveItemLifecycleStage({ ...BASE, itemStatus: 'available' })).toBe('available')
  })

  it('available + active listing -> listed', () => {
    expect(deriveItemLifecycleStage({ ...BASE, itemStatus: 'available', hasActiveListing: true })).toBe('listed')
  })

  it('reserved, order not yet paid -> reserved', () => {
    expect(deriveItemLifecycleStage({ ...BASE, itemStatus: 'reserved', currentOrderPaymentStatus: 'unpaid' })).toBe('reserved')
  })

  it('15C-review section 3: reserved + paid -> "paid", never "fulfillment" (no persisted shipping/fulfillment evidence exists)', () => {
    expect(deriveItemLifecycleStage({ ...BASE, itemStatus: 'reserved', currentOrderPaymentStatus: 'paid' })).toBe('paid')
  })

  it('sold + order complete + company-owned -> completed (no payout gating for non-consignment)', () => {
    expect(deriveItemLifecycleStage({
      ...BASE, itemStatus: 'sold', sourceType: 'company_owned', hasCompletedOrder: true,
    })).toBe('completed')
  })

  it('sold + order complete + consignment + payout settled -> completed', () => {
    expect(deriveItemLifecycleStage({
      ...BASE, itemStatus: 'sold', sourceType: 'consignment', hasCompletedOrder: true, consignmentPayoutSettled: true,
    })).toBe('completed')
  })

  it('sold + order complete + consignment + payout OUTSTANDING -> stays "sold", not "completed" (spec worked example)', () => {
    expect(deriveItemLifecycleStage({
      ...BASE, itemStatus: 'sold', sourceType: 'consignment', hasCompletedOrder: true, consignmentPayoutSettled: false,
    })).toBe('sold')
  })

  it('15C-review section 4: not_for_sale with no contradiction -> "inactive", never "completed" (withdrawn/held is not a successful sale)', () => {
    expect(deriveItemLifecycleStage({ ...BASE, itemStatus: 'not_for_sale' })).toBe('inactive')
  })

  it('exception precedence: any contradiction forces "exception" regardless of otherwise-valid state', () => {
    const stage = deriveItemLifecycleStage({
      ...BASE, itemStatus: 'sold', sourceType: 'company_owned', hasCompletedOrder: true,
      contradictions: [{ code: 'x', message: 'test' }],
    })
    expect(stage).toBe('exception')
  })

  it('unrecognized itemStatus never silently guessed -> exception', () => {
    expect(deriveItemLifecycleStage({ ...BASE, itemStatus: 'bogus' })).toBe('exception')
  })
})

describe('detectItemContradictions', () => {
  const CLEAN: ItemContradictionInput = {
    itemStatus: 'available',
    hasActiveListing: false,
    hasCompletedOrderItem: false,
    sourceType: 'consignment',
    hasAnyPayoutLine: true,
    locationId: 'loc1',
    sellerPortfolioId: 'port1',
    agreementPortfolioId: 'port1',
    completedOrderCount: 0,
  }

  it('a normal, consistent item has no contradictions', () => {
    expect(detectItemContradictions(CLEAN)).toEqual([])
  })

  it('flags available status with completed-order evidence', () => {
    const issues = detectItemContradictions({ ...CLEAN, hasCompletedOrderItem: true })
    expect(issues.some(i => i.code === 'available_but_sold_evidence')).toBe(true)
  })

  it('flags sold status with an active listing', () => {
    const issues = detectItemContradictions({ ...CLEAN, itemStatus: 'sold', hasActiveListing: true, hasCompletedOrderItem: true })
    expect(issues.some(i => i.code === 'sold_but_listing_active')).toBe(true)
  })

  it('flags an active listing on an incompatible status (e.g. not_for_sale)', () => {
    const issues = detectItemContradictions({ ...CLEAN, itemStatus: 'not_for_sale', hasActiveListing: true })
    expect(issues.some(i => i.code === 'active_listing_status_mismatch')).toBe(true)
  })

  it('flags a sold consignment item with no payout line after the expected payout point', () => {
    const issues = detectItemContradictions({ ...CLEAN, itemStatus: 'sold', hasCompletedOrderItem: true, hasAnyPayoutLine: false })
    expect(issues.some(i => i.code === 'consignment_sold_missing_payout')).toBe(true)
  })

  it('does not flag missing payout for a sold BUYOUT item (payout already settled at intake, unrelated to this sale)', () => {
    const issues = detectItemContradictions({ ...CLEAN, itemStatus: 'sold', sourceType: 'buyout', hasCompletedOrderItem: true, hasAnyPayoutLine: false })
    expect(issues.some(i => i.code === 'consignment_sold_missing_payout')).toBe(false)
  })

  it('flags a sellable item (available/reserved) with no storage location', () => {
    const issues = detectItemContradictions({ ...CLEAN, locationId: null })
    expect(issues.some(i => i.code === 'missing_storage_location')).toBe(true)
  })

  it('does not flag missing storage for a sold item (may have shipped out)', () => {
    const issues = detectItemContradictions({ ...CLEAN, itemStatus: 'sold', hasCompletedOrderItem: true, locationId: null })
    expect(issues.some(i => i.code === 'missing_storage_location')).toBe(false)
  })

  it('flags a portfolio/agreement lineage mismatch', () => {
    const issues = detectItemContradictions({ ...CLEAN, agreementPortfolioId: 'port-DIFFERENT' })
    expect(issues.some(i => i.code === 'portfolio_agreement_mismatch')).toBe(true)
  })

  it('does not flag a portfolio mismatch when there is no agreement at all (agreementPortfolioId undefined)', () => {
    const issues = detectItemContradictions({ ...CLEAN, agreementPortfolioId: undefined })
    expect(issues.some(i => i.code === 'portfolio_agreement_mismatch')).toBe(false)
  })

  it('does not flag a portfolio mismatch when the item has no portfolio at all', () => {
    const issues = detectItemContradictions({ ...CLEAN, sellerPortfolioId: null, agreementPortfolioId: 'some-other' })
    expect(issues.some(i => i.code === 'portfolio_agreement_mismatch')).toBe(false)
  })

  // 15C-review section 5: a completely normal lifecycle, at every valid stage, must
  // produce zero false exception reasons.
  it('a normal intake -> available -> listed item has no contradictions', () => {
    expect(detectItemContradictions({
      itemStatus: 'available', hasActiveListing: true, hasCompletedOrderItem: false,
      sourceType: 'consignment', hasAnyPayoutLine: false, locationId: 'loc1',
      sellerPortfolioId: 'port1', agreementPortfolioId: 'port1', completedOrderCount: 0,
    })).toEqual([])
  })

  it('a normal reserved-but-unpaid item has no contradictions', () => {
    expect(detectItemContradictions({
      itemStatus: 'reserved', hasActiveListing: false, hasCompletedOrderItem: false,
      sourceType: 'consignment', hasAnyPayoutLine: false, locationId: 'loc1',
      sellerPortfolioId: 'port1', agreementPortfolioId: 'port1', completedOrderCount: 0,
    })).toEqual([])
  })

  it('a normal reserved-and-paid item (order not yet complete) has no contradictions — payout is not expected yet', () => {
    expect(detectItemContradictions({
      itemStatus: 'reserved', hasActiveListing: false, hasCompletedOrderItem: false,
      sourceType: 'consignment', hasAnyPayoutLine: false, locationId: 'loc1',
      sellerPortfolioId: 'port1', agreementPortfolioId: 'port1', completedOrderCount: 0,
    })).toEqual([])
  })

  it('a normal sold consignment item WITH its payout line has no contradictions', () => {
    expect(detectItemContradictions({
      itemStatus: 'sold', hasActiveListing: false, hasCompletedOrderItem: true,
      sourceType: 'consignment', hasAnyPayoutLine: true, locationId: 'loc1',
      sellerPortfolioId: 'port1', agreementPortfolioId: 'port1', completedOrderCount: 1,
    })).toEqual([])
  })

  it('a normal buyout/company-owned item has no contradictions at any stage, with no portfolio/agreement at all', () => {
    expect(detectItemContradictions({
      itemStatus: 'sold', hasActiveListing: false, hasCompletedOrderItem: true,
      sourceType: 'company_owned', hasAnyPayoutLine: false, locationId: 'loc1',
      sellerPortfolioId: null, agreementPortfolioId: undefined, completedOrderCount: 1,
    })).toEqual([])
  })

  // 15C-review section 3: one physical item should only sell once.
  it('flags multiple completed sales for the same item', () => {
    const issues = detectItemContradictions({ ...CLEAN, itemStatus: 'sold', hasCompletedOrderItem: true, completedOrderCount: 2 })
    expect(issues.some(i => i.code === 'multiple_completed_sales')).toBe(true)
  })

  it('does not flag a single completed sale', () => {
    const issues = detectItemContradictions({ ...CLEAN, itemStatus: 'sold', hasCompletedOrderItem: true, completedOrderCount: 1 })
    expect(issues.some(i => i.code === 'multiple_completed_sales')).toBe(false)
  })
})

describe('selectCurrentOrder (section 2)', () => {
  const createdAtOf = (o: { createdAt: Date }) => o.createdAt

  it('a single non-cancelled order is current', () => {
    const orders = [{ orderItemId: 'oi1', status: 'pending', createdAt: new Date('2026-01-01') }]
    expect(selectCurrentOrder(orders, createdAtOf)?.orderItemId).toBe('oi1')
  })

  it('cancelled order + active listing scenario: with no other order, there is no current order (item.status independently drives "Available/Listed")', () => {
    const orders = [{ orderItemId: 'oi1', status: 'cancelled', createdAt: new Date('2026-01-01') }]
    expect(selectCurrentOrder(orders, createdAtOf)).toBeNull()
  })

  it('cancelled Order A + active/pending Order B -> state derives from Order B', () => {
    const orders = [
      { orderItemId: 'oiA', status: 'cancelled', createdAt: new Date('2026-01-01') },
      { orderItemId: 'oiB', status: 'pending', createdAt: new Date('2026-02-01') },
    ]
    expect(selectCurrentOrder(orders, createdAtOf)?.orderItemId).toBe('oiB')
  })

  it('cancelled Order A + completed Order B -> the completed order always wins regardless of creation order', () => {
    const orders = [
      { orderItemId: 'oiB', status: 'complete', createdAt: new Date('2026-01-01') },
      { orderItemId: 'oiA', status: 'cancelled', createdAt: new Date('2026-02-01') },
    ]
    expect(selectCurrentOrder(orders, createdAtOf)?.orderItemId).toBe('oiB')
  })

  it('a completed order wins even if a cancelled order was created later (completed = terminal, authoritative)', () => {
    const orders = [
      { orderItemId: 'oiComplete', status: 'complete', createdAt: new Date('2026-01-01') },
      { orderItemId: 'oiLater', status: 'cancelled', createdAt: new Date('2026-03-01') },
    ]
    expect(selectCurrentOrder(orders, createdAtOf)?.orderItemId).toBe('oiComplete')
  })

  it('multiple cancelled + one pending: the pending one is current regardless of position', () => {
    const orders = [
      { orderItemId: 'oi1', status: 'cancelled', createdAt: new Date('2026-01-01') },
      { orderItemId: 'oi2', status: 'cancelled', createdAt: new Date('2026-01-15') },
      { orderItemId: 'oi3', status: 'pending', createdAt: new Date('2026-02-01') },
    ]
    expect(selectCurrentOrder(orders, createdAtOf)?.orderItemId).toBe('oi3')
  })

  it('no orders at all -> null', () => {
    expect(selectCurrentOrder([], createdAtOf)).toBeNull()
  })

  it('deterministic tie-break: two completed orders with identical timestamps resolve by orderItemId', () => {
    const t = new Date('2026-01-01')
    const orders = [
      { orderItemId: 'oiZ', status: 'complete', createdAt: t },
      { orderItemId: 'oiA', status: 'complete', createdAt: t },
    ]
    // sorted by (createdAt, orderItemId) ascending -> 'oiA' sorts first -> found first by .find
    expect(selectCurrentOrder(orders, createdAtOf)?.orderItemId).toBe('oiA')
  })
})
