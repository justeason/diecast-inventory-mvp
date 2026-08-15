import { describe, it, expect } from 'vitest'
import {
  INTAKE_EXCEPTION_CODES, isKnownExceptionCode, EXCEPTION_LABELS,
  EXCEPTION_CATEGORY, EXCEPTION_CATEGORY_LABELS, categorizeExceptionCode, codesForCategory,
  EXCEPTION_PRIORITY_ORDER, exceptionPriorityRank, compareExceptionPriority,
  openIntakeExceptionWhere, isOpenIntakeException,
  formatExceptionAge, exceptionAgeGroup,
} from '@/lib/intakeExceptions'

describe('exception code catalog (section 1) — only actually-persisted codes', () => {
  it('has exactly the 5 codes confirmed present in actions/intakeWorkbench.ts', () => {
    expect(INTAKE_EXCEPTION_CODES).toEqual(['unknown_model', 'invalid_storage', 'missing_condition', 'unexpected_overage', 'conversion_failed'])
  })

  it('isKnownExceptionCode rejects invented/renamed codes', () => {
    expect(isKnownExceptionCode('unknown_model')).toBe(true)
    expect(isKnownExceptionCode('agreement_mismatch')).toBe(false)
    expect(isKnownExceptionCode('technical_duplicate')).toBe(false)
    expect(isKnownExceptionCode('')).toBe(false)
  })

  it('every code has a label and a category — no gaps', () => {
    for (const c of INTAKE_EXCEPTION_CODES) {
      expect(EXCEPTION_LABELS[c]).toBeTruthy()
      expect(EXCEPTION_CATEGORY[c]).toBeTruthy()
    }
  })
})

describe('exception categories (section 4) — UX grouping only', () => {
  it('data_fixable = unknown_model, invalid_storage, missing_condition', () => {
    expect(codesForCategory('data_fixable').sort()).toEqual(['invalid_storage', 'missing_condition', 'unknown_model'])
  })

  it('retryable = conversion_failed only', () => {
    expect(codesForCategory('retryable')).toEqual(['conversion_failed'])
  })

  it('commercial_blocker = unexpected_overage only — no separate "agreement mismatch" code exists to categorize', () => {
    expect(codesForCategory('commercial_blocker')).toEqual(['unexpected_overage'])
  })

  it('categorizeExceptionCode returns null for an unknown code — never guesses a category', () => {
    expect(categorizeExceptionCode('not_a_real_code')).toBeNull()
  })

  it('every category has a label', () => {
    expect(EXCEPTION_CATEGORY_LABELS.data_fixable).toBeTruthy()
    expect(EXCEPTION_CATEGORY_LABELS.retryable).toBeTruthy()
    expect(EXCEPTION_CATEGORY_LABELS.commercial_blocker).toBeTruthy()
  })
})

describe('deterministic priority (section 8) — never an invented risk score', () => {
  it('priority order is fixed: commercial > conversion failure > unknown model > storage > condition', () => {
    expect(EXCEPTION_PRIORITY_ORDER).toEqual(['unexpected_overage', 'conversion_failed', 'unknown_model', 'invalid_storage', 'missing_condition'])
  })

  it('exceptionPriorityRank is lower (more urgent) for commercial blockers', () => {
    expect(exceptionPriorityRank('unexpected_overage')).toBeLessThan(exceptionPriorityRank('missing_condition'))
  })

  it('compareExceptionPriority sorts by priority first, then oldest first within the same priority', () => {
    const now = new Date('2026-01-10')
    const older = { code: 'missing_condition', createdAt: new Date('2026-01-01') }
    const newer = { code: 'missing_condition', createdAt: new Date('2026-01-05') }
    const commercial = { code: 'unexpected_overage', createdAt: now }
    const sorted = [newer, commercial, older].sort(compareExceptionPriority)
    expect(sorted).toEqual([commercial, older, newer])
  })
})

describe('openIntakeExceptionWhere / isOpenIntakeException — the one exception predicate (section 2)', () => {
  it('predicate requires workbenchExceptionCode set, convertedItemId null, status not rejected', () => {
    expect(openIntakeExceptionWhere()).toEqual({
      workbenchExceptionCode: { not: null }, convertedItemId: null, status: { not: 'rejected' },
    })
  })

  it('a normal open exception draft is included', () => {
    expect(isOpenIntakeException({ workbenchExceptionCode: 'unknown_model', convertedItemId: null, status: 'draft' })).toBe(true)
  })

  it('a converted draft is excluded even if workbenchExceptionCode is still set (historical evidence retained, not re-queued)', () => {
    expect(isOpenIntakeException({ workbenchExceptionCode: 'unknown_model', convertedItemId: 'item1', status: 'converted' })).toBe(false)
  })

  it('a rejected draft is excluded', () => {
    expect(isOpenIntakeException({ workbenchExceptionCode: 'unknown_model', convertedItemId: null, status: 'rejected' })).toBe(false)
  })

  it('a normal (non-exception) draft is excluded', () => {
    expect(isOpenIntakeException({ workbenchExceptionCode: null, convertedItemId: null, status: 'draft' })).toBe(false)
  })
})

describe('age formatting/grouping (section 29) — operational visibility, not an SLA', () => {
  it('formats minutes, hours, and days', () => {
    const now = new Date('2026-01-10T12:00:00Z')
    expect(formatExceptionAge(new Date('2026-01-10T11:48:00Z'), now)).toBe('12 min')
    expect(formatExceptionAge(new Date('2026-01-10T09:00:00Z'), now)).toBe('3 hr')
    expect(formatExceptionAge(new Date('2026-01-08T12:00:00Z'), now)).toBe('2 days')
  })

  it('groups into the four documented buckets', () => {
    const now = new Date('2026-01-10T12:00:00Z')
    expect(exceptionAgeGroup(new Date('2026-01-10T11:50:00Z'), now)).toBe('<1h')
    expect(exceptionAgeGroup(new Date('2026-01-10T00:00:00Z'), now)).toBe('1-24h')
    expect(exceptionAgeGroup(new Date('2026-01-08T12:00:00Z'), now)).toBe('1-3d')
    expect(exceptionAgeGroup(new Date('2026-01-01T12:00:00Z'), now)).toBe('>3d')
  })
})
