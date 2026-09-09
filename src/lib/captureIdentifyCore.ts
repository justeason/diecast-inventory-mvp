// 19B: shared internal recognition core, extracted verbatim from the 16K/16L
// public /capture action so a second caller (sell-specific recognition, with a
// different rate limit) can reuse the exact same recognition behavior without
// a second implementation. Deliberately NOT a 'use server' file — every export
// of a 'use server' module becomes an independently callable Server Action
// reachable by anything that imports it, which would expose this rate-limit-
// free core as its own unthrottled endpoint. Callers (captureIdentify.ts,
// sellRecognize.ts) each apply their OWN rate limit before calling in.
import { prisma } from '@/lib/prisma'
import { computeImageFingerprint, FingerprintError } from '@/lib/catalogImageFingerprint'
import { findCatalogImageMatches } from '@/lib/catalogImageMatchingQuery'
import { eligibleListingWhere } from '@/lib/listingEligibility'
import { normalizeError } from '@/lib/errors'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState, type CatalogRelationshipEntry } from '@/lib/catalogRelationshipQuery'

const CANDIDATE_LIMIT = 5

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
// Server Action body-size limit is configured project-wide in next.config.ts as
// '10mb'. Kept comfortably below that so a file that passes this check is
// guaranteed to fit inside the actual multipart request the framework accepts.
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
  relationship: CatalogRelationshipEntry | null
}

export type RecognitionResult =
  | { candidates: IdentifyCandidate[]; lowCoverage?: boolean; error?: undefined }
  | { error: string; candidates?: undefined; lowCoverage?: undefined }

export function validateUpload(file: File): string | null {
  if (file.size === 0) return 'No image selected.'
  if (file.size > MAX_FILE_BYTES) return 'Image must be 9 MB or smaller.'
  if (!ALLOWED_MIME.has(file.type)) return 'Only JPEG, PNG, and WebP images are accepted.'
  return null
}

// Recognition is read-only — no Collection/Wanted/SellerSubmission/
// CustomerProfile/GuestSellerItem record is created here, and the uploaded
// photo is processed in memory only (never persisted to Blob, filesystem, or
// the DB, in any form — not even a thumbnail). Callers must have already
// validated the upload (validateUpload) and enforced their own rate limit
// before calling this.
export async function runImageRecognition(file: File, requestId: string | undefined): Promise<RecognitionResult> {
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

    // Live-DB integrity boundary: a candidate id the live enrichment query does
    // not return is dropped entirely — never returned with null/fabricated
    // identity.
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

    // One batched, bounded relationship read (≤5 live candidate ids) — never
    // per-candidate, never issued for anonymous visitors.
    const session = await getBuyerSession()
    const liveIds = liveTop.map((c) => c.catalogModelId)
    const relationshipMap = session ? await getCatalogRelationshipState(session.profileId, liveIds) : null

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
        relationship: relationshipMap?.get(c.catalogModelId) ?? null,
      }
    })

    return { candidates, lowCoverage }
  } catch (e) {
    const norm = normalizeError(e, { event: 'capture_identify.match_failed', requestId })
    return { error: norm.userMessage }
  }
}
