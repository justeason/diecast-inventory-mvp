import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  isOwnedSourceType, isConsignmentSourceType, coveragePercent, unitCoverageMetric,
  bucketForAgeDays, ageInDays, decimalFromAggregateSum, OWNED_SOURCE_TYPES,
} from '@/lib/financialPosition'

describe('ownership classification (Part C/4, Part Z/57)', () => {
  it('buyout and company_owned are owned', () => {
    expect(isOwnedSourceType('buyout')).toBe(true)
    expect(isOwnedSourceType('company_owned')).toBe(true)
  })
  it('consignment is never owned', () => {
    expect(isOwnedSourceType('consignment')).toBe(false)
  })
  it('legacy/unknown/null is neither owned nor silently folded in', () => {
    expect(isOwnedSourceType(null)).toBe(false)
    expect(isOwnedSourceType('some_legacy_value')).toBe(false)
  })
  it('isConsignmentSourceType only matches the exact value', () => {
    expect(isConsignmentSourceType('consignment')).toBe(true)
    expect(isConsignmentSourceType('buyout')).toBe(false)
    expect(isConsignmentSourceType(null)).toBe(false)
  })
  it('OWNED_SOURCE_TYPES is exactly the two proven values, nothing more', () => {
    expect([...OWNED_SOURCE_TYPES].sort()).toEqual(['buyout', 'company_owned'])
  })
})

describe('coveragePercent / unitCoverageMetric — coverage model (Part S/45-46, Part Z/65)', () => {
  it('zero total is unavailable, not 0%', () => {
    expect(coveragePercent(0, 0)).toBeNull()
  })
  it('full coverage rounds to one decimal', () => {
    expect(coveragePercent(3, 3)).toBe(100)
    expect(coveragePercent(1, 3)).toBe(33.3)
  })
  it('unitCoverageMetric returns "available" only at full coverage', () => {
    const m = unitCoverageMetric(new Prisma.Decimal(100), 5, 5, 'n/a')
    expect(m.status).toBe('available')
  })
  it('unitCoverageMetric returns "partial" with exact coverage numbers below full coverage', () => {
    const m = unitCoverageMetric(new Prisma.Decimal(100), 3, 4, 'n/a')
    expect(m).toEqual({ status: 'partial', value: new Prisma.Decimal(100), coveragePct: 75, knownUnits: 3, totalUnits: 4 })
  })
  it('unitCoverageMetric returns "unavailable" for an empty population — never $0', () => {
    const m = unitCoverageMetric(new Prisma.Decimal(0), 0, 0, 'No units.')
    expect(m).toEqual({ status: 'unavailable', reason: 'No units.' })
  })
  it('zero known units over a nonzero population is "partial" at 0% — distinct from "unavailable"', () => {
    const m = unitCoverageMetric(new Prisma.Decimal(0), 0, 10, 'n/a')
    expect(m.status).toBe('partial')
    if (m.status === 'partial') expect(m.coveragePct).toBe(0)
  })
})

describe('owned-inventory aging buckets (Part M/36)', () => {
  it('bucket boundaries are 0-30 / 31-60 / 61-90 / 90+', () => {
    expect(bucketForAgeDays(0)).toBe('0-30')
    expect(bucketForAgeDays(30)).toBe('0-30')
    expect(bucketForAgeDays(31)).toBe('31-60')
    expect(bucketForAgeDays(60)).toBe('31-60')
    expect(bucketForAgeDays(61)).toBe('61-90')
    expect(bucketForAgeDays(90)).toBe('61-90')
    expect(bucketForAgeDays(91)).toBe('90+')
    expect(bucketForAgeDays(10_000)).toBe('90+')
  })
  it('ageInDays computes whole-day differences', () => {
    const since = new Date('2026-01-01T00:00:00Z')
    const asOf = new Date('2026-01-31T00:00:00Z')
    expect(ageInDays(since, asOf)).toBe(30)
  })
})

describe('decimalFromAggregateSum — single controlled conversion, no JS accumulation (Part T/47, Part Z/58)', () => {
  it('null sum -> exact zero, never a crash', () => {
    expect(decimalFromAggregateSum(null).toString()).toBe('0')
  })
  it('preserves awkward cents exactly', () => {
    expect(decimalFromAggregateSum(1234.56).toFixed(2)).toBe('1234.56')
  })
  it('rounds a float-noisy aggregate sum to 2 decimal places deterministically', () => {
    expect(decimalFromAggregateSum(10.1 + 20.2).toFixed(2)).toBe('30.30')
  })
})
