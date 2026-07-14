import { describe, it, expect } from 'vitest'
import { normalizeEmail } from '@/lib/normalizeEmail'

describe('normalizeEmail', () => {
  it('lowercases input', () => {
    expect(normalizeEmail('USER@EXAMPLE.COM')).toBe('user@example.com')
  })

  it('trims leading whitespace', () => {
    expect(normalizeEmail('   user@example.com')).toBe('user@example.com')
  })

  it('trims trailing whitespace', () => {
    expect(normalizeEmail('user@example.com   ')).toBe('user@example.com')
  })

  it('trims and lowercases together', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com')
  })

  it('preserves + tags', () => {
    expect(normalizeEmail('User+Tag@Example.COM')).toBe('user+tag@example.com')
  })

  it('returns empty string for empty input', () => {
    expect(normalizeEmail('')).toBe('')
  })
})
