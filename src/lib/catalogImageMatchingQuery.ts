import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ALGORITHM_VERSION, type ImageFingerprint } from '@/lib/catalogImageFingerprint'
import { aggregateCandidates, type CatalogMatchCandidate } from '@/lib/catalogImageMatching'

// ── Candidate retrieval for image-search ──────────────────────────────────────

const CANDIDATE_SELECT = {
  id:             true,
  catalogModelId: true,
  perceptualHash: true,
  contentSha256:  true,
  hashBand0:      true,
  hashBand1:      true,
  hashBand2:      true,
  hashBand3:      true,
  catalogModel: { select: { brand: true, name: true, year: true } },
  catalogPhoto: { select: { url: true, altText: true } },
} as const

type CandidateRow = Prisma.CatalogPhotoFingerprintGetPayload<{ select: typeof CANDIDATE_SELECT }>

// Page size for indexed band/SHA candidate queries.
// Each band value matches ~N/65536 fingerprints on average; pagination handles
// rare popular band values without a single large allocation.
const CANDIDATE_PAGE_SIZE = 200

// Paginates through all fingerprints matching `where` in stable ID order.
// Continues until the final partial page — no arbitrary row cap.
async function fetchCandidates(
  where: Prisma.CatalogPhotoFingerprintWhereInput,
): Promise<CandidateRow[]> {
  const rows: CandidateRow[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await prisma.catalogPhotoFingerprint.findMany({
      where:   { ...where, algorithmVersion: ALGORITHM_VERSION },
      select:  CANDIDATE_SELECT,
      orderBy: { id: 'asc' },
      take:    CANDIDATE_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    rows.push(...(page as CandidateRow[]))
    if (page.length < CANDIDATE_PAGE_SIZE) break
    cursor = page[page.length - 1].id
  }
  return rows
}

export type CoverageReason = 'small_index' | 'no_band_candidates' | null

// Pure — exported for unit tests.
// Priority: small_index > no_band_candidates (index size is the more fundamental cause).
export function computeCoverageSignal(
  totalFingerprints: number,
  bandCandidateCount: number,
): { lowCoverage: boolean; coverageReason: CoverageReason } {
  const smallIndex      = totalFingerprints < 5
  const noBandCandidates = bandCandidateCount === 0
  const lowCoverage     = smallIndex || noBandCandidates
  const coverageReason: CoverageReason = smallIndex ? 'small_index' : noBandCandidates ? 'no_band_candidates' : null
  return { lowCoverage, coverageReason }
}

// Five parallel paginated queries: exact SHA + four indexed hash bands.
// SHA candidates spread first so exact matches survive dedup without being displaced.
// No take on individual queries — all matching candidates are retrieved.
export async function findCatalogImageMatches(
  fp: ImageFingerprint,
): Promise<{ results: CatalogMatchCandidate[]; lowCoverage: boolean; coverageReason: CoverageReason }> {
  const [sha, b0, b1, b2, b3] = await Promise.all([
    fetchCandidates({ contentSha256: fp.contentSha256 }),
    fetchCandidates({ hashBand0: fp.hashBand0 }),
    fetchCandidates({ hashBand1: fp.hashBand1 }),
    fetchCandidates({ hashBand2: fp.hashBand2 }),
    fetchCandidates({ hashBand3: fp.hashBand3 }),
  ])

  // Count unique band candidates (deduped across all 4 bands, independent of SHA).
  const bandSeen = new Set<string>()
  for (const row of [...b0, ...b1, ...b2, ...b3]) bandSeen.add(row.id)
  const bandCandidateCount = bandSeen.size

  const seen = new Set<string>()
  const deduped: CandidateRow[] = []
  for (const row of [...sha, ...b0, ...b1, ...b2, ...b3]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    deduped.push(row)
  }

  const totalFingerprints = await prisma.catalogPhotoFingerprint.count({
    where: { algorithmVersion: ALGORITHM_VERSION },
  })
  const { lowCoverage, coverageReason } = computeCoverageSignal(totalFingerprints, bandCandidateCount)

  if (deduped.length === 0) return { results: [], lowCoverage, coverageReason }

  const rows = deduped.map(r => ({
    id:             r.id,
    catalogModelId: r.catalogModelId,
    brand:          r.catalogModel.brand,
    name:           r.catalogModel.name,
    year:           r.catalogModel.year,
    photo:          r.catalogPhoto ? { url: r.catalogPhoto.url, altText: r.catalogPhoto.altText } : null,
    perceptualHash: r.perceptualHash,
    contentSha256:  r.contentSha256,
    hashBand0:      r.hashBand0,
    hashBand1:      r.hashBand1,
    hashBand2:      r.hashBand2,
    hashBand3:      r.hashBand3,
  }))

  return { results: aggregateCandidates(fp, rows), lowCoverage, coverageReason }
}

// ── Dashboard stats ───────────────────────────────────────────────────────────

export type FingerprintCoverageStats = {
  totalPhotos:        number
  fingerprintedCount: number
  missingCount:       number
  algorithmVersion:   string
}

export async function getFingerprintCoverageStats(): Promise<FingerprintCoverageStats> {
  const [totalPhotos, fingerprintedCount] = await Promise.all([
    prisma.catalogModelPhoto.count(),
    prisma.catalogPhotoFingerprint.count({ where: { algorithmVersion: ALGORITHM_VERSION } }),
  ])
  return {
    totalPhotos,
    fingerprintedCount,
    missingCount:     totalPhotos - fingerprintedCount,
    algorithmVersion: ALGORITHM_VERSION,
  }
}

// ── Full-scan helpers ─────────────────────────────────────────────────────────

// Page size for full fingerprint table scans (exact/near duplicate detection).
// Larger than candidate page to reduce round-trips when scanning all fingerprints.
const SCAN_PAGE_SIZE = 500

// ── Exact duplicate groups ────────────────────────────────────────────────────

const EXACT_DUP_SELECT = {
  id:            true,
  contentSha256: true,
  catalogModelId: true,
  catalogModel:  { select: { brand: true, name: true } },
  catalogPhoto:  { select: { url: true } },
} as const

type ExactDupRow = Prisma.CatalogPhotoFingerprintGetPayload<{ select: typeof EXACT_DUP_SELECT }>

export type ExactDuplicateGroup = {
  contentSha256: string
  entries: Array<{
    catalogModelId:   string
    catalogModelName: string
    photoUrl:         string
  }>
}

// Scans ALL current-algorithm fingerprints via keyset pagination.
// Groups by contentSha256; returns groups that appear on multiple distinct CatalogModels.
// Same-model duplicate photos are NOT reported as cross-model conflicts.
export async function getExactDuplicateGroups(): Promise<ExactDuplicateGroup[]> {
  const bySha = new Map<string, ExactDuplicateGroup['entries']>()
  const seenIds = new Set<string>()  // defensive dedup
  let cursor: string | undefined

  for (;;) {
    const page = await prisma.catalogPhotoFingerprint.findMany({
      where:   { algorithmVersion: ALGORITHM_VERSION },
      select:  EXACT_DUP_SELECT,
      orderBy: { id: 'asc' },
      take:    SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })

    for (const r of page as ExactDupRow[]) {
      if (seenIds.has(r.id)) continue
      seenIds.add(r.id)
      if (!bySha.has(r.contentSha256)) bySha.set(r.contentSha256, [])
      bySha.get(r.contentSha256)!.push({
        catalogModelId:   r.catalogModelId,
        catalogModelName: `${r.catalogModel.brand} ${r.catalogModel.name}`,
        photoUrl:         r.catalogPhoto?.url ?? '',
      })
    }

    if (page.length < SCAN_PAGE_SIZE) break
    cursor = page[page.length - 1].id
  }

  return Array.from(bySha.entries())
    .filter(([, entries]) => new Set(entries.map(e => e.catalogModelId)).size > 1)
    .map(([contentSha256, entries]) => ({ contentSha256, entries }))
}

// ── Near-duplicate pairs ──────────────────────────────────────────────────────

const NEAR_DUP_SELECT = {
  id:             true,
  catalogModelId: true,
  perceptualHash: true,
  hashBand0:      true,
  hashBand1:      true,
  hashBand2:      true,
  hashBand3:      true,
  catalogModel:   { select: { brand: true, name: true } },
  catalogPhoto:   { select: { url: true } },
} as const

type NearDupRow = Prisma.CatalogPhotoFingerprintGetPayload<{ select: typeof NEAR_DUP_SELECT }>

export type NearDuplicatePair = {
  distance:       number
  modelA:         { catalogModelId: string; name: string; photoUrl: string }
  modelB:         { catalogModelId: string; name: string; photoUrl: string }
}

// Supported threshold: Hamming distance <= 3.
// At distance <= 3 with four 16-bit bands, any matching pair MUST share at least one
// exact band (pigeonhole: 3 differing bits across 4 bands leaves >= 1 band unchanged).
// Distance-4 pairs that distribute one differing bit per band are not guaranteed to
// be caught by band-indexed retrieval, so the maximum supported threshold is 3.
export const NEAR_DUP_MAX_DISTANCE = 3

// Scans ALL current-algorithm fingerprints via keyset pagination.
// Uses in-memory band-indexed candidate generation: only pairs sharing at least one
// 16-bit band value are Hamming-evaluated. No N × N scan.
// `seenHamming` prevents redundant BigInt computation for the same fingerprint pair
// appearing in multiple band groups.
export async function getNearDuplicatePairs(
  maxDistance = NEAR_DUP_MAX_DISTANCE,
): Promise<NearDuplicatePair[]> {
  // Load complete fingerprint set via keyset pagination.
  const all: NearDupRow[] = []
  const seenIds = new Set<string>()
  let cursor: string | undefined

  for (;;) {
    const page = await prisma.catalogPhotoFingerprint.findMany({
      where:   { algorithmVersion: ALGORITHM_VERSION },
      select:  NEAR_DUP_SELECT,
      orderBy: { id: 'asc' },
      take:    SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })

    for (const r of page as NearDupRow[]) {
      if (seenIds.has(r.id)) continue
      seenIds.add(r.id)
      all.push(r)
    }

    if (page.length < SCAN_PAGE_SIZE) break
    cursor = page[page.length - 1].id
  }

  // Build four in-memory band maps: bandValue → [fingerprints sharing that value].
  const bandKeys = ['hashBand0', 'hashBand1', 'hashBand2', 'hashBand3'] as const
  const bandMaps = bandKeys.map(() => new Map<string, NearDupRow[]>())
  for (const fp of all) {
    for (let b = 0; b < 4; b++) {
      const key = fp[bandKeys[b]]
      const map = bandMaps[b]
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(fp)
    }
  }

  const pairs: NearDuplicatePair[] = []
  const seenPairs   = new Set<string>()  // per-model-pair dedup (A,B) = (B,A)
  const seenHamming = new Set<string>()  // per-fingerprint-pair dedup across band groups

  for (const bandMap of bandMaps) {
    for (const group of bandMap.values()) {
      if (group.length < 2) continue
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j]
          if (a.catalogModelId === b.catalogModelId) continue

          const fpKey = [a.perceptualHash, b.perceptualHash].sort().join('|')
          if (seenHamming.has(fpKey)) continue
          seenHamming.add(fpKey)

          const ha = BigInt(`0x${a.perceptualHash}`)
          const hb = BigInt(`0x${b.perceptualHash}`)
          let diff = ha ^ hb; let dist = 0
          while (diff > 0n) { diff &= diff - 1n; dist++ }

          if (dist <= maxDistance) {
            const pairKey = [a.catalogModelId, b.catalogModelId].sort().join('|')
            if (!seenPairs.has(pairKey)) {
              seenPairs.add(pairKey)
              pairs.push({
                distance: dist,
                modelA: { catalogModelId: a.catalogModelId, name: `${a.catalogModel.brand} ${a.catalogModel.name}`, photoUrl: a.catalogPhoto?.url ?? '' },
                modelB: { catalogModelId: b.catalogModelId, name: `${b.catalogModel.brand} ${b.catalogModel.name}`, photoUrl: b.catalogPhoto?.url ?? '' },
              })
            }
          }
        }
      }
    }
  }

  return pairs.sort((a, b) => a.distance - b.distance)
}
