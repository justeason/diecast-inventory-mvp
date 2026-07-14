import { describe, it, expect } from 'vitest'
import { hashToken } from '@/lib/hashToken'

describe('hashToken', () => {
  it('returns a 64-character string', () => {
    expect(hashToken('abc')).toHaveLength(64)
  })

  it('returns only lowercase hex characters', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic — same input produces same hash', () => {
    expect(hashToken('some-token')).toBe(hashToken('some-token'))
  })

  it('produces different hashes for different inputs', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'))
  })

  it('matches known SHA-256 value for "abc"', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})
