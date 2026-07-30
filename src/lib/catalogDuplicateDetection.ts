// Pure duplicate-pair detection — no DB or server dependencies.
import { normalize, tokenize } from './catalogMatching'
import type { CatalogCandidate } from './catalogMatching'

export type DuplicatePairConfidence = 'high' | 'medium' | 'low'

export type DuplicatePair = {
  pairKey: string
  modelA: CatalogCandidate
  modelB: CatalogCandidate
  score: number
  confidence: DuplicatePairConfidence
  matchReasons: string[]
}

export function stablePairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function scorePair(a: CatalogCandidate, b: CatalogCandidate): { score: number; matchReasons: string[] } {
  const na = normalize(`${a.brand} ${a.name}`)
  const nb = normalize(`${b.brand} ${b.name}`)

  // Exact brand+name (normalized)
  if (na === nb) {
    return { score: 100, matchReasons: ['Identical brand and name'] }
  }

  const tokA = tokenize(`${a.brand} ${a.name}`)
  const tokB = tokenize(`${b.brand} ${b.name}`)

  if (!tokA.length || !tokB.length) return { score: 0, matchReasons: [] }

  // Exact brand match
  const brandMatch = normalize(a.brand) === normalize(b.brand)
  // Name token overlap
  const nameTokensA = tokenize(a.name)
  const nameTokensB = tokenize(b.name)
  const nameOverlap = nameTokensA.filter((t) => nameTokensB.includes(t))
  const nameOverlapRatio =
    nameOverlap.length / Math.max(nameTokensA.length, nameTokensB.length, 1)

  const reasons: string[] = []
  let score = 0

  if (brandMatch) {
    score += 40
    reasons.push('Same brand')
  } else {
    // Partial brand overlap
    const brandTokensA = tokenize(a.brand)
    const brandTokensB = tokenize(b.brand)
    const brandOverlap = brandTokensA.filter((t) => brandTokensB.includes(t))
    if (brandOverlap.length > 0) {
      score += 15
      reasons.push('Partial brand overlap')
    }
  }

  if (nameOverlapRatio >= 1.0) {
    score += 50
    reasons.push('Identical name tokens')
  } else if (nameOverlapRatio >= 0.75) {
    score += 35
    reasons.push('Strong name overlap')
  } else if (nameOverlapRatio >= 0.5) {
    score += 20
    reasons.push('Partial name overlap')
  } else if (nameOverlapRatio > 0) {
    score += 8
    reasons.push('Weak name overlap')
  }

  // Optional field boosts
  if (a.series && b.series && normalize(a.series) === normalize(b.series)) {
    score = Math.min(score + 5, 99)
    reasons.push('Same series')
  }
  if (a.year && b.year && a.year === b.year) {
    score = Math.min(score + 5, 99)
    reasons.push('Same year')
  }
  if (a.color && b.color && normalize(a.color) === normalize(b.color)) {
    score = Math.min(score + 3, 99)
    reasons.push('Same color')
  }

  return { score: Math.min(score, 100), matchReasons: reasons }
}

function pairConfidence(score: number): DuplicatePairConfidence {
  if (score >= 80) return 'high'
  if (score >= 50) return 'medium'
  return 'low'
}

export function buildPairs(models: CatalogCandidate[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = []
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i]
      const b = models[j]
      const { score, matchReasons } = scorePair(a, b)
      if (score > 0) {
        pairs.push({
          pairKey: stablePairKey(a.id, b.id),
          modelA: a,
          modelB: b,
          score,
          confidence: pairConfidence(score),
          matchReasons,
        })
      }
    }
  }
  return pairs
}

export function rankPairs(pairs: DuplicatePair[]): DuplicatePair[] {
  return [...pairs].sort((a, b) => b.score - a.score || a.modelA.brand.localeCompare(b.modelA.brand))
}
