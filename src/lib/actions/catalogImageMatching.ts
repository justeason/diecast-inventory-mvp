'use server'

import { getBuyerSession } from '@/lib/buyerSession'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { computeImageFingerprint, FingerprintError } from '@/lib/catalogImageFingerprint'
import { findCatalogImageMatches } from '@/lib/catalogImageMatchingQuery'
import type { CoverageReason } from '@/lib/catalogImageMatchingQuery'
import type { CatalogMatchCandidate } from '@/lib/catalogImageMatching'

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_FILE_BYTES = 10 * 1024 * 1024

export type ImageSearchState = {
  results?:        CatalogMatchCandidate[]
  error?:          string
  lowCoverage?:    boolean
  coverageReason?: CoverageReason
} | null

// Shared core: processes buffer in memory only — no writes, no storage, no logging of content.
async function runImageSearch(buffer: Buffer, mimeType: string): Promise<ImageSearchState> {
  if (buffer.length > MAX_FILE_BYTES) return { error: 'Image must be 10 MB or smaller.' }
  if (!ALLOWED_MIME.has(mimeType))   return { error: 'Only JPEG, PNG, and WebP images are accepted.' }

  let fp
  try {
    fp = await computeImageFingerprint(buffer, mimeType)
  } catch (e) {
    return { error: e instanceof FingerprintError ? e.message : 'Failed to process image.' }
  }

  const { results, lowCoverage, coverageReason } = await findCatalogImageMatches(fp)
  return { results, lowCoverage, coverageReason }
  // buffer is garbage-collected after this; no trace remains
}

export async function searchCatalogByImage(
  _prev: ImageSearchState,
  formData: FormData,
): Promise<ImageSearchState> {
  const session = await getBuyerSession()
  if (!session) return { error: 'Sign in to use image search.' }

  const file = formData.get('image')
  if (!(file instanceof File) || file.size === 0) return { error: 'No image selected.' }

  const buffer = Buffer.from(await file.arrayBuffer())
  return runImageSearch(buffer, file.type)
}

export async function adminSearchCatalogByImage(
  _prev: ImageSearchState,
  formData: FormData,
): Promise<ImageSearchState> {
  if (!await isAdminAuthenticated()) return { error: 'Unauthorized.' }

  const file = formData.get('image')
  if (!(file instanceof File) || file.size === 0) return { error: 'No image selected.' }

  const buffer = Buffer.from(await file.arrayBuffer())
  return runImageSearch(buffer, file.type)
}
