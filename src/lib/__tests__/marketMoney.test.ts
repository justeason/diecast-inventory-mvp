// 22B §13/§59: the one conversion boundary between stored dollars and canonical
// integer cents. Locks exact rounding behavior for both storage shapes.
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { internalPriceToCents, externalPriceToCents } from '@/lib/marketMoney'

describe('internalPriceToCents — Float dollars -> integer cents', () => {
  it('converts whole dollars', () => {
    expect(internalPriceToCents(10)).toBe(1000)
  })
  it('converts exact cents', () => {
    expect(internalPriceToCents(10.01)).toBe(1001)
  })
  it('converts sub-dollar amounts', () => {
    expect(internalPriceToCents(0.99)).toBe(99)
  })
  it('is stable for a classic float-imprecision-prone value (19.99)', () => {
    expect(internalPriceToCents(19.99)).toBe(1999)
  })
  it('is stable for another float-imprecision-prone value (0.1 + 0.2 style)', () => {
    expect(internalPriceToCents(4.35)).toBe(435)
  })
  it('never returns a non-integer', () => {
    expect(Number.isInteger(internalPriceToCents(19.99))).toBe(true)
    expect(Number.isInteger(internalPriceToCents(0.1))).toBe(true)
  })
})

describe('externalPriceToCents — Decimal dollars -> integer cents', () => {
  it('converts a plain 2dp Decimal', () => {
    expect(externalPriceToCents(new Prisma.Decimal('10.00'))).toBe(1000)
  })
  it('converts a Decimal with >2 decimal places, rounding half-up', () => {
    expect(externalPriceToCents(new Prisma.Decimal('19.995'))).toBe(2000)
    expect(externalPriceToCents(new Prisma.Decimal('19.994'))).toBe(1999)
  })
  it('4-decimal-place Decimal (schema max precision) rounds correctly', () => {
    expect(externalPriceToCents(new Prisma.Decimal('12.3456'))).toBe(1235)
    expect(externalPriceToCents(new Prisma.Decimal('12.3449'))).toBe(1234)
  })
  it('never returns a non-integer', () => {
    expect(Number.isInteger(externalPriceToCents(new Prisma.Decimal('9.999')))).toBe(true)
  })
})

describe('internal vs external agree on the same dollar amount (apples-to-apples)', () => {
  it('$10.00 internal and external both normalize to 1000 cents', () => {
    expect(internalPriceToCents(10)).toBe(externalPriceToCents(new Prisma.Decimal('10.00')))
  })
})
