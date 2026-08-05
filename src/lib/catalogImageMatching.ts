import type { ImageFingerprint } from '@/lib/catalogImageFingerprint'

export type MatchConfidence = 'exact' | 'strong' | 'possible'

export const MAX_DISPLAY_DISTANCE = 12
export const MAX_RESULTS          = 10

export function hammingDistance(hexA: string, hexB: string): number {
  const a = BigInt(`0x${hexA}`)
  const b = BigInt(`0x${hexB}`)
  let diff = a ^ b
  let bits = 0
  while (diff > 0n) {
    diff &= diff - 1n
    bits++
  }
  return bits
}

export function countMatchingBands(
  fp: Pick<ImageFingerprint, 'hashBand0' | 'hashBand1' | 'hashBand2' | 'hashBand3'>,
  row: { hashBand0: string; hashBand1: string; hashBand2: string; hashBand3: string },
): number {
  return (
    (fp.hashBand0 === row.hashBand0 ? 1 : 0) +
    (fp.hashBand1 === row.hashBand1 ? 1 : 0) +
    (fp.hashBand2 === row.hashBand2 ? 1 : 0) +
    (fp.hashBand3 === row.hashBand3 ? 1 : 0)
  )
}

export function classifyConfidence(distance: number): MatchConfidence | null {
  if (distance === 0) return 'exact'
  if (distance <= 6)  return 'strong'
  if (distance <= MAX_DISPLAY_DISTANCE) return 'possible'
  return null
}

export type RawFingerprintRow = {
  id:            string
  catalogModelId: string
  brand:         string
  name:          string
  year:          number | null
  photo:         { url: string; altText: string | null } | null
  perceptualHash: string
  contentSha256: string
  hashBand0:     string
  hashBand1:     string
  hashBand2:     string
  hashBand3:     string
}

export type CatalogMatchCandidate = {
  catalogModelId:  string
  brand:           string
  name:            string
  year:            number | null
  photo:           { url: string; altText: string | null } | null
  bestDistance:    number
  matchingBandCount: number
  confidence:      MatchConfidence
  matchedPhotoCount: number
}

// Aggregate per-model from deduped candidate rows.
// Ranking: distance ASC → band count DESC → catalogModelId ASC (deterministic).
export function aggregateCandidates(
  queryFp: ImageFingerprint,
  rows: RawFingerprintRow[],
): CatalogMatchCandidate[] {
  const byModel = new Map<string, {
    brand:       string
    name:        string
    year:        number | null
    photo:       { url: string; altText: string | null } | null
    bestDist:    number
    bestBands:   number
    count:       number
  }>()

  for (const row of rows) {
    const shaMatch = row.contentSha256 === queryFp.contentSha256
    const dist     = shaMatch ? 0 : hammingDistance(queryFp.perceptualHash, row.perceptualHash)
    const bands    = countMatchingBands(queryFp, row)

    const m = byModel.get(row.catalogModelId)
    if (!m) {
      byModel.set(row.catalogModelId, {
        brand:     row.brand,
        name:      row.name,
        year:      row.year,
        photo:     row.photo,
        bestDist:  dist,
        bestBands: bands,
        count:     1,
      })
    } else {
      if (dist < m.bestDist || (dist === m.bestDist && bands > m.bestBands)) {
        m.bestDist  = dist
        m.bestBands = bands
        if (row.photo) m.photo = row.photo
      }
      m.count++
    }
  }

  const result: CatalogMatchCandidate[] = []
  for (const [catalogModelId, m] of byModel) {
    const confidence = classifyConfidence(m.bestDist)
    if (!confidence) continue  // distance > MAX_DISPLAY_DISTANCE — excluded
    result.push({
      catalogModelId,
      brand:            m.brand,
      name:             m.name,
      year:             m.year,
      photo:            m.photo,
      bestDistance:     m.bestDist,
      matchingBandCount: m.bestBands,
      confidence,
      matchedPhotoCount: m.count,
    })
  }

  result.sort((a, b) => {
    if (a.bestDistance    !== b.bestDistance)    return a.bestDistance - b.bestDistance
    if (a.matchingBandCount !== b.matchingBandCount) return b.matchingBandCount - a.matchingBandCount
    return a.catalogModelId.localeCompare(b.catalogModelId)
  })

  return result.slice(0, MAX_RESULTS)
}
