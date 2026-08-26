'use server'

import { headers } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { computeImageFingerprint, FingerprintError } from '@/lib/catalogImageFingerprint'
import { findCatalogImageMatches } from '@/lib/catalogImageMatchingQuery'
import { eligibleListingWhere } from '@/lib/listingEligibility'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { normalizeError } from '@/lib/errors'
import { getRequestId } from '@/lib/requestId'

// Public/anonymous — 5 attempts per 10 minutes per IP. Stricter than the existing
// authenticated 12G-C image search (10/10min, keyed by profileId) since there is
// no accountable identity behind an anonymous request.
const IDENTIFY_MAX = 5
const IDENTIFY_WINDOW = 10 * 60 * 1000

const CANDIDATE_LIMIT = 5

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
// Server Action body-size limit is configured project-wide in next.config.ts as
// '10mb' (== 10 * 1024 * 1024 bytes via Next's binary-unit parsing). A raw file at
// exactly that size, once wrapped in multipart/form-data (boundary + per-part
// headers), would exceed the framework's own limit and be rejected before this
// action ever runs — silently contradicting this exact "10 MB or smaller" message.
// Kept comfortably below 10mb so a file that passes this check is guaranteed to
// fit inside the actual request the framework will accept.
const MAX_FILE_BYTES = 9 * 1024 * 1024

export type IdentifyCandidate = {
  catalogModelId: string
  brand: string
  name: string
  year: number | null
  series: string | null
  color: string | null
  scale: string | null
  photoUrl: string | null
  confidence: 'exact' | 'strong' | 'possible'
  availableCount: number
  lowestPrice: number | null
}

export type IdentifyResultState = {
  candidates?: IdentifyCandidate[]
  lowCoverage?: boolean
  error?: string
} | null

function validateUpload(file: File): string | null {
  if (file.size === 0) return 'No image selected.'
  if (file.size > MAX_FILE_BYTES) return 'Image must be 9 MB or smaller.'
  if (!ALLOWED_MIME.has(file.type)) return 'Only JPEG, PNG, and WebP images are accepted.'
  return null
}

// 16K: public entry point for the existing 12G-C perceptual-hash matching engine
// (catalogImageFingerprint.ts + catalogImageMatchingQuery.ts) — reused verbatim,
// unmodified, no second recognition engine. This action adds only what the shared
// engine intentionally omits for its authenticated/admin callers: public rate
// limiting (IP-derived, no session required) and a small bounded enrichment step
// (series/color/scale identity + Listing availability) for the top candidates
// only. Recognition is read-only — no Collection/Wanted/SellerSubmission/
// CustomerProfile record is created here, and the uploaded photo is processed
// in memory only (never persisted to Blob or the DB).
export async function identifyModelFromPhoto(
  _prev: IdentifyResultState,
  formData: FormData,
): Promise<IdentifyResultState> {
  const reqHeaders = await headers()
  const requestId = await getRequestId()
  const rateLimitKey = rateLimitKeyFromHeaders(reqHeaders, ':public_capture_identify')

  // Fail closed: without RATE_LIMIT_SECRET in production, an IP-derived key would
  // be unkeyed — deny rather than allow unbounded anonymous requests.
  if (rateLimitKey === null) {
    return { error: 'Photo identification is temporarily unavailable. Please try again later.' }
  }

  const { allowed, resetMs } = checkRateLimit(rateLimitKey, IDENTIFY_MAX, IDENTIFY_WINDOW)
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return { error: `Too many attempts. Please wait ${secs} seconds and try again.` }
  }

  const file = formData.get('image')
  if (!(file instanceof File)) return { error: 'No image selected.' }
  const validationError = validateUpload(file)
  if (validationError) return { error: validationError }

  let fp
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    fp = await computeImageFingerprint(buffer, file.type)
  } catch (e) {
    if (e instanceof FingerprintError) return { error: e.message }
    const norm = normalizeError(e, { event: 'capture_identify.fingerprint_failed', requestId })
    return { error: norm.userMessage }
  }

  try {
    const { results, lowCoverage } = await findCatalogImageMatches(fp)
    const top = results.slice(0, CANDIDATE_LIMIT)
    if (top.length === 0) return { candidates: [], lowCoverage }

    const candidateIds = top.map((c) => c.catalogModelId)

    // Two bounded, page-scoped enrichment queries — never per-candidate, and
    // never invoked when there are zero candidates (handled above).
    const [models, eligibleListings] = await Promise.all([
      prisma.catalogModel.findMany({
        where: { id: { in: candidateIds } },
        select: {
          id: true, series: true, color: true, scale: true,
          photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
        },
      }),
      prisma.listing.findMany({
        where: eligibleListingWhere(candidateIds),
        select: { price: true, item: { select: { catalogId: true } } },
      }),
    ])

    const detailById = new Map(models.map((m) => [m.id, m]))

    // Live-DB integrity boundary: CatalogPhotoFingerprint.catalogModel cascades on
    // delete, so a stale candidate should be structurally rare — but the fingerprint
    // match and this enrichment read are two separate queries, not one transaction,
    // so a concurrent admin merge/delete could still race between them. A candidate
    // id the live enrichment query does not return is dropped entirely — never
    // returned with null/fabricated identity, never linked to /catalog/[id]. Matched
    // by id, never by array position/index.
    const liveTop = top.filter((c) => detailById.has(c.catalogModelId))
    if (liveTop.length === 0) return { candidates: [], lowCoverage }

    const availabilityById = new Map<string, { count: number; lowestPrice: number | null }>()
    for (const id of candidateIds) availabilityById.set(id, { count: 0, lowestPrice: null })
    for (const listing of eligibleListings) {
      const entry = availabilityById.get(listing.item.catalogId)
      if (!entry) continue
      entry.count += 1
      entry.lowestPrice = entry.lowestPrice === null ? listing.price : Math.min(entry.lowestPrice, listing.price)
    }

    const candidates: IdentifyCandidate[] = liveTop.map((c) => {
      const detail = detailById.get(c.catalogModelId)!
      const availability = availabilityById.get(c.catalogModelId) ?? { count: 0, lowestPrice: null }
      return {
        catalogModelId: c.catalogModelId,
        brand: c.brand,
        name: c.name,
        year: c.year,
        series: detail.series,
        color: detail.color,
        scale: detail.scale,
        photoUrl: detail.photos[0]?.url ?? c.photo?.url ?? null,
        confidence: c.confidence,
        availableCount: availability.count,
        lowestPrice: availability.lowestPrice,
      }
    })

    return { candidates, lowCoverage }
  } catch (e) {
    const norm = normalizeError(e, { event: 'capture_identify.match_failed', requestId })
    return { error: norm.userMessage }
  }
}
