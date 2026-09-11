// 20B: pure, DB-free relevance-tier building blocks for /catalog search.
// Kept separate from catalogDiscoveryQuery.ts (the Prisma boundary) so the
// phrase/brand logic is directly unit-testable without mocking Prisma.
import type { Prisma } from '@prisma/client'

// §3: normalization for exact/prefix identity comparison only — trim +
// collapse internal whitespace, nothing else. Broad token search (tokenizeQuery
// in catalogDiscoveryQuery.ts) is untouched and normalized separately.
export function normalizePhrase(q: string): string {
  return q.trim().replace(/\s+/g, ' ')
}

export type CompoundBrandMatch = { brand: string; remainder: string }

// §6/§19: "<known brand> <remainder>" decomposition, reusing the SAME distinct
// brand list /catalog already fetches for its Brand filter dropdown — no new
// query. Longest matching brand wins (so "Hot" never shadows "Hot Wheels").
// Requires a real whitespace boundary right after the brand (not a mid-word
// substring), and a non-empty remainder — a bare brand-only query intentionally
// returns null here so it stays a single-field Exact brand match (§20), never
// a compound match with an empty remainder.
export function findCompoundBrandPrefix(
  normalizedPhrase: string,
  knownBrands: string[],
): CompoundBrandMatch | null {
  const lowerPhrase = normalizedPhrase.toLowerCase()
  let best: CompoundBrandMatch | null = null

  for (const brand of knownBrands) {
    const lowerBrand = brand.toLowerCase()
    if (!lowerBrand || !lowerPhrase.startsWith(lowerBrand)) continue

    const rest = normalizedPhrase.slice(brand.length)
    if (rest.length > 0 && !/^\s/.test(rest)) continue // no whitespace boundary — reject mid-word match

    const remainder = normalizePhrase(rest)
    if (remainder.length === 0) continue // brand-only — not a compound match

    if (!best || brand.length > best.brand.length) {
      best = { brand, remainder }
    }
  }

  return best
}

// §5/§6: Exact tier — single-field identity equals, plus (when a compound
// brand+remainder was found) brand equals AND name equals the remainder.
// color/scale/notes are deliberately excluded — they're modifiers, not identity.
export function buildExactOrClauses(
  normalizedPhrase: string,
  compound: CompoundBrandMatch | null,
): Prisma.CatalogModelWhereInput[] {
  const clauses: Prisma.CatalogModelWhereInput[] = [
    { name: { equals: normalizedPhrase, mode: 'insensitive' } },
    { brand: { equals: normalizedPhrase, mode: 'insensitive' } },
    { series: { equals: normalizedPhrase, mode: 'insensitive' } },
  ]
  if (compound) {
    clauses.push({
      AND: [
        { brand: { equals: compound.brand, mode: 'insensitive' } },
        { name: { equals: compound.remainder, mode: 'insensitive' } },
      ],
    })
  }
  return clauses
}

// §7/§8: Prefix tier — single-field startsWith, plus the compound brand-equals
// + name-startsWith-remainder variant.
export function buildPrefixOrClauses(
  normalizedPhrase: string,
  compound: CompoundBrandMatch | null,
): Prisma.CatalogModelWhereInput[] {
  const clauses: Prisma.CatalogModelWhereInput[] = [
    { name: { startsWith: normalizedPhrase, mode: 'insensitive' } },
    { brand: { startsWith: normalizedPhrase, mode: 'insensitive' } },
    { series: { startsWith: normalizedPhrase, mode: 'insensitive' } },
  ]
  if (compound) {
    clauses.push({
      AND: [
        { brand: { equals: compound.brand, mode: 'insensitive' } },
        { name: { startsWith: compound.remainder, mode: 'insensitive' } },
      ],
    })
  }
  return clauses
}
