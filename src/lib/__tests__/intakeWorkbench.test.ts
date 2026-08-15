import { describe, it, expect } from 'vitest'
import {
  computeWorkbenchProgress,
  evaluateWorkbenchCompletion,
  wouldExceedReceived,
  existingExceptionStillOverage,
  deriveIntakeRiskFlags,
  describeCatalogConfidence,
  isLeaseActive,
  isLeaseHeldByOther,
  DEFAULT_HIGH_VALUE_THRESHOLD_CENTS,
  computeObservedPhysical,
  computeReconciliationVariance,
  isReconciliationCurrent,
  deriveIntakeReconciliationStatus,
} from '@/lib/intakeWorkbench'

describe('computeWorkbenchProgress (section 13/14)', () => {
  it('remaining is null when the shipment has not been marked received (no total to consume against)', () => {
    const p = computeWorkbenchProgress({ expectedQuantity: 100, receivedQuantity: null, processedCount: 5, exceptionCount: 0 })
    expect(p.remaining).toBeNull()
    expect(p.expected).toBe(100)
  })

  it('remaining = received - processed - exceptions, never derived from expectedQuantity', () => {
    const p = computeWorkbenchProgress({ expectedQuantity: 999, receivedQuantity: 120, processedCount: 47, exceptionCount: 3 })
    expect(p.remaining).toBe(70)
    expect(p.expected).toBe(999)
    expect(p.received).toBe(120)
  })

  it('remaining floors at zero — never negative even if processed+exceptions exceeds received (e.g. after an overage exception)', () => {
    const p = computeWorkbenchProgress({ expectedQuantity: 10, receivedQuantity: 10, processedCount: 9, exceptionCount: 3 })
    expect(p.remaining).toBe(0)
  })

  it('processed and exceptions are reported as given, independent of each other', () => {
    const p = computeWorkbenchProgress({ expectedQuantity: 5, receivedQuantity: 5, processedCount: 2, exceptionCount: 1 })
    expect(p.processed).toBe(2)
    expect(p.exceptions).toBe(1)
  })
})

describe('computeWorkbenchProgress — 15E exception resolution interaction (section 24)', () => {
  it('resolving one exception (processed +1, exceptions -1) leaves remaining/observedPhysical unchanged — only the bucket composition shifts', () => {
    const before = computeWorkbenchProgress({ expectedQuantity: 200, receivedQuantity: 200, processedCount: 194, exceptionCount: 3 })
    const after = computeWorkbenchProgress({ expectedQuantity: 200, receivedQuantity: 200, processedCount: 195, exceptionCount: 2 })
    expect(before.remaining).toBe(after.remaining)
    expect(before.processed + before.exceptions).toBe(after.processed + after.exceptions)
  })
})

describe('evaluateWorkbenchCompletion (section 24)', () => {
  it('never complete while the shipment has not been marked received', () => {
    const r = evaluateWorkbenchCompletion({ expected: 100, received: null, processed: 0, exceptions: 0, remaining: null })
    expect(r.complete).toBe(false)
    expect(r.blockedReasons.length).toBeGreaterThan(0)
  })

  it('not complete while processed < received, even with zero exceptions', () => {
    const r = evaluateWorkbenchCompletion({ expected: 120, received: 120, processed: 117, exceptions: 0, remaining: 3 })
    expect(r.complete).toBe(false)
    expect(r.blockedReasons.some((m) => m.includes('3'))).toBe(true)
  })

  it('not complete while any exception is unresolved, even if processed >= received (spec worked example: "117 processed, 3 exceptions, Intake not complete")', () => {
    const r = evaluateWorkbenchCompletion({ expected: 120, received: 120, processed: 117, exceptions: 3, remaining: 0 })
    expect(r.complete).toBe(false)
    expect(r.blockedReasons.some((m) => m.includes('3 unresolved'))).toBe(true)
  })

  it('complete only when received is known, fully processed, and zero exceptions', () => {
    const r = evaluateWorkbenchCompletion({ expected: 120, received: 120, processed: 120, exceptions: 0, remaining: 0 })
    expect(r.complete).toBe(true)
    expect(r.blockedReasons).toEqual([])
  })
})

describe('wouldExceedReceived (section 17)', () => {
  it('never flags overage when the shipment has not been marked received (no total to compare against)', () => {
    expect(wouldExceedReceived(null, 999, 5)).toBe(false)
  })

  it('flags exactly at the boundary: 101st unit against a received total of 100', () => {
    expect(wouldExceedReceived(100, 100, 1)).toBe(true)
  })

  it('does not flag when still within the received total', () => {
    expect(wouldExceedReceived(100, 95, 5)).toBe(false)
  })

  it('is gated on receivedQuantity, never expectedQuantity — a shipment can receive more or less than expected without this ever consulting the seller-declared number', () => {
    // expectedQuantity is not even a parameter — this is a structural guarantee, not
    // just a runtime one. Received=50, already-accounted=48, +3 exceeds 50 -> true.
    expect(wouldExceedReceived(50, 48, 3)).toBe(true)
  })
})

describe('existingExceptionStillOverage (15E-review section 5) — recheck for an EXISTING exception unit being resolved, distinct from wouldExceedReceived (new units)', () => {
  it('never flags overage when the shipment has not been marked received', () => {
    expect(existingExceptionStillOverage(null, 999, 5)).toBe(false)
  })

  it('worked example: received=100, processed=99, exceptions=1 (this draft) — not overage, resolves', () => {
    expect(existingExceptionStillOverage(100, 99, 1)).toBe(false)
  })

  it('worked example: received=100, processed=99, exceptions=2 — a genuine second exception unit is still overage', () => {
    expect(existingExceptionStillOverage(100, 99, 2)).toBe(true)
  })

  it('flags exactly at the boundary and not one under it', () => {
    expect(existingExceptionStillOverage(100, 100, 0)).toBe(false)
    expect(existingExceptionStillOverage(100, 101, 0)).toBe(true)
  })
})

describe('deriveIntakeRiskFlags (section 19 — deterministic, never an invented score)', () => {
  const base = { pricingConfidence: 'high' as const, catalogConfidence: 'exact' as const, estimatedValueCents: 1000, highValueThresholdCents: DEFAULT_HIGH_VALUE_THRESHOLD_CENTS }

  it('no flags when everything is confident and below threshold', () => {
    expect(deriveIntakeRiskFlags(base)).toEqual([])
  })

  it('flags low pricing confidence', () => {
    const flags = deriveIntakeRiskFlags({ ...base, pricingConfidence: 'low' })
    expect(flags.some((f) => f.code === 'pricing_confidence_low')).toBe(true)
  })

  it('flags insufficient pricing confidence the same as low', () => {
    const flags = deriveIntakeRiskFlags({ ...base, pricingConfidence: 'insufficient' })
    expect(flags.some((f) => f.code === 'pricing_confidence_low')).toBe(true)
  })

  it('does not flag medium pricing confidence', () => {
    const flags = deriveIntakeRiskFlags({ ...base, pricingConfidence: 'medium' })
    expect(flags.some((f) => f.code === 'pricing_confidence_low')).toBe(false)
  })

  it('flags low ("possible") catalog confidence only', () => {
    expect(deriveIntakeRiskFlags({ ...base, catalogConfidence: 'possible' }).some((f) => f.code === 'catalog_confidence_low')).toBe(true)
    expect(deriveIntakeRiskFlags({ ...base, catalogConfidence: 'strong' }).some((f) => f.code === 'catalog_confidence_low')).toBe(false)
    expect(deriveIntakeRiskFlags({ ...base, catalogConfidence: 'exact' }).some((f) => f.code === 'catalog_confidence_low')).toBe(false)
  })

  it('flags value at or above the configured threshold, not merely above', () => {
    expect(deriveIntakeRiskFlags({ ...base, estimatedValueCents: DEFAULT_HIGH_VALUE_THRESHOLD_CENTS }).some((f) => f.code === 'high_value')).toBe(true)
    expect(deriveIntakeRiskFlags({ ...base, estimatedValueCents: DEFAULT_HIGH_VALUE_THRESHOLD_CENTS - 1 }).some((f) => f.code === 'high_value')).toBe(false)
  })

  it('a null estimated value never fabricates a high-value flag', () => {
    expect(deriveIntakeRiskFlags({ ...base, estimatedValueCents: null }).some((f) => f.code === 'high_value')).toBe(false)
  })

  it('flags never include an invented numeric risk score field', () => {
    const flags = deriveIntakeRiskFlags({ ...base, pricingConfidence: 'low', catalogConfidence: 'possible', estimatedValueCents: 999999 })
    for (const f of flags) {
      expect(Object.keys(f).sort()).toEqual(['code', 'message'])
    }
  })
})

describe('describeCatalogConfidence', () => {
  it('maps exact/strong/possible to High/Medium/Low', () => {
    expect(describeCatalogConfidence('exact')).toBe('High')
    expect(describeCatalogConfidence('strong')).toBe('Medium')
    expect(describeCatalogConfidence('possible')).toBe('Low')
  })
})

describe('lease helpers (section 21)', () => {
  const now = new Date('2026-06-01T00:00:00Z')

  it('a lease expiring in the future is active', () => {
    expect(isLeaseActive({ claimToken: 'a', expiresAt: new Date('2026-06-01T00:05:00Z') }, now)).toBe(true)
  })

  it('a lease that has already expired is not active — never permanently blocks work', () => {
    expect(isLeaseActive({ claimToken: 'a', expiresAt: new Date('2026-05-31T23:59:00Z') }, now)).toBe(false)
  })

  it('null lease is never active', () => {
    expect(isLeaseActive(null, now)).toBe(false)
  })

  it('held by other only when active AND the claim token differs from mine', () => {
    const lease = { claimToken: 'other-tab', expiresAt: new Date('2026-06-01T00:05:00Z') }
    expect(isLeaseHeldByOther(lease, 'my-tab', now)).toBe(true)
    expect(isLeaseHeldByOther(lease, 'other-tab', now)).toBe(false)
  })

  it('an expired lease is never reported as held by another session', () => {
    const lease = { claimToken: 'other-tab', expiresAt: new Date('2026-05-31T00:00:00Z') }
    expect(isLeaseHeldByOther(lease, 'my-tab', now)).toBe(false)
  })
})

describe('computeObservedPhysical / computeReconciliationVariance (reconciliation pass, section 2)', () => {
  it('observedPhysical = processed + exceptions — every physical unit with evidence, converted or not', () => {
    expect(computeObservedPhysical(194, 3)).toBe(197)
    expect(computeObservedPhysical(0, 0)).toBe(0)
  })

  it('variance is positive for overage, negative for shortage, zero for an exact match', () => {
    expect(computeReconciliationVariance(200, 197)).toBe(-3)
    expect(computeReconciliationVariance(200, 203)).toBe(3)
    expect(computeReconciliationVariance(200, 200)).toBe(0)
  })
})

describe('isReconciliationCurrent (reconciliation pass, section 3)', () => {
  it('is current only when both recordedReceived and observedPhysical exactly match the prior snapshot', () => {
    const current = { recordedReceived: 200, observedPhysical: 197 }
    expect(isReconciliationCurrent({ recordedReceived: 200, observedPhysical: 197 }, current)).toBe(true)
  })

  it('is NOT current when observedPhysical has since changed (e.g. an exception was resolved into a conversion)', () => {
    const current = { recordedReceived: 200, observedPhysical: 198 }
    expect(isReconciliationCurrent({ recordedReceived: 200, observedPhysical: 197 }, current)).toBe(false)
  })

  it('is NOT current when there is no prior snapshot at all', () => {
    expect(isReconciliationCurrent(null, { recordedReceived: 200, observedPhysical: 200 })).toBe(false)
  })
})

describe('deriveIntakeReconciliationStatus (reconciliation pass, section 3) — never "complete" merely from remaining===0', () => {
  it('no current snapshot -> always in_progress, regardless of how close counts are', () => {
    expect(deriveIntakeReconciliationStatus(null)).toBe('in_progress')
  })

  it('a current snapshot with zero variance -> reconciled', () => {
    expect(deriveIntakeReconciliationStatus({ variance: 0 })).toBe('reconciled')
  })

  it('a current snapshot with nonzero variance (shortage or overage) -> reconciled_with_variance, never silently upgraded to plain "reconciled"', () => {
    expect(deriveIntakeReconciliationStatus({ variance: -3 })).toBe('reconciled_with_variance')
    expect(deriveIntakeReconciliationStatus({ variance: 3 })).toBe('reconciled_with_variance')
  })
})
