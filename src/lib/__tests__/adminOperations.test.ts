// 15H: pure logic tests for adminOperations.ts — attention-band priority ordering
// and the deliberately-not-a-total "open attention signals" count (Part C section 9).
import { describe, it, expect } from 'vitest'
import {
  attentionBand,
  sortByAttentionBand,
  activeAttentionItems,
  openAttentionSignalCount,
  type AttentionItem,
} from '@/lib/adminOperations'

function item(code: AttentionItem['code'], count: number | null): AttentionItem {
  return { code, label: code, count, href: `/admin/${code}` }
}

describe('attentionBand (Part K section 35) — deterministic, never a numeric score', () => {
  it('bands critical commercial/financial signals as critical', () => {
    expect(attentionBand('pending_approvals')).toBe('critical')
  })

  it('bands operational blockers as operational', () => {
    expect(attentionBand('intake_exceptions')).toBe('operational')
    expect(attentionBand('shipment_discrepancies')).toBe('operational')
    expect(attentionBand('portfolio_issues')).toBe('operational')
  })

  it('bands data-quality signals as data_quality', () => {
    expect(attentionBand('inventory_contradictions')).toBe('data_quality')
  })
})

describe('sortByAttentionBand', () => {
  it('orders critical before operational before data_quality, preserving input order within a band', () => {
    const items = [
      item('inventory_contradictions', null),
      item('intake_exceptions', 3),
      item('pending_approvals', 2),
      item('shipment_discrepancies', 1),
      item('portfolio_issues', null),
    ]
    const sorted = sortByAttentionBand(items)
    expect(sorted.map((i) => i.code)).toEqual([
      'pending_approvals', // critical
      'intake_exceptions', 'shipment_discrepancies', 'portfolio_issues', // operational, input order preserved
      'inventory_contradictions', // data_quality
    ])
  })

  it('does not mutate the input array', () => {
    const items = [item('inventory_contradictions', null), item('pending_approvals', 1)]
    const copy = [...items]
    sortByAttentionBand(items)
    expect(items).toEqual(copy)
  })
})

describe('activeAttentionItems', () => {
  it('keeps items with a nonzero count', () => {
    expect(activeAttentionItems([item('intake_exceptions', 3)])).toHaveLength(1)
  })

  it('keeps link-only items (count === null) — "not available" is never silently dropped', () => {
    expect(activeAttentionItems([item('portfolio_issues', null)])).toHaveLength(1)
  })

  it('drops items with an authoritative zero count', () => {
    expect(activeAttentionItems([item('intake_exceptions', 0)])).toHaveLength(0)
  })
})

describe('openAttentionSignalCount (Part C section 9)', () => {
  it('counts active CATEGORIES, not a sum of per-item counts — never "affected items"', () => {
    const items = [
      item('intake_exceptions', 8), // one category, regardless of its count of 8
      item('pending_approvals', 3),
      item('shipment_discrepancies', 0), // healthy — excluded
      item('portfolio_issues', null), // link-only — still counts as one active signal
    ]
    expect(openAttentionSignalCount(items)).toBe(3)
  })

  it('is zero when every signal is healthy', () => {
    const items = [item('intake_exceptions', 0), item('pending_approvals', 0)]
    expect(openAttentionSignalCount(items)).toBe(0)
  })
})
