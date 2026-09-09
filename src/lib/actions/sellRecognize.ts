'use server'

import { headers } from 'next/headers'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { getRequestId } from '@/lib/requestId'
import { runImageRecognition, validateUpload, type IdentifyCandidate, type RecognitionResult } from '@/lib/captureIdentifyCore'

// 19B: /sell's own recognition entry point — same shared recognition core as
// public /capture (captureIdentifyCore.ts), but with a looser rate limit: a
// seller photographing a whole batch legitimately needs many more than 5
// recognitions per 10 minutes. Public /capture's own 5/10min limit is
// UNCHANGED — this is a second, independent limiter, not a widening of that
// one. Fail-closed without RATE_LIMIT_SECRET, same as every other IP-keyed
// limiter in this codebase.
const SELL_RECOGNIZE_MAX = 30
const SELL_RECOGNIZE_WINDOW = 10 * 60 * 1000

export type { IdentifyCandidate }
export type SellRecognizeState = RecognitionResult | null

export async function recognizeForSell(
  _prev: SellRecognizeState,
  formData: FormData,
): Promise<SellRecognizeState> {
  const reqHeaders = await headers()
  const requestId = await getRequestId()
  const rateLimitKey = rateLimitKeyFromHeaders(reqHeaders, ':sell_recognize')

  if (rateLimitKey === null) {
    return { error: 'Photo identification is temporarily unavailable. Please try again later.' }
  }

  const { allowed, resetMs } = checkRateLimit(rateLimitKey, SELL_RECOGNIZE_MAX, SELL_RECOGNIZE_WINDOW)
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
