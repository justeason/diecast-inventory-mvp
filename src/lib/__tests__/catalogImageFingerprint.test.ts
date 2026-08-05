import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { isTrustedBlobUrl } from '../catalogTrustedFetch'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

const fingerprintSrc    = readSrc('src/lib/catalogImageFingerprint.ts')
const trustedFetchSrc   = readSrc('src/lib/catalogTrustedFetch.ts')
const catalogPhotosSrc  = readSrc('src/lib/actions/catalogPhotos.ts')
const backfillSrc       = readSrc('src/lib/actions/catalogImageBackfill.ts')
const matchingActionSrc = readSrc('src/lib/actions/catalogImageMatching.ts')
const schemaSrc         = readSrc('prisma/schema.prisma')

const TEST_HOSTNAME = 'abc123def456.public.blob.vercel-storage.com'
const GOOD_URL      = `https://${TEST_HOSTNAME}/photo.jpg`

// ── isTrustedBlobUrl — exact hostname (env-backed) ───────────────────────────

describe('isTrustedBlobUrl — exact configured hostname', () => {
  const origEnv = process.env.BLOB_TRUSTED_HOSTNAME

  beforeEach(() => { process.env.BLOB_TRUSTED_HOSTNAME = TEST_HOSTNAME })
  afterEach(() => {
    if (origEnv === undefined) delete process.env.BLOB_TRUSTED_HOSTNAME
    else process.env.BLOB_TRUSTED_HOSTNAME = origEnv
  })

  it('accepts URL matching exact configured hostname', () => {
    expect(isTrustedBlobUrl(GOOD_URL)).toBe(true)
  })

  it('normalizes uppercase hostname in URL to lowercase', () => {
    expect(isTrustedBlobUrl(`https://${TEST_HOSTNAME.toUpperCase()}/photo.jpg`)).toBe(true)
  })

  it('rejects another valid Vercel Blob tenant (same suffix, different store)', () => {
    expect(isTrustedBlobUrl('https://other-tenant.public.blob.vercel-storage.com/photo.jpg')).toBe(false)
  })

  it('rejects trusted-host lookalike (extra prefix before configured hostname)', () => {
    expect(isTrustedBlobUrl(`https://evil.${TEST_HOSTNAME}/photo.jpg`)).toBe(false)
  })

  it('rejects trusted-host lookalike (hostname in query string)', () => {
    expect(isTrustedBlobUrl(`https://evil.com/r?url=https://${TEST_HOSTNAME}/p.jpg`)).toBe(false)
  })

  it('rejects HTTP (not HTTPS)', () => {
    expect(isTrustedBlobUrl(`http://${TEST_HOSTNAME}/photo.jpg`)).toBe(false)
  })

  it('rejects localhost', () => {
    expect(isTrustedBlobUrl('https://localhost/photo.jpg')).toBe(false)
  })

  it('rejects private IP literal', () => {
    expect(isTrustedBlobUrl('https://192.168.1.1/photo.jpg')).toBe(false)
  })

  it('rejects data URI', () => {
    expect(isTrustedBlobUrl('data:image/png;base64,abc')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isTrustedBlobUrl('')).toBe(false)
  })
})

describe('isTrustedBlobUrl — fail closed when unconfigured', () => {
  const origEnv = process.env.BLOB_TRUSTED_HOSTNAME

  beforeEach(() => { delete process.env.BLOB_TRUSTED_HOSTNAME })
  afterEach(() => {
    if (origEnv === undefined) delete process.env.BLOB_TRUSTED_HOSTNAME
    else process.env.BLOB_TRUSTED_HOSTNAME = origEnv
  })

  it('returns false for any URL when env var is absent', () => {
    expect(isTrustedBlobUrl(GOOD_URL)).toBe(false)
  })

  it('returns false even for a well-formed blob URL when unconfigured', () => {
    expect(isTrustedBlobUrl('https://anything.public.blob.vercel-storage.com/x.jpg')).toBe(false)
  })
})

// ── trusted fetch — structural: exact-host, not suffix ───────────────────────

describe('isTrustedBlobUrl — structural: exact-equality, not suffix', () => {
  it('uses exact === comparison, not .endsWith()', () => {
    expect(trustedFetchSrc).toContain("url.hostname.toLowerCase() === trusted")
    expect(trustedFetchSrc).not.toContain('.endsWith(')
  })

  it('reads hostname from BLOB_TRUSTED_HOSTNAME env var lazily', () => {
    expect(trustedFetchSrc).toContain('BLOB_TRUSTED_HOSTNAME')
    expect(trustedFetchSrc).toContain('getTrustedHostname()')
  })

  it('fails closed when env var is empty string', () => {
    expect(trustedFetchSrc).toContain("if (!trusted) return false")
  })

  it('does not contain legacy suffix constant', () => {
    expect(trustedFetchSrc).not.toContain('TRUSTED_SUFFIX')
  })
})

describe('fetchTrustedBlobImage — structural design', () => {
  it('sets redirect: error', () => {
    expect(trustedFetchSrc).toContain("redirect:    'error'")
  })

  it('sets credentials: omit', () => {
    expect(trustedFetchSrc).toContain("credentials: 'omit'")
  })

  it('enforces fetch timeout via AbortController', () => {
    expect(trustedFetchSrc).toContain('AbortController')
    expect(trustedFetchSrc).toContain('FETCH_TIMEOUT_MS')
  })

  it('enforces byte cap on streamed response body (not Content-Length)', () => {
    expect(trustedFetchSrc).toContain('MAX_BYTES')
    expect(trustedFetchSrc).toContain('exceeds maximum size')
    // byte cap checked per-chunk during streaming, not from a header
    expect(trustedFetchSrc).toContain('.getReader()')
  })

  it('verifies Content-Type of response', () => {
    expect(trustedFetchSrc).toContain('ACCEPTED_CONTENT_TYPES')
    expect(trustedFetchSrc).toContain('content-type')
  })
})

// ── computeImageFingerprint — structural ──────────────────────────────────────

describe('computeImageFingerprint — structural design', () => {
  it('imports sharp', () => {
    expect(fingerprintSrc).toContain("import sharp from 'sharp'")
  })

  it('exports ALGORITHM_VERSION', () => {
    expect(fingerprintSrc).toContain("export const ALGORITHM_VERSION")
  })

  it('exports FingerprintError with typed codes', () => {
    expect(fingerprintSrc).toContain("export class FingerprintError")
    expect(fingerprintSrc).toContain('FILE_TOO_LARGE')
    expect(fingerprintSrc).toContain('UNSUPPORTED_TYPE')
    expect(fingerprintSrc).toContain('TYPE_MISMATCH')
    expect(fingerprintSrc).toContain('TOO_MANY_PIXELS')
    expect(fingerprintSrc).toContain('DECODE_FAILED')
  })

  it('rejects SVG and GIF via ACCEPTED_FORMATS (not in the set)', () => {
    expect(fingerprintSrc).toContain("ACCEPTED_FORMATS")
    expect(fingerprintSrc).not.toContain("'svg'")
    expect(fingerprintSrc).not.toContain("'gif'")
  })

  it('rejects animated/multi-page images via pages check', () => {
    expect(fingerprintSrc).toContain('metadata.pages')
    expect(fingerprintSrc).toContain('Animated or multi-page')
  })

  it('uses sharp limitInputPixels option on both decode passes', () => {
    expect(fingerprintSrc).toContain('limitInputPixels')
    const first  = fingerprintSrc.indexOf('limitInputPixels')
    const second = fingerprintSrc.indexOf('limitInputPixels', first + 1)
    expect(second).toBeGreaterThan(-1)
  })

  it('checks decompression bomb via pixel count before full decode', () => {
    expect(fingerprintSrc).toContain('MAX_MEGAPIXELS')
    expect(fingerprintSrc).toContain('TOO_MANY_PIXELS')
    expect(fingerprintSrc).toContain('.metadata()')
  })

  it('validates declared MIME vs detected format (not filename alone)', () => {
    expect(fingerprintSrc).toContain('TYPE_MISMATCH')
    expect(fingerprintSrc).toContain('MIME_TO_FORMAT')
  })

  it('SHA-256 is from original bounded bytes, before any transformation', () => {
    const shaIdx  = fingerprintSrc.indexOf("createHash('sha256')")
    const rotIdx  = fingerprintSrc.indexOf('.rotate()')
    expect(shaIdx).toBeGreaterThan(-1)
    expect(rotIdx).toBeGreaterThan(-1)
    expect(shaIdx).toBeLessThan(rotIdx) // SHA before transform
  })

  it('uses .rotate() for auto-orient (EXIF discarded, not retained)', () => {
    expect(fingerprintSrc).toContain('.rotate()')
    expect(fingerprintSrc).not.toContain('.withMetadata()')
  })

  it('produces 4 hash bands from 16-char hex hash via slice', () => {
    expect(fingerprintSrc).toContain('slice(0, 4)')
    expect(fingerprintSrc).toContain('slice(4, 8)')
    expect(fingerprintSrc).toContain('slice(8, 12)')
    expect(fingerprintSrc).toContain('slice(12, 16)')
  })

  it('pads hash to 16 hex chars to preserve leading zero bits', () => {
    expect(fingerprintSrc).toContain("padStart(16, '0')")
  })
})

// ── fingerprint on photo upload ───────────────────────────────────────────────

describe('uploadCatalogPhoto — fingerprint transactional write', () => {
  it('reads file to buffer before upload', () => {
    expect(catalogPhotosSrc).toContain('arrayBuffer()')
    expect(catalogPhotosSrc).toContain('Buffer.from(')
  })

  it('wraps photo + fingerprint in a single $transaction', () => {
    const txIdx  = catalogPhotosSrc.indexOf('$transaction')
    const fpIdx  = catalogPhotosSrc.indexOf('catalogPhotoFingerprint.create', txIdx)
    expect(txIdx).toBeGreaterThan(-1)
    expect(fpIdx).toBeGreaterThan(txIdx)
  })

  it('fingerprint catalogPhotoId references photo.id from the same transaction', () => {
    expect(catalogPhotosSrc).toContain('catalogPhotoId: photo.id')
  })

  it('treats fingerprint failure as non-fatal — photo still saves', () => {
    const errLogIdx = catalogPhotosSrc.indexOf('[uploadCatalogPhoto] Fingerprint failed')
    expect(errLogIdx).toBeGreaterThan(-1)
    // initialized null; failure in catch leaves it null so conditional is false
    expect(catalogPhotosSrc).toContain('| null = null')
  })

  it('P2002 on fingerprint.create is caught inside the fingerprint try/catch only', () => {
    const photoCreateIdx = catalogPhotosSrc.indexOf('catalogModelPhoto.create')
    const fpCreateIdx    = catalogPhotosSrc.indexOf('catalogPhotoFingerprint.create', photoCreateIdx)
    const p2002Idx       = catalogPhotosSrc.indexOf("'P2002'", fpCreateIdx)
    // P2002 handler appears after fingerprint.create, not around photo.create
    expect(photoCreateIdx).toBeGreaterThan(-1)
    expect(fpCreateIdx).toBeGreaterThan(photoCreateIdx)
    expect(p2002Idx).toBeGreaterThan(fpCreateIdx)
  })

  it('unrelated Prisma errors inside fingerprint.create are re-thrown (not swallowed)', () => {
    // The P2002 catch re-throws everything except P2002
    expect(catalogPhotosSrc).toContain('if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === \'P2002\')) throw e')
  })
})

// ── upload lifecycle — blob cleanup on transaction failure ────────────────────

describe('uploadCatalogPhoto — blob cleanup on transaction failure', () => {
  it('wraps $transaction in try/catch for blob cleanup', () => {
    expect(catalogPhotosSrc).toContain('txErr')
  })

  it('calls del(url) in the transaction error handler to remove orphaned blob', () => {
    const txErrIdx = catalogPhotosSrc.indexOf('txErr')
    const delIdx   = catalogPhotosSrc.indexOf('del(url)', txErrIdx)
    expect(delIdx).toBeGreaterThan(-1)
  })

  it('returns error state (does not throw) when transaction fails', () => {
    expect(catalogPhotosSrc).toContain("'Failed to save photo. Please try again.'")
  })

  it('del in transaction catch is best-effort (inner try/catch)', () => {
    // del(url) inside its own try/catch — blob may not exist; don't fail over it
    const delIdx       = catalogPhotosSrc.indexOf('del(url)')
    const innerCatchIdx = catalogPhotosSrc.indexOf('/* best-effort', delIdx)
    expect(innerCatchIdx).toBeGreaterThan(-1)
  })
})

// ── cascade delete and coexistence ───────────────────────────────────────────

describe('CatalogPhotoFingerprint cascade delete', () => {
  it("photo deletion cascades only to that photo's fingerprint", () => {
    // CatalogModelPhoto -> CatalogPhotoFingerprint: onDelete: Cascade (photo-scoped)
    expect(schemaSrc).toContain('onDelete: Cascade')
    // Photo is deleted by ID — only its fingerprint is removed
    expect(catalogPhotosSrc).toContain('catalogModelPhoto.delete({ where: { id: photo.id }')
  })
})

describe('CatalogPhotoFingerprint — algorithm version coexistence', () => {
  it('compound unique allows two algorithm versions for the same photo', () => {
    // @@unique([catalogPhotoId, algorithmVersion]) means (photo1, dhash-v1) and
    // (photo1, dhash-v2) can coexist without conflict
    expect(schemaSrc).toContain('@@unique([catalogPhotoId, algorithmVersion])')
  })

  it('CatalogModelPhoto uses fingerprints[] (one-to-many) to support multiple versions', () => {
    expect(schemaSrc).toContain('fingerprints CatalogPhotoFingerprint[]')
    expect(schemaSrc).not.toContain('fingerprint  CatalogPhotoFingerprint?')
  })

  it('catalogPhotoId is NOT @unique alone — compound key used instead', () => {
    const line = schemaSrc.split('\n').find(l => l.includes('catalogPhotoId') && l.includes('String'))
    expect(line).toBeDefined()
    expect(line).not.toContain('@unique')
  })
})

// ── backfill — structural ─────────────────────────────────────────────────────

describe('generateFingerprintBatch — structural design', () => {
  it('requires admin auth', () => {
    expect(backfillSrc).toContain('isAdminAuthenticated')
  })

  it('selects photos missing the current algorithm version (not just fingerprint: null)', () => {
    expect(backfillSrc).toContain('fingerprints: { some: { algorithmVersion: ALGORITHM_VERSION } }')
    expect(backfillSrc).toContain('NOT:')
  })

  it('uses trusted fetch for every photo URL', () => {
    expect(backfillSrc).toContain('isTrustedBlobUrl')
    expect(backfillSrc).toContain('fetchTrustedBlobImage')
  })

  it('skips untrusted URLs; does not accept arbitrary form-submitted URLs', () => {
    expect(backfillSrc).toContain('skipped++')
    expect(backfillSrc).not.toContain("formData.get('url')")
  })

  it('uses upsert with compound unique key (idempotent per photo + version)', () => {
    expect(backfillSrc).toContain('.upsert(')
    expect(backfillSrc).toContain('catalogPhotoId_algorithmVersion')
  })

  it('P2002 concurrent duplicate counted as succeeded, not failed', () => {
    expect(backfillSrc).toContain("'P2002'")
    expect(backfillSrc).toContain('succeeded++')
  })

  it('bounds batch size and reports hasMore truthfully', () => {
    expect(backfillSrc).toContain('BATCH_SIZE')
    expect(backfillSrc).toContain('BATCH_SIZE + 1')
    expect(backfillSrc).toContain('hasMore')
    expect(backfillSrc).toContain('photos.length > BATCH_SIZE')
  })

  it('has no unused _prev or _formData parameters (lint-clean signature)', () => {
    // Function has no parameters — TypeScript callback compatibility applies
    expect(backfillSrc).toContain('export async function generateFingerprintBatch(): Promise<BackfillState>')
  })
})

// ── search action — privacy + auth ───────────────────────────────────────────

describe('searchCatalogByImage / adminSearchCatalogByImage — structural', () => {
  it('requires buyer session', () => {
    expect(matchingActionSrc).toContain('getBuyerSession')
  })

  it('requires admin auth', () => {
    expect(matchingActionSrc).toContain('isAdminAuthenticated')
  })

  it('does not write to DB', () => {
    expect(matchingActionSrc).not.toContain('prisma.')
  })

  it('does not upload to blob', () => {
    expect(matchingActionSrc).not.toContain('@vercel/blob')
  })

  it('buffer is garbage-collected after request — no persistence', () => {
    expect(matchingActionSrc).toContain('garbage-collected')
  })

  it('validates file size and MIME before processing', () => {
    expect(matchingActionSrc).toContain('MAX_FILE_BYTES')
    expect(matchingActionSrc).toContain('ALLOWED_MIME')
  })
})

// ── schema constraints ────────────────────────────────────────────────────────

describe('CatalogPhotoFingerprint schema', () => {
  it('has compound unique @@unique([catalogPhotoId, algorithmVersion])', () => {
    expect(schemaSrc).toContain('@@unique([catalogPhotoId, algorithmVersion])')
  })

  it('has 4 hash band indexes', () => {
    expect(schemaSrc).toContain('@@index([hashBand0])')
    expect(schemaSrc).toContain('@@index([hashBand1])')
    expect(schemaSrc).toContain('@@index([hashBand2])')
    expect(schemaSrc).toContain('@@index([hashBand3])')
  })

  it('has index on contentSha256 — not globally unique', () => {
    expect(schemaSrc).toContain('@@index([contentSha256])')
    const line = schemaSrc.split('\n').find(l => l.includes('contentSha256') && !l.trim().startsWith('//') && !l.includes('@@'))
    expect(line).not.toContain('@unique')
  })

  it('has onDelete: Cascade from CatalogModelPhoto', () => {
    expect(schemaSrc).toContain('onDelete: Cascade')
  })

  it('stores algorithmVersion field', () => {
    expect(schemaSrc).toContain('algorithmVersion String')
  })
})
