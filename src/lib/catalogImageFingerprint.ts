import sharp from 'sharp'
import crypto from 'crypto'

export const ALGORITHM_VERSION = 'dhash-v1'
export const MAX_IMAGE_BYTES   = 10 * 1024 * 1024  // 10 MB
export const MAX_MEGAPIXELS    = 25_000_000         // 25 MP

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp'])

const MIME_TO_FORMAT: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png':  'png',
  'image/webp': 'webp',
}

export type ImageFingerprint = {
  contentSha256:    string  // 64-char hex SHA-256 of original bytes
  perceptualHash:   string  // 16-char hex 64-bit dHash
  hashBand0:        string  // 4-char hex (bits 48-63)
  hashBand1:        string  // 4-char hex (bits 32-47)
  hashBand2:        string  // 4-char hex (bits 16-31)
  hashBand3:        string  // 4-char hex (bits 0-15)
  width:            number
  height:           number
  algorithmVersion: string
}

export type FingerprintErrorCode =
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'TYPE_MISMATCH'
  | 'TOO_MANY_PIXELS'
  | 'DECODE_FAILED'

export class FingerprintError extends Error {
  constructor(public code: FingerprintErrorCode, message: string) {
    super(message)
    this.name = 'FingerprintError'
  }
}

export async function computeImageFingerprint(
  buffer: Buffer,
  mimeType: string,
): Promise<ImageFingerprint> {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new FingerprintError('FILE_TOO_LARGE', `Image exceeds ${MAX_IMAGE_BYTES / 1_048_576} MB limit`)
  }

  if (!MIME_TO_FORMAT[mimeType]) {
    throw new FingerprintError('UNSUPPORTED_TYPE', 'Only JPEG, PNG, and WebP are accepted.')
  }

  // Read headers only — safe for decompression-bomb detection.
  // limitInputPixels is a second-layer defence inside sharp itself.
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_MEGAPIXELS }).metadata()
  } catch {
    throw new FingerprintError('DECODE_FAILED', 'Could not decode image.')
  }

  const detected = metadata.format
  if (!detected || !ACCEPTED_FORMATS.has(detected)) {
    throw new FingerprintError('UNSUPPORTED_TYPE', `Unsupported format: ${detected ?? 'unknown'}. Only JPEG, PNG, and WebP are accepted.`)
  }

  if (MIME_TO_FORMAT[mimeType] !== detected) {
    throw new FingerprintError('TYPE_MISMATCH', `Declared type ${mimeType} does not match detected format ${detected}.`)
  }

  // Reject animated or multi-page images (animated WebP, multi-frame GIF bytes with webp MIME, etc.)
  if (metadata.pages !== undefined && metadata.pages > 1) {
    throw new FingerprintError('UNSUPPORTED_TYPE', 'Animated or multi-page images are not accepted.')
  }

  const w = metadata.width  ?? 0
  const h = metadata.height ?? 0
  if (w * h > MAX_MEGAPIXELS) {
    throw new FingerprintError('TOO_MANY_PIXELS', `Image exceeds ${MAX_MEGAPIXELS / 1_000_000} MP limit (${w}×${h})`)
  }

  // SHA-256 of original bounded bytes before any transformation.
  const contentSha256 = crypto.createHash('sha256').update(buffer).digest('hex')

  // Normalize: auto-orient (reads + discards EXIF orientation), strip all metadata
  // (sharp default), grayscale, resize to 9×8 for 64-bit dHash.
  let rawPixels: Buffer
  try {
    rawPixels = await sharp(buffer, { limitInputPixels: MAX_MEGAPIXELS })
      .rotate()                                        // auto-orient; EXIF not retained
      .grayscale()
      .resize(9, 8, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer()
  } catch {
    throw new FingerprintError('DECODE_FAILED', 'Failed to normalize image.')
  }

  // dHash: 8 rows × 8 column-pair comparisons = 64 bits
  let hashBigInt = 0n
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 9 + col
      hashBigInt = (hashBigInt << 1n) | (rawPixels[idx] > rawPixels[idx + 1] ? 1n : 0n)
    }
  }

  const perceptualHash = hashBigInt.toString(16).padStart(16, '0')

  return {
    contentSha256,
    perceptualHash,
    hashBand0:        perceptualHash.slice(0, 4),
    hashBand1:        perceptualHash.slice(4, 8),
    hashBand2:        perceptualHash.slice(8, 12),
    hashBand3:        perceptualHash.slice(12, 16),
    width:            w,
    height:           h,
    algorithmVersion: ALGORITHM_VERSION,
  }
}
