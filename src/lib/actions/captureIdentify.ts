'use server'

import { headers } from 'next/headers'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { getRequestId } from '@/lib/requestId'
import { runImageRecognition, validateUpload, type IdentifyCandidate, type RecognitionResult } from '@/lib/captureIdentifyCore'

// Public/anonymous — 5 attempts per 10 minutes per IP. Stricter than the existing
// authenticated 12G-C image search (10/10min, keyed by profileId) since there is
// no accountable identity behind an anonymous request.
const IDENTIFY_MAX = 5
const IDENTIFY_WINDOW = 10 * 60 * 1000

export type { IdentifyCandidate }
export type IdentifyResultState = RecognitionResult | null

// 16K: public entry point for the shared recognition core (captureIdentifyCore.ts)
// — 19B extracted that core so a second, differently-rate-limited caller
// (sellRecognize.ts) could reuse it verbatim without a second implementation.
// This wrapper's own behavior — rate limit, upload validation, response shape —
// is byte-for-byte unchanged from before the extraction.
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

  return runImageRecognition(file, requestId)
}
