// Catalog data quality DB queries — all keyset paginated, no N+1 patterns.

import { prisma } from '@/lib/prisma'
import { ALGORITHM_VERSION } from '@/lib/catalogImageFingerprint'
import { detectModelIssues, type DataQualityIssue, type IssueCategory, type IssueSeverity, type IssueType } from '@/lib/catalogDataQuality'
import { scorePair, stablePairKey } from '@/lib/catalogDuplicateDetection'
import { NEAR_DUP_MAX_DISTANCE } from '@/lib/catalogImageMatchingQuery'
import { Prisma } from '@prisma/client'

const SCAN_PAGE_SIZE = 100  // models per page in detection scan

// ── Quality Summary ───────────────────────────────────────────────────────────

export type QualitySummary = {
  totalModels:              number
  modelsWithPhoto:          number
  modelsWithoutPhoto:       number
  photosTotal:              number
  photosMissingFingerprint: number
  modelsWithoutYear:        number
  completenessPercent:      number  // models with brand+name+year+photo / total
  photoFingerprintPercent:  number  // photos with current fingerprint / total
  recentAuditCount:         number  // audits in last 30 days
}

export async function getQualitySummary(): Promise<QualitySummary> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [
    totalModels,
    modelsWithoutPhoto,
    photosTotal,
    photosMissingFingerprint,
    modelsWithoutYear,
    complete,
    recentAuditCount,
  ] = await Promise.all([
    prisma.catalogModel.count(),
    prisma.catalogModel.count({ where: { photos: { none: {} } } }),
    prisma.catalogModelPhoto.count(),
    prisma.catalogModelPhoto.count({
      where: { fingerprints: { none: { algorithmVersion: ALGORITHM_VERSION } } },
    }),
    prisma.catalogModel.count({ where: { year: null } }),
    // "Complete" = has brand + name + at least one photo + year set.
    // brand and name are required schema fields so we only check photo and year.
    prisma.catalogModel.count({
      where: {
        year: { not: null },
        photos: { some: {} },
      },
    }),
    prisma.catalogDataQualityAudit.count({
      where: { createdAt: { gte: thirtyDaysAgo } },
    }),
  ])

  const modelsWithPhoto = totalModels - modelsWithoutPhoto

  return {
    totalModels,
    modelsWithPhoto,
    modelsWithoutPhoto,
    photosTotal,
    photosMissingFingerprint,
    modelsWithoutYear,
    completenessPercent: totalModels > 0 ? Math.round((complete / totalModels) * 100) : 100,
    photoFingerprintPercent:
      photosTotal > 0
        ? Math.round(((photosTotal - photosMissingFingerprint) / photosTotal) * 100)
        : 100,
    recentAuditCount,
  }
}

// ── Issue scan (keyset paginated) ─────────────────────────────────────────────

export type IssueFilter = {
  category?:      IssueCategory
  severity?:      IssueSeverity
  repairableOnly?: boolean
  brand?:         string
  year?:          number
  catalogModelId?: string
  issueType?:     IssueType
}

export type IssueRow = DataQualityIssue & {
  catalogModel: { brand: string; name: string; year: number | null }
}

export type ScanIssuesResult = {
  issues:     IssueRow[]
  nextCursor: string | null    // catalogModelId for next keyset page
  hasMore:    boolean
}

const MODEL_SELECT = {
  id: true, brand: true, name: true, series: true, year: true,
  photos: {
    select: {
      id: true, url: true,
      fingerprints: { select: { algorithmVersion: true } },
    },
  },
} as const

// Scans all matching models in keyset pages, emitting detected issues.
// Returns at most `limit` issues per call; `nextCursor` enables the next page.
// The scan is complete (not capped) — callers iterate until hasMore is false.
export async function scanIssues(
  filter: IssueFilter = {},
  cursor: string | undefined = undefined,
  limit = 50,
): Promise<ScanIssuesResult> {
  const { category, severity, repairableOnly, brand, year, catalogModelId, issueType } = filter

  const modelWhere: Prisma.CatalogModelWhereInput = {}
  if (catalogModelId) modelWhere.id = catalogModelId
  if (brand)         modelWhere.brand = { contains: brand, mode: 'insensitive' }
  if (year !== undefined && year !== null) modelWhere.year = year

  const issues: IssueRow[] = []
  let nextCursor: string | null = null
  let scanCursor = cursor

  // Keep scanning pages until we collect `limit` issues or exhaust the table.
  for (;;) {
    const page = await prisma.catalogModel.findMany({
      where:   modelWhere,
      select:  MODEL_SELECT,
      orderBy: [{ brand: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take:    SCAN_PAGE_SIZE,
      ...(scanCursor ? { skip: 1, cursor: { id: scanCursor } } : {}),
    })

    for (const model of page) {
      const raw = detectModelIssues(model)
      for (const issue of raw) {
        if (category       && issue.category  !== category)       continue
        if (severity       && issue.severity  !== severity)       continue
        if (repairableOnly && !issue.repairAction)                continue
        if (issueType      && issue.issueType !== issueType)      continue

        issues.push({ ...issue, catalogModel: { brand: model.brand, name: model.name, year: model.year } })
      }
      // Check limit AFTER completing all of this model's issues so the cursor
      // never falls mid-model — the next page starts at the model after this one.
      if (issues.length >= limit) {
        nextCursor = model.id
        return { issues: issues.slice(0, limit), nextCursor, hasMore: true }
      }
    }

    if (page.length < SCAN_PAGE_SIZE) {
      // Exhausted the table
      return { issues, nextCursor: null, hasMore: false }
    }
    scanCursor = page[page.length - 1].id
  }
}

// ── Model quality detail ──────────────────────────────────────────────────────

export type ModelQualityDetail = {
  model: {
    id: string; brand: string; name: string; series: string | null
    year: number | null; color: string | null; scale: string | null; notes: string | null
    createdAt: Date; updatedAt: Date
  }
  photos: Array<{
    id: string; url: string; altText: string | null; sortOrder: number
    hasCurrentFingerprint: boolean
  }>
  refCounts: {
    itemInstances:      number
    collectionItems:    number
    wantedBy:           number
    sellerSubmissions:  number
    activeListings:     number
    soldItems:          number
    externalObs:        number
    fingerprints:       number
  }
  issues:       DataQualityIssue[]
  recentAudits: Array<{
    id: string; issueKey: string; action: string; createdAt: Date
  }>
  duplicateCandidates: Array<{
    id: string; brand: string; name: string; year: number | null; score: number
  }>
}

export async function getModelQualityDetail(id: string): Promise<ModelQualityDetail | null> {
  const model = await prisma.catalogModel.findUnique({
    where: { id },
    select: {
      id: true, brand: true, name: true, series: true, year: true,
      color: true, scale: true, notes: true, createdAt: true, updatedAt: true,
      photos: {
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true, url: true, altText: true, sortOrder: true,
          fingerprints: { select: { algorithmVersion: true } },
        },
      },
    },
  })
  if (!model) return null

  // Batch reference counts in parallel — no N+1.
  const [
    itemInstances,
    collectionItems,
    wantedBy,
    sellerSubmissions,
    activeListings,
    soldItems,
    externalObs,
    fingerprints,
    recentAudits,
  ] = await Promise.all([
    prisma.itemInstance.count({ where: { catalogId: id } }),
    prisma.collectionItem.count({ where: { catalogId: id } }),
    prisma.wantedCatalogModel.count({ where: { catalogModelId: id } }),
    prisma.sellerSubmission.count({ where: { catalogId: id } }),
    // Active listings: via itemInstance → listing
    prisma.itemInstance.count({
      where: { catalogId: id, listing: { isNot: null }, status: { not: 'sold' } },
    }),
    prisma.itemInstance.count({ where: { catalogId: id, status: 'sold' } }),
    prisma.externalMarketObservation.count({ where: { catalogModelId: id } }),
    prisma.catalogPhotoFingerprint.count({ where: { catalogModelId: id } }),
    prisma.catalogDataQualityAudit.findMany({
      where: { catalogModelId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, issueKey: true, action: true, createdAt: true },
    }),
  ])

  // Detect issues
  const issues = detectModelIssues({
    id: model.id,
    brand: model.brand,
    name: model.name,
    series: model.series,
    year: model.year,
    photos: model.photos.map(p => ({
      id: p.id,
      url: p.url,
      fingerprints: p.fingerprints,
    })),
  })

  // Find duplicate candidates (text-based only, bounded scan)
  const similar = await prisma.catalogModel.findMany({
    where: {
      id: { not: id },
      brand: { contains: model.brand.split(' ')[0], mode: 'insensitive' },
    },
    select: { id: true, brand: true, name: true, year: true, series: true, color: true, scale: true },
    take: 50,
  })

  const candidates = similar
    .map(s => {
      const { score } = scorePair(
        { id, brand: model.brand, name: model.name, series: model.series, year: model.year, color: null, scale: null },
        s,
      )
      return { id: s.id, brand: s.brand, name: s.name, year: s.year, score }
    })
    .filter(c => c.score >= 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  return {
    model: {
      id: model.id, brand: model.brand, name: model.name, series: model.series,
      year: model.year, color: model.color, scale: model.scale, notes: model.notes,
      createdAt: model.createdAt, updatedAt: model.updatedAt,
    },
    photos: model.photos.map(p => ({
      id: p.id, url: p.url, altText: p.altText, sortOrder: p.sortOrder,
      hasCurrentFingerprint: p.fingerprints.some(f => f.algorithmVersion === ALGORITHM_VERSION),
    })),
    refCounts: {
      itemInstances, collectionItems, wantedBy, sellerSubmissions,
      activeListings, soldItems, externalObs, fingerprints,
    },
    issues,
    recentAudits,
    duplicateCandidates: candidates,
  }
}

// ── Merge impact summary ──────────────────────────────────────────────────────

export type MergeImpactSummary = {
  itemInstances:     number
  collectionItems:   number
  wantedBy:          number
  sellerSubmissions: number
  photos:            number
  fingerprints:      number
  activeListings:    number
  soldItems:         number
  externalObs:       number
}

// Counts all 9 impact metrics for a single catalog model.
// soldItems uses the authoritative definition: completed orders (status='complete' AND completedAt NOT NULL),
// not ItemInstance.status='sold' which may lag order state.
// Accepts a transaction client so it can be called inside a TX for stale-preview checks.
export async function computeImpactCounts(
  catalogId: string,
  db: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<MergeImpactSummary> {
  const [
    itemInstances, collectionItems, wantedBy, sellerSubmissions,
    photos, fingerprints, activeListings, soldItems, externalObs,
  ] = await Promise.all([
    db.itemInstance.count({ where: { catalogId } }),
    db.collectionItem.count({ where: { catalogId } }),
    db.wantedCatalogModel.count({ where: { catalogModelId: catalogId } }),
    db.sellerSubmission.count({ where: { catalogId } }),
    db.catalogModelPhoto.count({ where: { catalogId } }),
    db.catalogPhotoFingerprint.count({ where: { catalogModelId: catalogId } }),
    db.itemInstance.count({ where: { catalogId, listing: { isNot: null }, status: { not: 'sold' } } }),
    db.orderItem.count({ where: { item: { catalogId }, order: { status: 'complete', completedAt: { not: null } } } }),
    db.externalMarketObservation.count({ where: { catalogModelId: catalogId } }),
  ])
  return { itemInstances, collectionItems, wantedBy, sellerSubmissions, photos, fingerprints, activeListings, soldItems, externalObs }
}

// Counts references for both models — uses computeImpactCounts per model.
export async function getMergeImpactSummary(
  idA: string,
  idB: string,
): Promise<{ modelA: MergeImpactSummary; modelB: MergeImpactSummary }> {
  const [modelA, modelB] = await Promise.all([
    computeImpactCounts(idA),
    computeImpactCounts(idB),
  ])
  return { modelA, modelB }
}

// ── Recent repairs ────────────────────────────────────────────────────────────

export type RecentRepair = {
  id:            string
  issueKey:      string
  action:        string
  catalogModelId: string
  adminNote:     string | null
  createdAt:     Date
}

export async function getRecentRepairs(limit = 10): Promise<RecentRepair[]> {
  return prisma.catalogDataQualityAudit.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, issueKey: true, action: true, catalogModelId: true, adminNote: true, createdAt: true },
  })
}

// ── Cross-model duplicate issue scan ─────────────────────────────────────────

type MinimalModel = { id: string; brand: string; name: string; year: number | null; series: string | null; color: string | null; scale: string | null }
type NormBrandRow = MinimalModel & { normBrand: string }

// Server-side normalized-brand key, mirroring normalize() in catalogMatching.ts:
// lower+trim, strip non-alnum/underscore/space to a space, collapse whitespace, trim.
// NOTE: SQL [:alnum:] is locale-aware and slightly broader than JS's ASCII-only \w —
// an acceptable approximation for grouping brand names (typically ASCII business names).
const NORM_BRAND_EXPR = Prisma.sql`LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(TRIM("brand"), '[^[:alnum:]_\\s]', ' ', 'g'), '\\s+', ' ', 'g')))`

const BRAND_GROUP_PAGE_SIZE = 500

// Fetches every row of a single normalized-brand group via bounded, id-keyset-paginated
// pages. Bounded to that one group's size — never the whole CatalogModel table.
async function fetchBrandGroup(normBrand: string): Promise<NormBrandRow[]> {
  const rows: NormBrandRow[] = []
  let idCursor: string | undefined
  for (;;) {
    const page = await prisma.$queryRaw<NormBrandRow[]>`
      SELECT id, brand, name, year, series, color, scale, ${NORM_BRAND_EXPR} AS "normBrand"
      FROM "CatalogModel"
      WHERE ${NORM_BRAND_EXPR} = ${normBrand}
        ${idCursor ? Prisma.sql`AND id > ${idCursor}` : Prisma.empty}
      ORDER BY id ASC
      LIMIT ${BRAND_GROUP_PAGE_SIZE}
    `
    rows.push(...page)
    if (page.length < BRAND_GROUP_PAGE_SIZE) break
    idCursor = page[page.length - 1].id
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// Finds and fetches the next complete normalized-brand group strictly after `afterBrand`
// (null = start from the very first group). Two bounded queries per group: a LIMIT-1
// probe to learn the next group's key (skips irrelevant groups entirely at the DB level,
// no per-group JS filtering over a preloaded table), then fetchBrandGroup for that key.
// Only ONE group's rows are ever held in memory — never the whole catalog.
async function nextBrandGroupAfter(
  afterBrand: string | null,
): Promise<{ key: string; models: NormBrandRow[] } | null> {
  const probe = await prisma.$queryRaw<Array<{ normBrand: string }>>`
    SELECT ${NORM_BRAND_EXPR} AS "normBrand"
    FROM "CatalogModel"
    ${afterBrand !== null ? Prisma.sql`WHERE ${NORM_BRAND_EXPR} > ${afterBrand}` : Prisma.empty}
    ORDER BY "normBrand" ASC
    LIMIT 1
  `
  if (probe.length === 0) return null
  const key = probe[0].normBrand
  return { key, models: await fetchBrandGroup(key) }
}

// Runs the O(k²) pair comparison for ONE brand group (k = group size, bounded — never the
// full catalog), optionally resuming mid-group at (fromAId, fromBId). Mutates `issues` and
// `seenPairs` in place; stops the instant `limit` is reached.
function scanBrandGroupPairs(
  models: NormBrandRow[],
  fromAId: string | null,
  fromBId: string | null,
  issues: IssueRow[],
  seenPairs: Set<string>,
  limit: number,
): { limitHit: boolean; lastA?: string; lastB?: string } {
  let pastCursor = fromAId === null

  for (let i = 0; i < models.length; i++) {
    const mA = models[i]
    if (!pastCursor && mA.id < fromAId!) continue

    for (let j = i + 1; j < models.length; j++) {
      const mB = models[j]
      if (!pastCursor && mA.id === fromAId && mB.id <= fromBId!) continue
      pastCursor = true

      const pk = stablePairKey(mA.id, mB.id)
      if (seenPairs.has(pk)) continue
      seenPairs.add(pk)

      const { score } = scorePair(mA, mB)
      if (score < 50) continue

      const [idA, idB]      = mA.id < mB.id ? [mA.id, mB.id] : [mB.id, mA.id]
      const [mLeft, mRight] = mA.id < mB.id ? [mA, mB] : [mB, mA]
      const base = { category: 'duplicate_risk' as const, catalogModelId: idA, relatedCatalogModelId: idB, catalogModel: { brand: mLeft.brand, name: mLeft.name, year: mLeft.year } }

      if (score === 100) {
        issues.push({ ...base, issueKey: `normalized_key_collision:${idA}|${idB}`, issueType: 'normalized_key_collision', severity: 'error', detail: `Identical normalized brand+name as "${mRight.brand} ${mRight.name}" — both compete for the same search slot.` })
      }
      if (score >= 80) {
        issues.push({ ...base, issueKey: `text_duplicate_high:${idA}|${idB}`, issueType: 'text_duplicate_high', severity: 'error', detail: `High similarity (score ${score}/100) with "${mRight.brand} ${mRight.name}". Likely duplicate.` })
      } else {
        issues.push({ ...base, issueKey: `text_duplicate_medium:${idA}|${idB}`, issueType: 'text_duplicate_medium', severity: 'warning', detail: `Medium similarity (score ${score}/100) with "${mRight.brand} ${mRight.name}". Review for possible merge.` })
      }

      // Stop as soon as limit reached; caller encodes (mA.id, mB.id) as the resume cursor.
      if (issues.length >= limit) return { limitHit: true, lastA: mA.id, lastB: mB.id }
    }
  }
  return { limitHit: false }
}

// ── Photo duplicate pairs (bounded self-joins — no full fingerprint table load) ────

const EXACT_DUP_PAGE_SIZE = 100
const NEAR_DUP_CANDIDATE_PAGE_SIZE = 200

type ExactDupCandidateRow = { modelIdA: string; modelIdB: string; contentSha256: string }

// Fetches one bounded page of cross-model exact-photo (same contentSha256) duplicate
// pairs, deduped to one row per (modelIdA, modelIdB) via DISTINCT ON, keyset-paginated
// on that same pair key. modelIdA < modelIdB always (stable minId|maxId), so pairs are
// cross-model by construction and never repeated across pages.
async function fetchExactDupPage(after: { modelIdA: string; modelIdB: string } | null): Promise<ExactDupCandidateRow[]> {
  return prisma.$queryRaw<ExactDupCandidateRow[]>`
    SELECT DISTINCT ON (a."catalogModelId", b."catalogModelId")
      a."catalogModelId" AS "modelIdA", b."catalogModelId" AS "modelIdB", a."contentSha256"
    FROM "CatalogPhotoFingerprint" a
    JOIN "CatalogPhotoFingerprint" b
      ON a."contentSha256" = b."contentSha256"
      AND a."catalogModelId" < b."catalogModelId"
      AND a."algorithmVersion" = b."algorithmVersion"
    WHERE a."algorithmVersion" = ${ALGORITHM_VERSION}
      ${after ? Prisma.sql`AND (a."catalogModelId", b."catalogModelId") > (${after.modelIdA}, ${after.modelIdB})` : Prisma.empty}
    ORDER BY a."catalogModelId" ASC, b."catalogModelId" ASC
    LIMIT ${EXACT_DUP_PAGE_SIZE}
  `
}

type NearDupCandidateRow = { idA: string; idB: string; modelIdA: string; modelIdB: string; phA: string; phB: string }

// Fetches ALL indexed hash-band candidate rows for ONE (modelIdA, modelIdB) model pair,
// via bounded id-keyset pages. Reuses the 12G-C band-index approach (any pair sharing a
// band value is a candidate; only candidates get an actual Hamming comparison). Bounded
// to that single pair's candidate count (small — at most MAX_CATALOG_PHOTOS² per pair),
// never the whole fingerprint table.
async function fetchNearDupPairCandidates(modelIdA: string, modelIdB: string): Promise<NearDupCandidateRow[]> {
  const rows: NearDupCandidateRow[] = []
  let cursor: { idA: string; idB: string } | null = null
  for (;;) {
    const page: NearDupCandidateRow[] = await prisma.$queryRaw<NearDupCandidateRow[]>`
      SELECT a.id AS "idA", b.id AS "idB", a."catalogModelId" AS "modelIdA", b."catalogModelId" AS "modelIdB",
             a."perceptualHash" AS "phA", b."perceptualHash" AS "phB"
      FROM "CatalogPhotoFingerprint" a
      JOIN "CatalogPhotoFingerprint" b
        ON a."catalogModelId" = ${modelIdA} AND b."catalogModelId" = ${modelIdB}
        AND a."algorithmVersion" = b."algorithmVersion"
        AND (a."hashBand0" = b."hashBand0" OR a."hashBand1" = b."hashBand1" OR a."hashBand2" = b."hashBand2" OR a."hashBand3" = b."hashBand3")
      WHERE a."algorithmVersion" = ${ALGORITHM_VERSION}
        ${cursor ? Prisma.sql`AND (a.id, b.id) > (${cursor.idA}, ${cursor.idB})` : Prisma.empty}
      ORDER BY a.id ASC, b.id ASC
      LIMIT ${NEAR_DUP_CANDIDATE_PAGE_SIZE}
    `
    rows.push(...page)
    if (page.length < NEAR_DUP_CANDIDATE_PAGE_SIZE) break
    cursor = { idA: page[page.length - 1].idA, idB: page[page.length - 1].idB }
  }
  return rows
}

// Finds and fetches the next (modelIdA, modelIdB) band-candidate pair strictly after
// `after`. Two bounded queries: a LIMIT-1 probe to find the next pair key (skips
// irrelevant pairs at the DB level), then fetchNearDupPairCandidates for that pair only.
async function nextNearDupPairAfter(
  after: { modelIdA: string; modelIdB: string } | null,
): Promise<{ modelIdA: string; modelIdB: string; rows: NearDupCandidateRow[] } | null> {
  const probe = await prisma.$queryRaw<Array<{ modelIdA: string; modelIdB: string }>>`
    SELECT a."catalogModelId" AS "modelIdA", b."catalogModelId" AS "modelIdB"
    FROM "CatalogPhotoFingerprint" a
    JOIN "CatalogPhotoFingerprint" b
      ON a."catalogModelId" < b."catalogModelId"
      AND a."algorithmVersion" = b."algorithmVersion"
      AND (a."hashBand0" = b."hashBand0" OR a."hashBand1" = b."hashBand1" OR a."hashBand2" = b."hashBand2" OR a."hashBand3" = b."hashBand3")
    WHERE a."algorithmVersion" = ${ALGORITHM_VERSION}
      ${after ? Prisma.sql`AND (a."catalogModelId", b."catalogModelId") > (${after.modelIdA}, ${after.modelIdB})` : Prisma.empty}
    ORDER BY a."catalogModelId" ASC, b."catalogModelId" ASC
    LIMIT 1
  `
  if (probe.length === 0) return null
  const { modelIdA, modelIdB } = probe[0]
  return { modelIdA, modelIdB, rows: await fetchNearDupPairCandidates(modelIdA, modelIdB) }
}

// Same Hamming-distance computation as getNearDuplicatePairs in catalogImageMatchingQuery.ts.
function hammingDistanceHex(hexA: string, hexB: string): number {
  let diff = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`)
  let dist = 0
  while (diff > 0n) { diff &= diff - 1n; dist++ }
  return dist
}

export type DuplicateScanResult = {
  issues:      IssueRow[]
  hasMore:     boolean
  nextCursor?: string
}

// Scans for cross-model duplicate issues with bounded per-page work.
//
// Text pairs: traverses normalized-brand groups one at a time in deterministic
// (normalizedBrand, id) order, fetched directly from the DB (nextBrandGroupAfter) —
// the CatalogModel table is never loaded in full, only the current group's rows.
// Pair traversal within a group supports a (modelAId, modelBId) resume cursor for
// large single-brand groups. Stops the instant `limit` is reached.
//
// Photo pairs: bounded self-join queries over CatalogPhotoFingerprint (exact SHA match /
// indexed hash-band candidates) — see scanExactPhotoDuplicates / scanNearPhotoDuplicates.
// No full fingerprint table is loaded before pagination.
//
// Cursor format:
//   "text|<normalizedBrand>|<modelAId>|<modelBId>"  – resuming in text phase
//   "photo|<issueKey>"                              – text complete, resuming photo phase
export async function scanDuplicateIssues(limit = 50, cursor?: string): Promise<DuplicateScanResult> {
  // ── Parse cursor ───────────────────────────────────────────────────────────
  let textResume: { brand: string; aId: string; bId: string } | null = null
  let photoResumeCursor: string | null = null
  let skipToPhoto = false

  if (cursor) {
    if (cursor.startsWith('photo|')) {
      skipToPhoto = true
      photoResumeCursor = cursor.slice(6) || null
    } else if (cursor.startsWith('text|')) {
      // format: text|<brand>|<aId>|<bId>  — last two '|' segments are model IDs
      const str = cursor.slice(5)
      const lastPipe = str.lastIndexOf('|')
      const prevPipe = str.lastIndexOf('|', lastPipe - 1)
      if (lastPipe >= 0 && prevPipe >= 0) {
        textResume = {
          brand: str.slice(0, prevPipe),
          aId:   str.slice(prevPipe + 1, lastPipe),
          bId:   str.slice(lastPipe + 1),
        }
      }
    }
  }

  const issues: IssueRow[] = []
  const seenPairs = new Set<string>()

  // ── Phase 1: Text duplicate pairs (bounded traversal, stops at limit) ──────
  // Never loads the whole CatalogModel table: groups are discovered and fetched one
  // at a time directly from the DB in (normalizedBrand, id) order (nextBrandGroupAfter),
  // so only the CURRENT group's rows are ever held in memory.
  if (!skipToPhoto) {
    let afterBrand: string | null = null

    if (textResume) {
      // Finish the group we were mid-way through before moving on.
      const rows = await fetchBrandGroup(textResume.brand)
      const result = scanBrandGroupPairs(rows, textResume.aId, textResume.bId, issues, seenPairs, limit)
      if (result.limitHit) {
        return { issues, hasMore: true, nextCursor: `text|${textResume.brand}|${result.lastA}|${result.lastB}` }
      }
      afterBrand = textResume.brand
    }

    for (;;) {
      const group = await nextBrandGroupAfter(afterBrand)
      if (!group) break

      const result = scanBrandGroupPairs(group.models, null, null, issues, seenPairs, limit)
      if (result.limitHit) {
        return { issues, hasMore: true, nextCursor: `text|${group.key}|${result.lastA}|${result.lastB}` }
      }
      afterBrand = group.key
    }
    // Text phase complete.
  }

  // ── Phase 2: Photo duplicate pairs (bounded self-joins, no full fingerprint table
  // load) ──────────────────────────────────────────────────────────────────────
  // Exact-SHA pairs are fully drained before near-duplicate pairs start — same relative
  // order as the old issueKey string sort ("exact_..." < "near_..."), so the cursor
  // contract is unchanged from the caller's point of view.
  if (limit - issues.length > 0) {
    let photoPhase: 'exact' | 'near' = 'exact'
    let exactCursor: { modelIdA: string; modelIdB: string } | null = null
    let nearCursor:  { modelIdA: string; modelIdB: string } | null = null

    if (photoResumeCursor !== null) {
      const [phase, a, b] = photoResumeCursor.split('|')
      if (phase === 'near') { photoPhase = 'near'; nearCursor  = { modelIdA: a, modelIdB: b } }
      else                  { photoPhase = 'exact'; exactCursor = { modelIdA: a, modelIdB: b } }
    }

    if (photoPhase === 'exact') {
      for (;;) {
        const page = await fetchExactDupPage(exactCursor)

        if (page.length > 0) {
          const modelIds = [...new Set(page.flatMap(r => [r.modelIdA, r.modelIdB]))]
          const models = await prisma.catalogModel.findMany({ where: { id: { in: modelIds } }, select: { id: true, brand: true, name: true, year: true } })
          const mmap = new Map(models.map(m => [m.id, m]))

          for (const row of page) {
            exactCursor = { modelIdA: row.modelIdA, modelIdB: row.modelIdB }
            const pk = stablePairKey(row.modelIdA, row.modelIdB)
            if (seenPairs.has(pk)) continue
            seenPairs.add(pk)
            const mA = mmap.get(row.modelIdA)
            if (!mA) continue
            const mB = mmap.get(row.modelIdB)
            issues.push({
              issueKey: `exact_photo_duplicate:${row.modelIdA}|${row.modelIdB}`, issueType: 'exact_photo_duplicate',
              category: 'duplicate_risk', severity: 'warning', catalogModelId: row.modelIdA, relatedCatalogModelId: row.modelIdB,
              detail: `Same photo content (SHA-256) as "${mB ? `${mB.brand} ${mB.name}` : row.modelIdB}". Review in duplicate workflow.`,
              catalogModel: { brand: mA.brand, name: mA.name, year: mA.year },
            })
            if (issues.length >= limit) {
              return { issues, hasMore: true, nextCursor: `photo|exact|${row.modelIdA}|${row.modelIdB}` }
            }
          }
        }

        if (page.length < EXACT_DUP_PAGE_SIZE) { photoPhase = 'near'; break }
      }
    }

    if (photoPhase === 'near') {
      let after = nearCursor
      for (;;) {
        const pair = await nextNearDupPairAfter(after)
        if (!pair) break
        after = { modelIdA: pair.modelIdA, modelIdB: pair.modelIdB }

        // Pick the closest (lowest-distance) candidate among this pair's band matches —
        // same preference as the old global distance-ascending sort.
        let matched: NearDupCandidateRow | null = null
        let bestDist = Infinity
        for (const row of pair.rows) {
          const dist = hammingDistanceHex(row.phA, row.phB)
          if (dist <= NEAR_DUP_MAX_DISTANCE && dist < bestDist) { matched = row; bestDist = dist }
        }

        if (matched) {
          const pk = stablePairKey(pair.modelIdA, pair.modelIdB)
          if (!seenPairs.has(pk)) {
            seenPairs.add(pk)
            const models = await prisma.catalogModel.findMany({ where: { id: { in: [pair.modelIdA, pair.modelIdB] } }, select: { id: true, brand: true, name: true, year: true } })
            const mmap = new Map(models.map(m => [m.id, m]))
            const mA = mmap.get(pair.modelIdA)
            if (mA) {
              const mB = mmap.get(pair.modelIdB)
              issues.push({
                issueKey: `near_photo_duplicate:${pair.modelIdA}|${pair.modelIdB}`, issueType: 'near_photo_duplicate',
                category: 'duplicate_risk', severity: 'info', catalogModelId: pair.modelIdA, relatedCatalogModelId: pair.modelIdB,
                detail: `Near-identical photo (Hamming distance ${bestDist}) with "${mB ? `${mB.brand} ${mB.name}` : pair.modelIdB}".`,
                catalogModel: { brand: mA.brand, name: mA.name, year: mA.year },
              })
              if (issues.length >= limit) {
                return { issues, hasMore: true, nextCursor: `photo|near|${pair.modelIdA}|${pair.modelIdB}` }
              }
            }
          }
        }
      }
    }
  }

  return { issues, hasMore: false }
}

// ── Reference integrity issue scan ────────────────────────────────────────────

export type RefIntegrityScanResult = {
  issues:      IssueRow[]
  hasMore:     boolean
  nextCursor?: string
}

// Scans reference integrity issues using sequential bounded phase scanning.
// Phases run in order: orphan → fingerprint → submission → audit → suppression.
// Each phase uses keyset-paginated DB queries and returns early when limit is reached.
// No full issue universe is materialized — only rows needed to fill this page are fetched.
//
// Cursor format: "<phase>|<entityId>"
//   orphan|<modelId>        – resume orphan scan after this model ID
//   fingerprint|<fpId>      – resume fingerprint mismatch scan after this fingerprint ID
//   submission|<subId>      – resume submission conflict scan after this submission ID
//   audit|<auditId>         – resume merge-audit scan after this audit ID
//   suppression|<catalogId> – resume suppression scan after this catalog model ID
export async function scanReferenceIntegrityIssues(limit = 50, cursor?: string): Promise<RefIntegrityScanResult> {
  type Phase = 'orphan' | 'fingerprint' | 'submission' | 'audit' | 'suppression'
  const PHASES: Phase[] = ['orphan', 'fingerprint', 'submission', 'audit', 'suppression']

  let curPhase: Phase = 'orphan'
  let curEntityId: string | undefined
  if (cursor) {
    const pipeIdx = cursor.indexOf('|')
    const maybePhase = (pipeIdx >= 0 ? cursor.slice(0, pipeIdx) : cursor) as Phase
    if (PHASES.includes(maybePhase)) {
      curPhase = maybePhase
      curEntityId = pipeIdx >= 0 ? cursor.slice(pipeIdx + 1) : undefined
    }
  }

  const issues: IssueRow[] = []
  const curPhaseIdx = PHASES.indexOf(curPhase)
  const phaseActive   = (p: Phase) => PHASES.indexOf(p) >= curPhaseIdx
  const phaseResuming = (p: Phase) => p === curPhase

  // ── Orphan models ──────────────────────────────────────────────────────────
  if (phaseActive('orphan')) {
    let orphanCursor: string | undefined = phaseResuming('orphan') ? curEntityId : undefined
    for (;;) {
      const page = await prisma.catalogModel.findMany({
        where: {
          photos:            { none: {} },
          items:             { none: {} },
          collectionItems:   { none: {} },
          wantedBy:          { none: {} },
          sellerSubmissions: { none: {} },
        },
        select:  { id: true, brand: true, name: true, year: true },
        orderBy: { id: 'asc' },
        take:    100,
        ...(orphanCursor ? { skip: 1, cursor: { id: orphanCursor } } : {}),
      })
      for (const m of page) {
        issues.push({
          issueKey:      `orphan_no_refs_no_photos:${m.id}`,
          issueType:     'orphan_no_refs_no_photos',
          category:      'reference_integrity',
          severity:      'info',
          catalogModelId: m.id,
          detail:        'No photos, no inventory, no collection links, no wanted entries, no sell requests.',
          catalogModel:  { brand: m.brand, name: m.name, year: m.year },
        })
        if (issues.length >= limit) return { issues, hasMore: true, nextCursor: `orphan|${m.id}` }
      }
      if (page.length < 100) break
      orphanCursor = page[page.length - 1].id
    }
  }

  // ── Fingerprint catalogModelId ≠ its photo's catalogId ────────────────────
  if (phaseActive('fingerprint')) {
    type FpMismatch = { id: string; catalogModelId: string; catalogPhotoId: string }
    let fpCursor: string | undefined = phaseResuming('fingerprint') ? curEntityId : undefined
    for (;;) {
      const mismatches = await prisma.$queryRaw<FpMismatch[]>`
        SELECT fp.id, fp."catalogModelId", fp."catalogPhotoId"
        FROM   "CatalogPhotoFingerprint" fp
        JOIN   "CatalogModelPhoto"       p  ON p.id = fp."catalogPhotoId"
        WHERE  fp."catalogModelId" != p."catalogId"
        ${fpCursor ? Prisma.sql`AND fp.id > ${fpCursor}` : Prisma.empty}
        ORDER BY fp.id
        LIMIT 100
      `
      if (mismatches.length > 0) {
        const mIds   = [...new Set(mismatches.map(r => r.catalogModelId))]
        const models = await prisma.catalogModel.findMany({ where: { id: { in: mIds } }, select: { id: true, brand: true, name: true, year: true } })
        const mmap   = new Map(models.map(m => [m.id, m]))
        for (const fp of mismatches) {
          const m = mmap.get(fp.catalogModelId)
          issues.push({
            issueKey:      `fingerprint_model_mismatch:${fp.id}`,
            issueType:     'fingerprint_model_mismatch',
            category:      'reference_integrity',
            severity:      'warning',
            catalogModelId: fp.catalogModelId,
            detail:        `Fingerprint ${fp.id.slice(0, 8)}… points to a different model than its photo (photo: ${fp.catalogPhotoId.slice(0, 8)}…). Regenerate fingerprints.`,
            catalogModel:  m ? { brand: m.brand, name: m.name, year: m.year } : { brand: '(unknown)', name: fp.catalogModelId.slice(0, 8), year: null },
          })
          if (issues.length >= limit) return { issues, hasMore: true, nextCursor: `fingerprint|${fp.id}` }
        }
      }
      if (mismatches.length < 100) break
      fpCursor = mismatches[mismatches.length - 1].id
    }
  }

  // ── SellerSubmission metadata conflicts ───────────────────────────────────
  if (phaseActive('submission')) {
    type SubConflict = { id: string; catalogId: string }
    let subCursor: string | undefined = phaseResuming('submission') ? curEntityId : undefined
    for (;;) {
      const subConflicts = await prisma.$queryRaw<SubConflict[]>`
        SELECT s.id, s."catalogId"
        FROM   "SellerSubmission" s
        JOIN   "CatalogModel"     c ON c.id = s."catalogId"
        WHERE  s."catalogId" IS NOT NULL
          AND  (
            (s.brand IS NOT NULL AND LOWER(TRIM(s.brand)) != LOWER(TRIM(c.brand)))
            OR (s.name  IS NOT NULL AND LOWER(TRIM(s.name))  != LOWER(TRIM(c.name)))
            OR (s.year  IS NOT NULL AND s.year != c.year)
          )
        ${subCursor ? Prisma.sql`AND s.id > ${subCursor}` : Prisma.empty}
        ORDER BY s.id
        LIMIT 100
      `
      if (subConflicts.length > 0) {
        const cIds   = [...new Set(subConflicts.map(r => r.catalogId))]
        const models = await prisma.catalogModel.findMany({ where: { id: { in: cIds } }, select: { id: true, brand: true, name: true, year: true } })
        const cmap   = new Map(models.map(m => [m.id, m]))
        for (const sc of subConflicts) {
          const m = cmap.get(sc.catalogId)
          issues.push({
            issueKey:      `submission_metadata_conflict:${sc.id}`,
            issueType:     'submission_metadata_conflict',
            category:      'reference_integrity',
            severity:      'warning',
            catalogModelId: sc.catalogId,
            detail:        `Sell request ${sc.id.slice(0, 8)}… has brand/name/year that differs from the linked catalog model.`,
            catalogModel:  m ? { brand: m.brand, name: m.name, year: m.year } : { brand: '(unknown)', name: sc.catalogId.slice(0, 8), year: null },
          })
          if (issues.length >= limit) return { issues, hasMore: true, nextCursor: `submission|${sc.id}` }
        }
      }
      if (subConflicts.length < 100) break
      subCursor = subConflicts[subConflicts.length - 1].id
    }
  }

  // ── Merge audit canonical no longer exists ────────────────────────────────
  if (phaseActive('audit')) {
    type AuditMissing = { id: string; canonicalCatalogModelId: string }
    let auditCursor: string | undefined = phaseResuming('audit') ? curEntityId : undefined
    for (;;) {
      const auditMissing = await prisma.$queryRaw<AuditMissing[]>`
        SELECT id, "canonicalCatalogModelId"
        FROM   "CatalogModelMergeAudit"
        WHERE  "canonicalCatalogModelId" NOT IN (SELECT id FROM "CatalogModel")
        ${auditCursor ? Prisma.sql`AND id > ${auditCursor}` : Prisma.empty}
        ORDER BY id
        LIMIT 100
      `
      for (const a of auditMissing) {
        issues.push({
          issueKey:      `merge_target_missing:${a.id}`,
          issueType:     'merge_target_missing',
          category:      'reference_integrity',
          severity:      'warning',
          catalogModelId: a.canonicalCatalogModelId,
          detail:        `Merge audit ${a.id.slice(0, 8)}… references canonical model ${a.canonicalCatalogModelId.slice(0, 8)}… which no longer exists.`,
          catalogModel:  { brand: '(deleted)', name: a.canonicalCatalogModelId.slice(0, 8), year: null },
        })
        if (issues.length >= limit) return { issues, hasMore: true, nextCursor: `audit|${a.id}` }
      }
      if (auditMissing.length < 100) break
      auditCursor = auditMissing[auditMissing.length - 1].id
    }
  }

  // ── Suppressed models with active inventory ───────────────────────────────
  // Bounded, keyset-paginated traversal of CatalogDuplicateSuppression itself — never
  // loads every suppression row (or every candidate model ID) up front. Each page's
  // derived candidate IDs are deduped (within this call) and checked for active
  // inventory before moving to the next page.
  if (phaseActive('suppression')) {
    const resumeAfter = phaseResuming('suppression') ? curEntityId : undefined
    const checkedModelIds = new Set<string>()
    let suppCursor: string | undefined = resumeAfter

    for (;;) {
      const page = await prisma.catalogDuplicateSuppression.findMany({
        select:  { id: true, pairKey: true },
        orderBy: { id: 'asc' },
        take:    100,
        ...(suppCursor ? { skip: 1, cursor: { id: suppCursor } } : {}),
      })
      if (page.length === 0) break

      const candidateIds: string[] = []
      for (const s of page) {
        const [a, b] = s.pairKey.split('|')
        for (const id of [a, b]) {
          if (id && !checkedModelIds.has(id)) {
            checkedModelIds.add(id)
            candidateIds.push(id)
          }
        }
      }

      if (candidateIds.length > 0) {
        candidateIds.sort()
        const activeGroups = await prisma.itemInstance.groupBy({
          by:    ['catalogId'],
          where: { catalogId: { in: candidateIds }, status: { not: 'sold' } },
          _count: { id: true },
        })
        if (activeGroups.length > 0) {
          const activeIds = activeGroups.map(g => g.catalogId).sort()
          const models    = await prisma.catalogModel.findMany({ where: { id: { in: activeIds } }, select: { id: true, brand: true, name: true, year: true } })
          const mmap      = new Map(models.map(m => [m.id, m]))
          for (const g of [...activeGroups].sort((a, b) => a.catalogId < b.catalogId ? -1 : 1)) {
            const m = mmap.get(g.catalogId)
            if (!m) continue
            issues.push({
              issueKey:      `suppressed_active_inventory:${m.id}`,
              issueType:     'suppressed_active_inventory',
              category:      'reference_integrity',
              severity:      'warning',
              catalogModelId: m.id,
              detail:        `${g._count.id} active item${g._count.id !== 1 ? 's' : ''} on a model that is part of a suppressed duplicate pair.`,
              catalogModel:  { brand: m.brand, name: m.name, year: m.year },
            })
          }
        }
      }

      // Limit is checked at the PAGE boundary (not mid-page): a suppression row can
      // derive up to 2 candidate model IDs, so the cursor — the page's last suppression
      // row ID — must only advance once every derived issue for that row has been
      // emitted, or a resumed page-2 would skip issues from the tail of page 1.
      if (issues.length >= limit) return { issues, hasMore: true, nextCursor: `suppression|${page[page.length - 1].id}` }

      if (page.length < 100) break
      suppCursor = page[page.length - 1].id
    }
  }

  return { issues, hasMore: false }
}
