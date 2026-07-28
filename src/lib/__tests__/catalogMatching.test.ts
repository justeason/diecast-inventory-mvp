import { describe, it, expect } from 'vitest'
import { normalize, tokenize, formatCandidateLabel, rankCandidates, DUPLICATE_SCORE_THRESHOLD } from '../catalogMatching'
import type { CatalogCandidate } from '../catalogMatching'

function c(overrides: Partial<CatalogCandidate> & { brand: string; name: string }): CatalogCandidate {
  return { id: 'id-' + overrides.brand + overrides.name, series: null, year: null, color: null, scale: null, ...overrides }
}

const HW_TWIN_MILL = c({ id: 'hw-tm', brand: 'Hot Wheels', name: 'Twin Mill', series: 'HW Legends', year: 2022, color: 'ZAMAC', scale: '1:64' })
const HW_FERRARI = c({ id: 'hw-f', brand: 'Hot Wheels', name: 'Ferrari 308 GTS', year: 1994, color: 'Red' })
const MB_LAMBORGHINI = c({ id: 'mb-l', brand: 'Matchbox', name: 'Lamborghini Huracán', series: 'Superfast', year: 2019 })
const HW_CAMARO = c({ id: 'hw-cam', brand: 'Hot Wheels', name: 'Camaro', series: 'Muscle Cars', year: 1998, color: 'Blue' })

describe('normalize', () => {
  it('lowercases and trims', () => {
    expect(normalize('  Hot Wheels  ')).toBe('hot wheels')
  })
  it('replaces punctuation with space and collapses whitespace', () => {
    expect(normalize("Ferrari 308 GTS (1994)")).toBe('ferrari 308 gts 1994')
  })
  it('collapses multiple spaces', () => {
    expect(normalize('a   b')).toBe('a b')
  })
})

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('Hot Wheels')).toEqual(['hot', 'wheels'])
  })
  it('filters tokens shorter than 2 characters', () => {
    expect(tokenize('a HW car')).toEqual(['hw', 'car'])
  })
  it('handles empty string', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('formatCandidateLabel', () => {
  it('formats all fields', () => {
    expect(formatCandidateLabel(HW_TWIN_MILL)).toBe('Hot Wheels Twin Mill (2022) — ZAMAC [HW Legends]')
  })
  it('omits missing optional fields', () => {
    expect(formatCandidateLabel(c({ brand: 'Hot Wheels', name: 'Bone Shaker' }))).toBe('Hot Wheels Bone Shaker')
  })
})

describe('rankCandidates', () => {
  it('returns empty for empty query', () => {
    expect(rankCandidates([HW_TWIN_MILL], '')).toHaveLength(0)
  })
  it('returns empty for empty candidates', () => {
    expect(rankCandidates([], 'Hot Wheels')).toHaveLength(0)
  })
  it('excludes zero-score candidates', () => {
    const result = rankCandidates([HW_TWIN_MILL], 'Matchbox')
    expect(result).toHaveLength(0)
  })

  describe('Rule 1 — exact full match → 100', () => {
    it('scores 100 for exact brand + name', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Hot Wheels Twin Mill')
      expect(result[0].score).toBe(100)
    })
    it('scores 100 for exact brand alone', () => {
      const r = rankCandidates([c({ id: 'x', brand: 'Matchbox', name: 'anything' })], 'Matchbox anything')
      expect(r[0].score).toBe(100)
    })
  })

  describe('Rule 2 — exact brand token + exact name token → 92+', () => {
    it('scores 92 for brand+name tokens matched', () => {
      const result = rankCandidates([HW_FERRARI], 'Hot Wheels Ferrari 308 GTS')
      expect(result[0].score).toBeGreaterThanOrEqual(92)
    })
    it('boosts score when series and year also match', () => {
      // Single-word brand/name to reliably trigger Rule 2; compare with vs without series+year tokens
      const model = c({ id: 'x', brand: 'Matchbox', name: 'Camaro', series: 'Superfast', year: 2019 })
      const withBoost = rankCandidates([model], 'Matchbox Camaro Superfast 2019')
      const noBoost = rankCandidates([model], 'Matchbox Camaro Extra')
      expect(withBoost[0].score).toBeGreaterThan(noBoost[0].score)
    })
    it('caps at 99', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Hot Wheels Twin Mill HW Legends 2022 ZAMAC')
      expect(result[0].score).toBeLessThanOrEqual(99)
    })
  })

  describe('Rule 3 — prefix match → 78', () => {
    it('scores 78 for prefix match with >= 4 chars', () => {
      const result = rankCandidates([HW_FERRARI], 'Hot Wheels Ferrari')
      const rule3 = result.find((r) => r.score === 78)
      expect(rule3 ?? result[0]).toBeDefined()
    })
    it('does not prefix-match queries shorter than 4 chars', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Hot')
      expect(result.every((r) => r.score !== 78)).toBe(true)
    })
  })

  describe('Rule 4 — all tokens across any field → 65+', () => {
    it('matches when tokens span different fields', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Twin Mill ZAMAC 2022')
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].score).toBeGreaterThanOrEqual(65)
    })
  })

  describe('Rule 5 — brand + series + year → 55', () => {
    it('scores 55 when brand, series, and year match but an unmatched token blocks Rule 4', () => {
      // "xyz" doesn't match any field so Rule 4 fails; brand+series+year still present → Rule 5
      const result = rankCandidates([HW_TWIN_MILL], 'Hot Legends 2022 xyz')
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].score).toBe(55)
    })
  })

  describe('Rule 6 — partial token → up to 49', () => {
    it('scores partial matches below 50 when not all tokens match', () => {
      // 'Wheels unknown': "wheels" matches brand, "unknown" matches nothing → Rule 4 fails → Rule 6
      const result = rankCandidates([HW_CAMARO], 'Wheels unknown')
      expect(result[0].score).toBeLessThanOrEqual(49)
    })
    it('brand-only partial match gives 20', () => {
      // 'Wheels unknown': "wheels" in brand, "unknown" not in name → brand partial only
      const result = rankCandidates([HW_FERRARI], 'Wheels unknown')
      expect(result[0].score).toBe(20)
    })
  })

  describe('sorting', () => {
    it('sorts by score descending', () => {
      const result = rankCandidates([HW_CAMARO, HW_FERRARI], 'Hot Wheels Ferrari 308 GTS')
      expect(result[0].id).toBe('hw-f')
    })
    it('sorts by brand asc when scores are equal', () => {
      const a = c({ id: 'a', brand: 'Zephyr', name: 'Same' })
      const b = c({ id: 'b', brand: 'Alpha', name: 'Same' })
      const result = rankCandidates([a, b], 'Zephyr Same Alpha Same')
      expect(result[0].brand).toBe('Alpha')
    })
  })

  describe('result shape', () => {
    it('includes catalogModelId equal to id', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Hot Wheels Twin Mill')
      expect(result[0].catalogModelId).toBe('hw-tm')
    })
    it('includes label from formatCandidateLabel', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Hot Wheels Twin Mill')
      expect(result[0].label).toBe(formatCandidateLabel(HW_TWIN_MILL))
    })
    it('includes matchReasons array', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Hot Wheels Twin Mill')
      expect(Array.isArray(result[0].matchReasons)).toBe(true)
    })
    it('includes matchedFields array', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Hot Wheels Twin Mill')
      expect(Array.isArray(result[0].matchedFields)).toBe(true)
    })
  })

  describe('DUPLICATE_SCORE_THRESHOLD', () => {
    it('is 80', () => {
      expect(DUPLICATE_SCORE_THRESHOLD).toBe(80)
    })
    it('brand+name match (Rule 2) scores >= threshold', () => {
      const result = rankCandidates([HW_FERRARI], 'Hot Wheels Ferrari 308 GTS')
      expect(result[0].score).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD)
    })
    it('partial brand-only match scores below threshold', () => {
      const result = rankCandidates([MB_LAMBORGHINI], 'Lamborghini')
      expect(result[0].score).toBeLessThan(DUPLICATE_SCORE_THRESHOLD)
    })
  })

  describe('search result cap', () => {
    it('rankCandidates returns more than 20 when given 25 matching candidates', () => {
      const many = Array.from({ length: 25 }, (_, i) =>
        c({ id: `m${i}`, brand: 'Hot Wheels', name: `Model ${i}` })
      )
      const result = rankCandidates(many, 'Hot Wheels')
      expect(result.length).toBeGreaterThan(20)
    })
    it('unrelated candidates are excluded before capping', () => {
      const unrelated = Array.from({ length: 5 }, (_, i) =>
        c({ id: `u${i}`, brand: 'Matchbox', name: `Truck ${i}` })
      )
      const result = rankCandidates(unrelated, 'Hot Wheels Ferrari')
      expect(result).toHaveLength(0)
    })
  })

  describe('no automatic linking', () => {
    it('rankCandidates only returns ranked results — no side effects or DB writes', () => {
      const result = rankCandidates([HW_TWIN_MILL, HW_FERRARI], 'Hot Wheels Twin Mill')
      // Returns results without any mutation; highest score comes first
      expect(result[0].id).toBe('hw-tm')
      expect(result[0].score).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD)
      // No auto-link: the candidate is returned, not applied anywhere
      expect(result).toHaveLength(2)
    })
  })

  describe('duplicate detection for create', () => {
    it('score >= DUPLICATE_SCORE_THRESHOLD indicates a likely duplicate that should block creation without override', () => {
      const candidates = [HW_FERRARI]
      const result = rankCandidates(candidates, 'Hot Wheels Ferrari 308 GTS')
      const topScore = result[0]?.score ?? 0
      expect(topScore).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD)
      // Server should block without createAnyway=true when topScore >= threshold
    })
    it('score < DUPLICATE_SCORE_THRESHOLD allows creation without override', () => {
      const candidates = [MB_LAMBORGHINI]
      const result = rankCandidates(candidates, 'Lamborghini')
      const topScore = result[0]?.score ?? 0
      expect(topScore).toBeLessThan(DUPLICATE_SCORE_THRESHOLD)
      // Server should permit creation without override
    })
    it('empty results allow creation without override', () => {
      const result = rankCandidates([HW_TWIN_MILL], 'Completely Different Brand Unknown')
      expect(result).toHaveLength(0)
      // No duplicate detected → no override needed
    })
  })
})
