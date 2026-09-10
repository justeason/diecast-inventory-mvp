import crypto from 'crypto'

// 19C: extracted from mobileCapture.ts's private computePayloadFingerprint so
// guestSellerClaim.ts can compute a byte-identical MobileCaptureItem-shaped
// fingerprint for claimed rows. Pure, no 'use server' — mobileCapture.ts's
// 'use server' directive would force every export to become an independently
// callable Server Action, which this pure helper must never be.
export function computeMobileCaptureFingerprint(params: {
  catalogModelId:     string
  quantity:           number
  acquisitionDate:    string | null
  condition:          string | null
  notes:              string | null
  isPublic:           boolean
  saleTypePreference: string | null
}): string {
  const parts = [
    params.catalogModelId,
    String(params.quantity),
    params.acquisitionDate ?? '',
    params.condition ?? '',
    params.notes ?? '',
    String(params.isPublic),
    params.saleTypePreference ?? '',
  ]
  return crypto.createHash('sha256').update(parts.join('\x00')).digest('hex')
}
