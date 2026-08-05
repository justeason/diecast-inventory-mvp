import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  hammingDistance,
  countMatchingBands,
  classifyConfidence,
  aggregateCandidates,
  MAX_DISPLAY_DISTANCE,
  MAX_RESULTS,
  type RawFingerprintRow,
} from '../catalogImageMatching'
import { computeCoverageSignal } from '../catalogImageMatchingQuery'
import type { ImageFingerprint } from '../catalogImageFingerprint'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

const queryLibSrc     = readSrc('src/lib/catalogImageMatchingQuery.ts')
const backfillSrc     = readSrc('src/lib/actions/catalogImageBackfill.ts')
const photosActionSrc = readSrc('src/lib/actions/catalogPhotos.ts')
const schemaSrc       = readSrc('prisma/schema.prisma')
const uiSrc           = readSrc('src/components/store/CatalogImageSearch.tsx')

// ── hammingDistance ───────────────────────────────────────────────────────────

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0)
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0)
  })

  it('returns 1 for a single-bit difference', () => {
    expect(hammingDistance('0000000000000001', '0000000000000000')).toBe(1)
  })

  it('returns 64 for all-bits-flipped', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64)
  })

  it('is commutative', () => {
    const a = 'abcdef0123456789'
    const b = '9876543210fedcba'
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a))
  })

  it('counts set bits correctly for known value (0x00ff has 8 bits)', () => {
    expect(hammingDistance('000000000000ff00', '0000000000000000')).toBe(8)
  })
})

// ── countMatchingBands ────────────────────────────────────────────────────────

describe('countMatchingBands', () => {
  const fp: Pick<ImageFingerprint, 'hashBand0' | 'hashBand1' | 'hashBand2' | 'hashBand3'> = {
    hashBand0: 'aaaa', hashBand1: 'bbbb', hashBand2: 'cccc', hashBand3: 'dddd',
  }

  it('returns 4 when all bands match', () => {
    expect(countMatchingBands(fp, { hashBand0: 'aaaa', hashBand1: 'bbbb', hashBand2: 'cccc', hashBand3: 'dddd' })).toBe(4)
  })

  it('returns 0 when no bands match', () => {
    expect(countMatchingBands(fp, { hashBand0: '0000', hashBand1: '1111', hashBand2: '2222', hashBand3: '3333' })).toBe(0)
  })

  it('returns 2 when exactly 2 bands match', () => {
    expect(countMatchingBands(fp, { hashBand0: 'aaaa', hashBand1: 'bbbb', hashBand2: '0000', hashBand3: '1111' })).toBe(2)
  })
})

// ── classifyConfidence ────────────────────────────────────────────────────────

describe('classifyConfidence', () => {
  it('returns exact for distance 0', () => {
    expect(classifyConfidence(0)).toBe('exact')
  })

  it('returns strong for distances 1–6', () => {
    for (let d = 1; d <= 6; d++) {
      expect(classifyConfidence(d)).toBe('strong')
    }
  })

  it('returns possible for distances 7–12', () => {
    for (let d = 7; d <= 12; d++) {
      expect(classifyConfidence(d)).toBe('possible')
    }
  })

  it('returns null for distance 13 (above MAX_DISPLAY_DISTANCE)', () => {
    expect(classifyConfidence(13)).toBe(null)
  })

  it('returns null for large distances', () => {
    expect(classifyConfidence(64)).toBe(null)
  })

  it('MAX_DISPLAY_DISTANCE is 12', () => {
    expect(MAX_DISPLAY_DISTANCE).toBe(12)
  })
})

// ── aggregateCandidates ───────────────────────────────────────────────────────

function makeQueryFp(hash: string): ImageFingerprint {
  return {
    contentSha256:    'sha-query',
    perceptualHash:   hash,
    hashBand0:        hash.slice(0, 4),
    hashBand1:        hash.slice(4, 8),
    hashBand2:        hash.slice(8, 12),
    hashBand3:        hash.slice(12, 16),
    width:            640,
    height:           480,
    algorithmVersion: 'dhash-v1',
  }
}

function makeRow(overrides: Partial<RawFingerprintRow> & { id: string; catalogModelId: string; perceptualHash: string }): RawFingerprintRow {
  const h = overrides.perceptualHash
  return {
    id:             overrides.id,
    catalogModelId: overrides.catalogModelId,
    brand:          overrides.brand ?? 'Hot Wheels',
    name:           overrides.name  ?? 'Test Car',
    year:           overrides.year  ?? null,
    photo:          overrides.photo ?? null,
    perceptualHash: h,
    contentSha256:  overrides.contentSha256 ?? 'sha-other',
    hashBand0:      h.slice(0, 4),
    hashBand1:      h.slice(4, 8),
    hashBand2:      h.slice(8, 12),
    hashBand3:      h.slice(12, 16),
  }
}

const QUERY_HASH = '0000000000000000'

describe('aggregateCandidates', () => {
  it('returns empty for empty rows', () => {
    expect(aggregateCandidates(makeQueryFp(QUERY_HASH), [])).toEqual([])
  })

  it('exact match: distance 0 → confidence exact', () => {
    const queryFp = makeQueryFp(QUERY_HASH)
    const rows = [makeRow({ id: 'r1', catalogModelId: 'm1', perceptualHash: QUERY_HASH })]
    const results = aggregateCandidates(queryFp, rows)
    expect(results).toHaveLength(1)
    expect(results[0].bestDistance).toBe(0)
    expect(results[0].confidence).toBe('exact')
  })

  it('SHA match forces distance 0 even when perceptual hash differs', () => {
    const queryFp = { ...makeQueryFp(QUERY_HASH), contentSha256: 'same-sha' }
    const rows = [makeRow({
      id: 'r1', catalogModelId: 'm1',
      perceptualHash: 'ffffffffffffffff',
      contentSha256: 'same-sha',
    })]
    const results = aggregateCandidates(queryFp, rows)
    expect(results[0].bestDistance).toBe(0)
    expect(results[0].confidence).toBe('exact')
  })

  it('excludes results with distance > MAX_DISPLAY_DISTANCE (12)', () => {
    const queryFp = makeQueryFp(QUERY_HASH)
    const rows = [makeRow({ id: 'r1', catalogModelId: 'm1', perceptualHash: 'ffffffffffffffff' })]
    expect(aggregateCandidates(queryFp, rows)).toHaveLength(0)
  })

  it('aggregates multiple photos from same model — uses best distance', () => {
    const queryFp = makeQueryFp(QUERY_HASH)
    const rows = [
      makeRow({ id: 'r1', catalogModelId: 'm1', perceptualHash: '0000000000000001' }),  // d=1
      makeRow({ id: 'r2', catalogModelId: 'm1', perceptualHash: '000000000000000f' }),  // d=4
    ]
    const results = aggregateCandidates(queryFp, rows)
    expect(results).toHaveLength(1)
    expect(results[0].bestDistance).toBe(1)
    expect(results[0].matchedPhotoCount).toBe(2)
  })

  it('sorts by distance ASC (nearest first)', () => {
    const queryFp = makeQueryFp(QUERY_HASH)
    const rows = [
      makeRow({ id: 'r2', catalogModelId: 'm2', perceptualHash: '0000000000000007' }),  // d=3
      makeRow({ id: 'r1', catalogModelId: 'm1', perceptualHash: '0000000000000001' }),  // d=1
    ]
    const results = aggregateCandidates(queryFp, rows)
    expect(results[0].catalogModelId).toBe('m1')
    expect(results[1].catalogModelId).toBe('m2')
  })

  it('tie-breaks by band count DESC when distance is equal', () => {
    const queryFp = makeQueryFp('aaaa000000000000')
    const rows = [
      makeRow({ id: 'r1', catalogModelId: 'm1', perceptualHash: 'aaaa000000000001' }),  // band0 matches
      makeRow({ id: 'r2', catalogModelId: 'm2', perceptualHash: '0000000000000001' }),  // no bands
    ]
    const results = aggregateCandidates(queryFp, rows)
    expect(results[0].catalogModelId).toBe('m1')
  })

  it('tie-breaks deterministically by catalogModelId ASC when distance and bands are equal', () => {
    const queryFp = makeQueryFp(QUERY_HASH)
    const rows = [
      makeRow({ id: 'r2', catalogModelId: 'model-b', perceptualHash: '0000000000000001' }),
      makeRow({ id: 'r1', catalogModelId: 'model-a', perceptualHash: '0000000000000001' }),
    ]
    const results = aggregateCandidates(queryFp, rows)
    expect(results[0].catalogModelId).toBe('model-a')
    expect(results[1].catalogModelId).toBe('model-b')
  })

  it('limits results to MAX_RESULTS (10)', () => {
    expect(MAX_RESULTS).toBe(10)
    const queryFp = makeQueryFp(QUERY_HASH)
    const rows = Array.from({ length: 15 }, (_, i) =>
      makeRow({ id: `r${i}`, catalogModelId: `m${i}`, perceptualHash: `000000000000000${i.toString(16)}`.slice(0, 16).padStart(16, '0') })
    )
    expect(aggregateCandidates(queryFp, rows).length).toBeLessThanOrEqual(MAX_RESULTS)
  })

  it('handles same row appearing multiple times (band union dedup)', () => {
    const queryFp = makeQueryFp(QUERY_HASH)
    const row = makeRow({ id: 'r1', catalogModelId: 'm1', perceptualHash: '0000000000000001' })
    const results = aggregateCandidates(queryFp, [row, row, row])
    expect(results).toHaveLength(1)
  })
})

// ── findCatalogImageMatches — structural ──────────────────────────────────────

describe('findCatalogImageMatches — structural design', () => {
  it('runs exact SHA + 4 band queries in parallel (5 total)', () => {
    expect(queryLibSrc).toContain('Promise.all')
    expect(queryLibSrc).toContain('contentSha256: fp.contentSha256')
    expect(queryLibSrc).toContain('hashBand0: fp.hashBand0')
    expect(queryLibSrc).toContain('hashBand1: fp.hashBand1')
    expect(queryLibSrc).toContain('hashBand2: fp.hashBand2')
    expect(queryLibSrc).toContain('hashBand3: fp.hashBand3')
  })

  it('SHA candidates spread first — exact match never displaced by band result', () => {
    const spreadSha = queryLibSrc.indexOf('...sha,')
    const spreadB0  = queryLibSrc.indexOf('...b0,', spreadSha)
    expect(spreadSha).toBeGreaterThan(-1)
    expect(spreadB0).toBeGreaterThan(spreadSha)
  })

  it('candidate queries are paginated until complete (CANDIDATE_PAGE_SIZE loop)', () => {
    expect(queryLibSrc).toContain('CANDIDATE_PAGE_SIZE')
    expect(queryLibSrc).toContain('page.length < CANDIDATE_PAGE_SIZE')
    expect(queryLibSrc).toContain('fetchCandidates')
  })

  it('individual band queries have no arbitrary hardcoded take — all use the paginator', () => {
    // fetchCandidates uses CANDIDATE_PAGE_SIZE, not a literal integer
    expect(queryLibSrc).toContain('take:    CANDIDATE_PAGE_SIZE')
    // No hardcoded integer take values in the file
    expect(queryLibSrc).not.toMatch(/\btake:\s*\d+\b/)
  })

  it('deduplicates candidates by id before computing Hamming', () => {
    expect(queryLibSrc).toContain('seen.has(')
    expect(queryLibSrc).toContain('seen.add(')
  })

  it('signals lowCoverage when fingerprint count < 5', () => {
    expect(queryLibSrc).toContain('lowCoverage')
    expect(queryLibSrc).toContain('< 5')
  })
})

// ── duplicate detection — structural ─────────────────────────────────────────

describe('getExactDuplicateGroups — structural', () => {
  it('scans ALL fingerprints via SCAN_PAGE_SIZE keyset loop (no fixed take cap)', () => {
    expect(queryLibSrc).toContain('SCAN_PAGE_SIZE')
    expect(queryLibSrc).toContain('page.length < SCAN_PAGE_SIZE')
    // No hardcoded 200 or 1000 cap on scan
    expect(queryLibSrc).not.toContain('take:    200')
    expect(queryLibSrc).not.toContain('take:    1000')
  })

  it('uses keyset cursor for deterministic pagination', () => {
    expect(queryLibSrc).toContain("cursor: { id: cursor }")
    expect(queryLibSrc).toContain('skip: 1')
  })

  it('defensively deduplicates fingerprint IDs during scan', () => {
    expect(queryLibSrc).toContain('seenIds')
    expect(queryLibSrc).toContain('seenIds.has(')
  })

  it('filters to same SHA on multiple distinct CatalogModels', () => {
    expect(queryLibSrc).toContain('getExactDuplicateGroups')
    expect(queryLibSrc).toContain('.size > 1')
  })

  it('same-model duplicate photos do NOT create a cross-model conflict', () => {
    // filter uses Set of catalogModelIds, not total entry count
    expect(queryLibSrc).toContain('new Set(entries.map(e => e.catalogModelId))')
  })

  it('a duplicate group beyond record 1000 would be discovered (no cap proof)', () => {
    // Scan loop continues until page.length < SCAN_PAGE_SIZE (not a fixed count)
    // The cursor advances after every SCAN_PAGE_SIZE rows indefinitely
    const loopIdx = queryLibSrc.indexOf('page.length < SCAN_PAGE_SIZE')
    expect(loopIdx).toBeGreaterThan(-1)
    // No take: 1000 or take: 200 that would silently cap the scan
    expect(queryLibSrc).not.toMatch(/take:\s*(200|1000)\b/)
  })
})

describe('getNearDuplicatePairs — structural', () => {
  it('scans ALL fingerprints via SCAN_PAGE_SIZE keyset loop', () => {
    expect(queryLibSrc).toContain('SCAN_PAGE_SIZE')
    // Near-dup scan also uses the same page-size constant
    const firstOccurrence = queryLibSrc.indexOf('SCAN_PAGE_SIZE')
    const secondOccurrence = queryLibSrc.indexOf('SCAN_PAGE_SIZE', firstOccurrence + 1)
    expect(secondOccurrence).toBeGreaterThan(-1)  // used in both scan loops
  })

  it('exports NEAR_DUP_MAX_DISTANCE = 3 (provably complete with band indexing)', () => {
    expect(queryLibSrc).toContain('export const NEAR_DUP_MAX_DISTANCE = 3')
  })

  it('threshold comment documents pigeonhole completeness guarantee', () => {
    expect(queryLibSrc).toContain('pigeonhole')
    expect(queryLibSrc).toContain('<= 3')
  })

  it('uses band-indexed candidate generation — no full N×N pairwise scan', () => {
    expect(queryLibSrc).toContain('bandMaps')
    expect(queryLibSrc).toContain('bandMap.values()')
    // No outer loop over all fps × all fps
    expect(queryLibSrc).not.toContain('for (let i = 0; i < fps.length; i++)')
  })

  it('seenHamming prevents redundant BigInt computation for same fingerprint pair', () => {
    expect(queryLibSrc).toContain('seenHamming')
    expect(queryLibSrc).toContain('[a.perceptualHash, b.perceptualHash].sort()')
  })

  it('seenPairs deduplicates model pairs (A,B) = (B,A)', () => {
    expect(queryLibSrc).toContain('seenPairs')
    expect(queryLibSrc).toContain('[a.catalogModelId, b.catalogModelId].sort().join(')
  })

  it('skips same-model pairs', () => {
    expect(queryLibSrc).toContain('a.catalogModelId === b.catalogModelId')
  })

  it('informational only — no mutation', () => {
    expect(queryLibSrc).not.toContain('.delete(')
    expect(queryLibSrc).not.toContain('.update(')
    expect(queryLibSrc).not.toContain('.create(')
  })
})

// ── backfill — keyset and truthful counts ─────────────────────────────────────

describe('generateFingerprintBatch — keyset and counts', () => {
  it('fetches BATCH_SIZE + 1 to detect hasMore without extra count query', () => {
    expect(backfillSrc).toContain('BATCH_SIZE + 1')
  })

  it('slices batch to BATCH_SIZE before processing', () => {
    expect(backfillSrc).toContain('.slice(0, BATCH_SIZE)')
  })

  it('skipped photos increment skipped, not succeeded or failed', () => {
    const skipIdx     = backfillSrc.indexOf('skipped++')
    const continueIdx = backfillSrc.indexOf('continue', skipIdx)
    expect(skipIdx).toBeGreaterThan(-1)
    expect(continueIdx).toBeGreaterThan(skipIdx)
    // 'continue' before next succeeded++ or failed++
    const succAfter = backfillSrc.indexOf('succeeded++', skipIdx)
    expect(continueIdx).toBeLessThan(succAfter)
  })
})

// ── upload lifecycle — transactional ─────────────────────────────────────────

describe('uploadCatalogPhoto — transaction and fingerprint', () => {
  it('creates photo and fingerprint in single $transaction', () => {
    const txIdx = photosActionSrc.indexOf('$transaction')
    const fpIdx = photosActionSrc.indexOf('catalogPhotoFingerprint.create', txIdx)
    expect(txIdx).toBeGreaterThan(-1)
    expect(fpIdx).toBeGreaterThan(txIdx)
  })

  it('fingerprint failure leaves photo visible as missing coverage (fingerprintData stays null)', () => {
    // fingerprintData initialized null; catch block does NOT set it to non-null
    const initIdx  = photosActionSrc.indexOf('| null = null')
    const catchIdx = photosActionSrc.indexOf('[uploadCatalogPhoto] Fingerprint failed')
    expect(initIdx).toBeGreaterThan(-1)
    expect(catchIdx).toBeGreaterThan(-1)
    // Photo is uploaded regardless → visible in stats as missing fingerprint
    expect(photosActionSrc).toContain('if (fingerprintData)')
  })

  it('P2002 on fingerprint.create is re-thrown unless it is P2002', () => {
    expect(photosActionSrc).toContain("e.code === 'P2002')) throw e")
  })
})

// ── schema ────────────────────────────────────────────────────────────────────

describe('CatalogPhotoFingerprint schema', () => {
  it('has compound unique @@unique([catalogPhotoId, algorithmVersion])', () => {
    expect(schemaSrc).toContain('@@unique([catalogPhotoId, algorithmVersion])')
  })

  it('catalogPhotoId is NOT standalone @unique', () => {
    const line = schemaSrc.split('\n').find(l => l.includes('catalogPhotoId') && l.includes('String'))
    expect(line).not.toContain('@unique')
  })

  it('contentSha256 is indexed but NOT globally unique', () => {
    expect(schemaSrc).toContain('@@index([contentSha256])')
    const field = schemaSrc.split('\n').find(l => l.includes('contentSha256') && !l.trim().startsWith('//') && !l.includes('@@'))
    expect(field).not.toContain('@unique')
  })

  it('has 4 hash band indexes for O(1) candidate retrieval', () => {
    expect(schemaSrc).toContain('@@index([hashBand0])')
    expect(schemaSrc).toContain('@@index([hashBand1])')
    expect(schemaSrc).toContain('@@index([hashBand2])')
    expect(schemaSrc).toContain('@@index([hashBand3])')
  })

  it('has onDelete: Cascade for photo deletion', () => {
    expect(schemaSrc).toContain('onDelete: Cascade')
  })

  it('stores algorithmVersion for multi-version coexistence', () => {
    expect(schemaSrc).toContain('algorithmVersion String')
  })
})

// ── computeCoverageSignal ─────────────────────────────────────────────────────

describe('computeCoverageSignal', () => {
  it('large index with zero band candidates → no_band_candidates', () => {
    const { lowCoverage, coverageReason } = computeCoverageSignal(100, 0)
    expect(lowCoverage).toBe(true)
    expect(coverageReason).toBe('no_band_candidates')
  })

  it('small index with zero band candidates → small_index (priority over no_band_candidates)', () => {
    const { lowCoverage, coverageReason } = computeCoverageSignal(3, 0)
    expect(lowCoverage).toBe(true)
    expect(coverageReason).toBe('small_index')
  })

  it('small index with band candidates present → small_index', () => {
    const { lowCoverage, coverageReason } = computeCoverageSignal(3, 5)
    expect(lowCoverage).toBe(true)
    expect(coverageReason).toBe('small_index')
  })

  it('normal indexed candidates → no coverage warning', () => {
    const { lowCoverage, coverageReason } = computeCoverageSignal(100, 10)
    expect(lowCoverage).toBe(false)
    expect(coverageReason).toBe(null)
  })

  it('boundary: exactly 5 fingerprints with band candidates → no coverage warning', () => {
    const { lowCoverage, coverageReason } = computeCoverageSignal(5, 2)
    expect(lowCoverage).toBe(false)
    expect(coverageReason).toBe(null)
  })

  it('boundary: exactly 4 fingerprints → small_index', () => {
    const { lowCoverage, coverageReason } = computeCoverageSignal(4, 2)
    expect(lowCoverage).toBe(true)
    expect(coverageReason).toBe('small_index')
  })

  it('exact SHA match with large index but no band candidates → no_band_candidates (UI suppresses banner when results non-empty)', () => {
    // Function correctly reports no_band_candidates; the UI gates it on empty results.
    // This verifies the function does not silently suppress the reason just because SHA found something.
    const { lowCoverage, coverageReason } = computeCoverageSignal(100, 0)
    expect(lowCoverage).toBe(true)
    expect(coverageReason).toBe('no_band_candidates')
  })
})

// ── UI coverage banner — structural ──────────────────────────────────────────

describe('CatalogImageSearch coverage banner', () => {
  it('small_index banner has no result-count gate — shown even when matches exist', () => {
    // small_index banner must NOT be gated on results.length === 0
    const smallIndexBlock = uiSrc.slice(
      uiSrc.indexOf("coverageReason === 'small_index'"),
      uiSrc.indexOf("coverageReason === 'no_band_candidates'"),
    )
    expect(smallIndexBlock).not.toContain('results?.length')
    expect(smallIndexBlock).toContain('Catalog image coverage is limited')
  })

  it('no_band_candidates banner is gated on empty results — suppressed for exact SHA match', () => {
    const noBandBlock = uiSrc.slice(uiSrc.indexOf("coverageReason === 'no_band_candidates'"))
    expect(noBandBlock).toContain('results?.length')
    expect(noBandBlock).toContain('No indexed candidates were found')
  })

  it('no_band_candidates message includes text-search fallback hint', () => {
    expect(uiSrc).toContain('text search may still help')
  })

  it('small_index message does not claim exhaustive no-match', () => {
    const msg = uiSrc.slice(
      uiSrc.indexOf('Catalog image coverage is limited'),
      uiSrc.indexOf('Catalog image coverage is limited') + 100,
    )
    expect(msg).not.toContain('no match')
    expect(msg).not.toContain('not found')
  })
})
