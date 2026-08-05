'use server'

import { cookies } from 'next/headers'
import { getBuyerSession } from '@/lib/buyerSession'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { computeImageFingerprint, FingerprintError } from '@/lib/catalogImageFingerprint'
import { findCatalogImageMatches } from '@/lib/catalogImageMatchingQuery'
import type { CoverageReason } from '@/lib/catalogImageMatchingQuery'
import type { CatalogMatchCandidate } from '@/lib/catalogImageMatching'
import { checkRateLimit, hashRateLimitKey } from '@/lib/rateLimit'
import { normalizeError } from '@/lib/errors'
import { getRequestId } from '@/lib/requestId'

// Rate limits (instance-local — see rateLimit.ts; not globally distributed)
const IMAGE_SEARCH_MAX         = 10
const IMAGE_SEARCH_WINDOW      = 10 * 60 * 1000   // 10 minutes
// Admin: higher limit; keyed by hashed session token, not a global bucket.
const ADMIN_IMAGE_SEARCH_MAX    = 60
const ADMIN_IMAGE_SEARCH_WINDOW = 10 * 60 * 1000  // 10 minutes

const ALLOWED_MIME   = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_FILE_BYTES = 10 * 1024 * 1024

export type ImageSearchState = {
  results?:        CatalogMatchCandidate[]
  error?:          string
  lowCoverage?:    boolean
  coverageReason?: CoverageReason
} | null

// Validates size and MIME before decoding — expensive processing happens after.
function validateUpload(file: File): string | null {
  if (file.size === 0)              return 'No image selected.'
  if (file.size > MAX_FILE_BYTES)   return 'Image must be 10 MB or smaller.'
  if (!ALLOWED_MIME.has(file.type)) return 'Only JPEG, PNG, and WebP images are accepted.'
  return null
}

// Shared core: processes buffer in memory only — no writes, no storage, no logging of content.
async function runImageSearch(
  buffer: Buffer,
  mimeType: string,
  requestId?: string,
): Promise<ImageSearchState> {
  let fp
  try {
    fp = await computeImageFingerprint(buffer, mimeType)
  } catch (e) {
    if (e instanceof FingerprintError) return { error: e.message }
    const norm = normalizeError(e, { event: 'image_search.fingerprint_failed', requestId })
    return { error: norm.userMessage }
  }

  try {
    const { results, lowCoverage, coverageReason } = await findCatalogImageMatches(fp)
    return { results, lowCoverage, coverageReason }
    // buffer is garbage-collected after this; no trace remains
  } catch (e) {
    const norm = normalizeError(e, { event: 'image_search.match_failed', requestId })
    return { error: norm.userMessage }
  }
}

export async function searchCatalogByImage(
  _prev: ImageSearchState,
  formData: FormData,
): Promise<ImageSearchState> {
  const session = await getBuyerSession()
  if (!session) return { error: 'Sign in to use image search.' }

  // Rate limit by profile ID (authenticated identity, not IP)
  const { allowed, resetMs } = checkRateLimit(
    `image_search:${session.profileId}`,
    IMAGE_SEARCH_MAX,
    IMAGE_SEARCH_WINDOW,
  )
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return { error: `Too many searches. Please wait ${secs} seconds.` }
  }

  const file = formData.get('image')
  if (!(file instanceof File)) return { error: 'No image selected.' }
  const validationError = validateUpload(file)
  if (validationError) return { error: validationError }

  const requestId = await getRequestId()
  const buffer = Buffer.from(await file.arrayBuffer())
  return runImageSearch(buffer, file.type, requestId)
}

export async function adminSearchCatalogByImage(
  _prev: ImageSearchState,
  formData: FormData,
): Promise<ImageSearchState> {
  if (!await isAdminAuthenticated()) return { error: 'Unauthorized.' }

  // Rate-limit key derived from the verified server-computed session token.
  // The cookie value is HMAC(ADMIN_PASSWORD, 'diecast-admin-session') — not browser-supplied.
  // This is a single-admin app: one session identity → one bucket (correct scope).
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('admin_session')?.value ?? ''
  const rateLimitKey = hashRateLimitKey(sessionValue, ':admin_image_search')
  if (rateLimitKey === null) {
    // Fail closed: RATE_LIMIT_SECRET absent in production — cannot key the limiter safely.
    return { error: 'Image search is temporarily unavailable.' }
  }

  const { allowed, resetMs } = checkRateLimit(rateLimitKey, ADMIN_IMAGE_SEARCH_MAX, ADMIN_IMAGE_SEARCH_WINDOW)
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return { error: `Too many searches. Please wait ${secs} seconds.` }
  }

  const file = formData.get('image')
  if (!(file instanceof File)) return { error: 'No image selected.' }
  const validationError = validateUpload(file)
  if (validationError) return { error: validationError }

  const requestId = await getRequestId()
  const buffer = Buffer.from(await file.arrayBuffer())
  return runImageSearch(buffer, file.type, requestId)
}
