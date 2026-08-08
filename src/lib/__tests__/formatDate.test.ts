import { describe, it, expect } from 'vitest'
import { formatDate } from '@/lib/formatDate'

// Regression coverage for the production /market crash:
// "TypeError: a.soldAt.toLocaleDateString is not a function" — soldAt crossed the
// unstable_cache JSON serialization boundary and arrived as a string at runtime,
// while SoldCard called .toLocaleDateString() directly on it, assuming a Date.

describe('formatDate', () => {
  it('formats an ISO string (the actual production runtime shape of soldAt after unstable_cache)', () => {
    const result = formatDate('2026-08-08T15:30:00.000Z', { month: 'short', day: 'numeric', year: 'numeric' })
    expect(result).toBe('Aug 8, 2026')
  })

  it('formats a Date object (the shape before crossing the cache boundary / on a cache miss)', () => {
    const result = formatDate(new Date('2026-08-08T15:30:00.000Z'), { month: 'short', day: 'numeric', year: 'numeric' })
    expect(result).toBe('Aug 8, 2026')
  })

  it('is safe for null', () => {
    expect(formatDate(null)).toBe('')
  })

  it('is safe for undefined', () => {
    expect(formatDate(undefined)).toBe('')
  })

  it('does not throw and returns empty string for a malformed date string', () => {
    expect(() => formatDate('not-a-date')).not.toThrow()
    expect(formatDate('not-a-date')).toBe('')
  })

  it('does not throw and returns empty string for an empty string', () => {
    expect(formatDate('')).toBe('')
  })

  it('formats without explicit options using the default locale date format', () => {
    const result = formatDate('2026-08-08T15:30:00.000Z')
    expect(result).not.toBe('')
    expect(() => formatDate('2026-08-08T15:30:00.000Z')).not.toThrow()
  })

  it('a value that survives a JSON round-trip (simulating an unstable_cache read) still formats correctly', () => {
    const original = { soldAt: new Date('2026-08-08T15:30:00.000Z') }
    const serialized = JSON.parse(JSON.stringify(original)) as { soldAt: string }
    expect(typeof serialized.soldAt).toBe('string')
    expect(formatDate(serialized.soldAt, { month: 'short', day: 'numeric', year: 'numeric' })).toBe('Aug 8, 2026')
  })
})
