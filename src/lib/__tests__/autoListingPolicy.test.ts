import { describe, it, expect } from 'vitest'
import { isValidAutoListMinConfidence, isValidPricePositionBps } from '@/lib/autoListingPolicy'

describe('isValidAutoListMinConfidence — only medium/high (Part C section 6)', () => {
  it('accepts medium and high', () => {
    expect(isValidAutoListMinConfidence('medium')).toBe(true)
    expect(isValidAutoListMinConfidence('high')).toBe(true)
  })
  it('rejects low and insufficient — never auto-list from weak confidence', () => {
    expect(isValidAutoListMinConfidence('low')).toBe(false)
    expect(isValidAutoListMinConfidence('insufficient')).toBe(false)
  })
  it('rejects garbage input', () => {
    expect(isValidAutoListMinConfidence('')).toBe(false)
    expect(isValidAutoListMinConfidence('HIGH')).toBe(false)
  })
})

describe('isValidPricePositionBps — [0, 10000] integer only (Part C section 9)', () => {
  it('accepts the boundaries', () => {
    expect(isValidPricePositionBps(0)).toBe(true)
    expect(isValidPricePositionBps(10_000)).toBe(true)
  })
  it('accepts an interior value', () => {
    expect(isValidPricePositionBps(5000)).toBe(true)
  })
  it('rejects negative', () => {
    expect(isValidPricePositionBps(-1)).toBe(false)
  })
  it('rejects > 10000', () => {
    expect(isValidPricePositionBps(10_001)).toBe(false)
  })
  it('rejects non-integers', () => {
    expect(isValidPricePositionBps(50.5)).toBe(false)
  })
})
