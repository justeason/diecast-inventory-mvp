// 20B: pure unit tests for the relevance-tier building blocks — no Prisma
// mocking needed, these are plain functions over strings/arrays.
import { describe, it, expect } from 'vitest'
import {
  normalizePhrase,
  findCompoundBrandPrefix,
  buildExactOrClauses,
  buildPrefixOrClauses,
} from '@/lib/catalogSearchTiers'

describe('normalizePhrase: §3 conservative normalization only', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizePhrase('  Hot   Wheels  R34  ')).toBe('Hot Wheels R34')
  })

  it('does not lowercase, strip punctuation, or otherwise alter characters', () => {
    expect(normalizePhrase('GT-R')).toBe('GT-R')
    expect(normalizePhrase('Fast & Furious')).toBe('Fast & Furious')
  })
})

describe('findCompoundBrandPrefix: §6/§19/§20', () => {
  const brands = ['Hot Wheels', 'Hot', 'Mini GT', 'Tomica']

  it('decomposes "<brand> <remainder>" with a real whitespace boundary', () => {
    expect(findCompoundBrandPrefix('Hot Wheels R34 Skyline', brands)).toEqual({
      brand: 'Hot Wheels', remainder: 'R34 Skyline',
    })
  })

  it('longest matching brand wins — "Hot" must not shadow "Hot Wheels"', () => {
    const result = findCompoundBrandPrefix('Hot Wheels R34', brands)
    expect(result?.brand).toBe('Hot Wheels')
  })

  it('case-insensitive brand matching', () => {
    expect(findCompoundBrandPrefix('hot wheels r34 skyline', brands)).toEqual({
      brand: 'Hot Wheels', remainder: 'r34 skyline',
    })
  })

  it('requires a whitespace boundary — "Mini GTx" is not a brand+remainder match (no shorter brand present to legitimately match instead)', () => {
    expect(findCompoundBrandPrefix('Mini GTx Skyline', brands)).toBeNull()
  })

  it('empty remainder (brand-only phrase) returns null — stays single-field Exact brand match, not compound', () => {
    expect(findCompoundBrandPrefix('Mini GT', brands)).toBeNull()
    expect(findCompoundBrandPrefix('Mini GT   ', brands)).toBeNull()
  })

  it('remainder is trimmed and whitespace-collapsed', () => {
    expect(findCompoundBrandPrefix('Hot Wheels   R34   Skyline', brands)).toEqual({
      brand: 'Hot Wheels', remainder: 'R34 Skyline',
    })
  })

  it('no match when phrase does not start with any known brand', () => {
    expect(findCompoundBrandPrefix('R34 Skyline', brands)).toBeNull()
  })

  it('empty known-brands list never throws, returns null', () => {
    expect(findCompoundBrandPrefix('Hot Wheels R34', [])).toBeNull()
  })
})

describe('buildExactOrClauses: §5/§6', () => {
  it('single-field equals for name/brand/series only — never color/scale/notes', () => {
    const clauses = buildExactOrClauses('R34 Skyline', null)
    expect(clauses).toContainEqual({ name: { equals: 'R34 Skyline', mode: 'insensitive' } })
    expect(clauses).toContainEqual({ brand: { equals: 'R34 Skyline', mode: 'insensitive' } })
    expect(clauses).toContainEqual({ series: { equals: 'R34 Skyline', mode: 'insensitive' } })
    expect(JSON.stringify(clauses)).not.toMatch(/color|scale|notes/)
  })

  it('adds the compound brand-equals + name-equals-remainder clause when a compound match exists', () => {
    const clauses = buildExactOrClauses('Hot Wheels R34 Skyline', { brand: 'Hot Wheels', remainder: 'R34 Skyline' })
    expect(clauses).toContainEqual({
      AND: [
        { brand: { equals: 'Hot Wheels', mode: 'insensitive' } },
        { name: { equals: 'R34 Skyline', mode: 'insensitive' } },
      ],
    })
  })

  it('no compound clause when compound is null', () => {
    const clauses = buildExactOrClauses('R34 Skyline', null)
    expect(clauses).toHaveLength(3)
  })
})

describe('buildPrefixOrClauses: §7/§8', () => {
  it('single-field startsWith for name/brand/series only', () => {
    const clauses = buildPrefixOrClauses('r34', null)
    expect(clauses).toContainEqual({ name: { startsWith: 'r34', mode: 'insensitive' } })
    expect(clauses).toContainEqual({ brand: { startsWith: 'r34', mode: 'insensitive' } })
    expect(clauses).toContainEqual({ series: { startsWith: 'r34', mode: 'insensitive' } })
  })

  it('adds the compound brand-equals + name-startsWith-remainder clause when compound exists', () => {
    const clauses = buildPrefixOrClauses('Hot Wheels R34', { brand: 'Hot Wheels', remainder: 'R34' })
    expect(clauses).toContainEqual({
      AND: [
        { brand: { equals: 'Hot Wheels', mode: 'insensitive' } },
        { name: { startsWith: 'R34', mode: 'insensitive' } },
      ],
    })
  })
})
