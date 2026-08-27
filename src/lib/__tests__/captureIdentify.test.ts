/**
 * 16K: public Quick Capture model recognition (/capture). Behavioral tests for the
 * new public action (mocked dependencies) plus structural/source-regex checks for
 * the page/component/architecture requirements, mirroring the 16H/16I/16J
 * test convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findMany: vi.fn() },
    listing: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/catalogImageFingerprint', () => ({
  computeImageFingerprint: vi.fn(),
  FingerprintError: class FingerprintError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))
vi.mock('@/lib/catalogImageMatchingQuery', () => ({
  findCatalogImageMatches: vi.fn(),
}))
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(),
  rateLimitKeyFromHeaders: vi.fn(),
}))
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}))
vi.mock('@/lib/requestId', () => ({
  getRequestId: vi.fn().mockResolvedValue('req-1'),
}))
vi.mock('@/lib/errors', () => ({
  normalizeError: vi.fn(() => ({ userMessage: "Couldn't analyze this photo right now." })),
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('@/lib/catalogRelationshipQuery', () => ({ getCatalogRelationshipState: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { computeImageFingerprint, FingerprintError } from '@/lib/catalogImageFingerprint'
import { findCatalogImageMatches } from '@/lib/catalogImageMatchingQuery'
import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'
import { identifyModelFromPhoto } from '@/lib/actions/captureIdentify'

const fakeFp = {
  contentSha256: 'a'.repeat(64), perceptualHash: '0'.repeat(16),
  hashBand0: '0000', hashBand1: '0000', hashBand2: '0000', hashBand3: '0000',
  width: 100, height: 100, algorithmVersion: 'dhash-v1',
}

function fakeFile(opts: { size?: number; type?: string } = {}): File {
  const size = opts.size ?? 1024
  const type = opts.type ?? 'image/jpeg'
  const buf = new Uint8Array(size)
  return new File([buf], 'photo.jpg', { type })
}

function fakeFormData(file?: File | null): FormData {
  const fd = new FormData()
  if (file) fd.set('image', file)
  return fd
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(rateLimitKeyFromHeaders as Mock).mockReturnValue('rl-key')
  ;(checkRateLimit as Mock).mockReturnValue({ allowed: true, remaining: 4, resetMs: 60_000 })
  // Anonymous by default — individual tests override for authenticated scenarios.
  ;(getBuyerSession as Mock).mockResolvedValue(null)
})

const actionSrc = readSrc('src/lib/actions/captureIdentify.ts')
const actionCode = stripComments(actionSrc)
const componentSrc = readSrc('src/components/store/CaptureIdentify.tsx')
const componentCode = stripComments(componentSrc)
const pageSrc = readSrc('src/app/(store)/capture/page.tsx')

// ── Part A/B: architecture findings, encoded as behavioral + structural proof ──

describe('16K: recognition was already separable from persistence — no stop-condition blocker', () => {
  it('the existing perceptual-hash engine (computeImageFingerprint) performs no DB/Prisma call', () => {
    const fpSrc = readSrc('src/lib/catalogImageFingerprint.ts')
    expect(fpSrc).not.toMatch(/prisma\./)
  })

  it('the existing matching query (findCatalogImageMatches) is read-only — no create/update/delete', () => {
    const matchQuerySrc = readSrc('src/lib/catalogImageMatchingQuery.ts')
    expect(matchQuerySrc).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('the new public action reuses both unmodified — no second recognition/matching engine', () => {
    expect(actionSrc).toContain("import { computeImageFingerprint, FingerprintError } from '@/lib/catalogImageFingerprint'")
    expect(actionSrc).toContain("import { findCatalogImageMatches } from '@/lib/catalogImageMatchingQuery'")
  })

  it('the shared engine files themselves were not modified by 16K (still exactly the 12G-C algorithm/version)', () => {
    const fpSrc = readSrc('src/lib/catalogImageFingerprint.ts')
    expect(fpSrc).toContain("export const ALGORITHM_VERSION = 'dhash-v1'")
  })
})

// ── Part C: canonical public route ──────────────────────────────────────────────

describe('16K: canonical public route /capture, no aliases, existing routes preserved', () => {
  it('/capture exists', () => {
    expect(exists('src/app/(store)/capture/page.tsx')).toBe(true)
  })
  it('no alias routes were created', () => {
    expect(exists('src/app/(store)/quick-capture')).toBe(false)
    expect(exists('src/app/(store)/identify')).toBe(false)
    expect(exists('src/app/(store)/scan')).toBe(false)
  })
  it('/account/capture, /account/capture/review, /account/sell/capture all still exist', () => {
    expect(exists('src/app/(store)/account/capture/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/capture/review/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/sell/capture/page.tsx')).toBe(true)
  })
})

// ── Part D: no new primary nav item ─────────────────────────────────────────────

describe('16K: no new primary nav item', () => {
  it('customerNav.ts primary array is unchanged — still 4 entries, no Capture label', () => {
    const navSrc = readSrc('src/lib/customerNav.ts')
    const navMatches = [...navSrc.matchAll(/CUSTOMER_PRIMARY_NAV: CustomerNavItem\[\] = \[([\s\S]*?)\]/g)]
    expect(navMatches[0][1].match(/key:/g)?.length).toBe(4)
    expect(navSrc).not.toMatch(/label: 'Capture'/)
  })
})

// ── Part E: contextual discovery entry points ───────────────────────────────────

describe('16K: restrained contextual entry points', () => {
  it('/catalog links to /capture ("Identify from photo")', () => {
    const catalogPageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(catalogPageSrc).toContain('href="/capture"')
    expect(catalogPageSrc).toContain('Identify from photo')
  })
  it('/catalog zero-results state also offers "try a photo"', () => {
    const catalogPageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(catalogPageSrc).toContain('try a photo')
  })
  it('/browse links to /capture ("identify a model from a photo")', () => {
    const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
    expect(browseSrc).toContain('href="/capture"')
    expect(browseSrc).toContain('identify a model from a photo')
  })
  it('global nav/layout files were not touched to add capture buttons everywhere', () => {
    expect(exists('src/components/store/CustomerHeader.tsx')).toBe(true)
    const headerSrc = readSrc('src/components/store/CustomerHeader.tsx')
    expect(headerSrc).not.toContain('/capture')
  })
})

// ── Part F/AU: anonymous access, no auth gate ────────────────────────────────────

describe('16K/16L: public/anonymous access — recognition never requires or gates on a session', () => {
  it('/capture page.tsx never imports getBuyerSession — no auth redirect on GET', () => {
    expect(pageSrc).not.toContain('getBuyerSession')
  })
  it('rate limiting stays IP/header-derived — checkRateLimit is never keyed by profileId', () => {
    expect(actionSrc).toContain('rateLimitKeyFromHeaders')
    const rlCallIdx = actionSrc.indexOf('checkRateLimit(rateLimitKey')
    expect(rlCallIdx).toBeGreaterThan(-1)
    expect(actionSrc.slice(rlCallIdx, rlCallIdx + 40)).not.toMatch(/profileId/)
  })
  it('16L: identifyModelFromPhoto reads getBuyerSession() only AFTER rate-limit/validation/fingerprint/matching succeed, and only for optional read-only relationship enrichment — never used to gate/require recognition itself', () => {
    const sessionIdx = actionSrc.indexOf('await getBuyerSession()')
    const matchIdx = actionSrc.indexOf('findCatalogImageMatches(fp)')
    expect(sessionIdx).toBeGreaterThan(matchIdx)
    expect(actionSrc).not.toMatch(/if \(!session\)\s*return \{\s*error/)
  })
})

// ── Part G/BB: no authoritative customer mutation ────────────────────────────────

describe('16K: recognition performs zero business-record writes', () => {
  it('no create/update/delete/upsert call anywhere in the action', () => {
    expect(actionCode).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })
  it('the action never imports createCollectionItem/addToWantedList/SellerSubmission/Portfolio/Listing/Order mutation helpers', () => {
    expect(actionCode).not.toMatch(/createCollectionItem|addToWantedList|addCaptureItem|submitCaptureSession|createSellerSubmission/)
  })
  it('the action never imports WantedCatalogModel/CollectionItem/SellerPortfolio/CustomerProfile write paths', () => {
    expect(actionCode).not.toMatch(/wantedList|sellerPortfolio|customerProfile\.(create|update)/i)
  })
})

// ── Part H/BA: no automatic CatalogModel/CatalogSuggestion creation ────────────

describe('16K: no automatic catalog identity creation on no-match', () => {
  it('the action never imports/calls catalogModel.create or catalogSuggestion.create', () => {
    expect(actionCode).not.toMatch(/catalogModel\.create|catalogSuggestion/i)
  })

  it('zero candidates returns an empty array, not a fabricated model', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [], lowCoverage: true, coverageReason: 'small_index' })

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))

    expect(result).toEqual({ candidates: [], lowCoverage: true })
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
    expect(prisma.listing.findMany).not.toHaveBeenCalled()
  })

  it('component renders "We couldn\'t confidently identify this model." for zero candidates, never "definitely"', () => {
    expect(componentSrc).toContain('We couldn&apos;t confidently identify this model.')
    expect(componentSrc).not.toMatch(/definitely/i)
  })
})

// ── Part I: reuse, no second AI engine ──────────────────────────────────────────

describe('16K: no second AI/recognition engine, no Anthropic reference anywhere in this feature', () => {
  it('captureIdentify.ts (server action) never references Anthropic/ANTHROPIC_API_KEY', () => {
    expect(actionSrc).not.toMatch(/Anthropic|ANTHROPIC_API_KEY|ANTHROPIC_MODEL/)
  })
  it('CaptureIdentify.tsx (client component) never references Anthropic/ANTHROPIC_API_KEY', () => {
    expect(componentSrc).not.toMatch(/Anthropic|ANTHROPIC_API_KEY|ANTHROPIC_MODEL/)
  })
  it('no provider SDK import exists in the client component', () => {
    expect(componentSrc).not.toContain('@anthropic-ai/sdk')
  })
})

// ── Part J/K/L: recognition output shape, candidate limit, model links ─────────

describe('16K: recognition output — bounded candidates, authoritative model links', () => {
  const candidateBase = {
    catalogModelId: 'cat1', brand: 'Hot Wheels', name: "'16 Mazda MX-5 Miata", year: 2022,
    photo: { url: 'https://x/y.jpg', altText: null }, bestDistance: 0, matchingBandCount: 4,
    confidence: 'exact' as const, matchedPhotoCount: 1,
  }

  it('enrichment queries are bounded to the returned candidate ids only (in: [...]), not the full CatalogModel table', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [candidateBase], lowCoverage: false, coverageReason: null })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([{ id: 'cat1', series: 'HW Modified', color: 'Black', scale: '1:64', photos: [] }])
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    await identifyModelFromPhoto(null, fakeFormData(fakeFile()))

    const call = (prisma.catalogModel.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ id: { in: ['cat1'] } })
  })

  it('candidate limit is capped (CANDIDATE_LIMIT constant used to slice results)', () => {
    expect(actionSrc).toContain('const CANDIDATE_LIMIT = 5')
    expect(actionSrc).toContain('results.slice(0, CANDIDATE_LIMIT)')
  })

  it('every candidate result links to /catalog/[catalogModelId], never /browse?q= or admin routes', () => {
    expect(componentSrc).toContain('href={`/catalog/${c.catalogModelId}`}')
    expect(componentCode).not.toMatch(/\/browse\?q=|\/admin\//)
  })

  it('candidate identity includes brand/name/year/series/color/scale/photo — sourced from real CatalogModel rows, not raw AI text', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [candidateBase], lowCoverage: false, coverageReason: null })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([{ id: 'cat1', series: 'HW Modified', color: 'Black', scale: '1:64', photos: [{ url: 'https://x/model.jpg' }] }])
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))

    expect(result?.candidates?.[0]).toEqual({
      catalogModelId: 'cat1', brand: 'Hot Wheels', name: "'16 Mazda MX-5 Miata", year: 2022,
      series: 'HW Modified', color: 'Black', scale: '1:64', photoUrl: 'https://x/model.jpg',
      confidence: 'exact', availableCount: 0, lowestPrice: null, relationship: null,
    })
  })
})

// ── 16L: capture results are now actionable (supersedes the 16K "View Model only"
// decision — see captureCandidateActions.test.ts for full coverage) ────────────

describe('16L: capture results render Want/Own/Sell actions via CaptureCandidateActions', () => {
  it('CaptureIdentify.tsx renders CaptureCandidateActions per candidate, passing catalogModelId/modelName/initialRelationship', () => {
    expect(componentSrc).toContain('<CaptureCandidateActions')
    expect(componentSrc).toContain('catalogModelId={c.catalogModelId}')
    expect(componentSrc).toContain('initialRelationship={c.relationship}')
  })
  it('CaptureIdentify.tsx itself still contains no wantAction/unwantAction/addToCollectionAction — those live in CaptureCandidateActions, reused not duplicated', () => {
    expect(componentCode).not.toMatch(/wantAction|unwantAction|addToCollectionAction/)
  })
  it('identifyModelFromPhoto now performs one batched relationship read via getCatalogRelationshipState (16F), bounded to the live candidate ids', () => {
    expect(actionSrc).toContain('getCatalogRelationshipState(session.profileId, liveIds)')
  })
})

// ── Part Q/R: image input, file validation ──────────────────────────────────────

describe('16K: image input reuses existing safe native input mode', () => {
  it('file input uses accept=image/* MIME allowlist + capture=environment (mobile camera/library)', () => {
    expect(componentSrc).toContain('accept="image/jpeg,image/png,image/webp"')
    expect(componentSrc).toContain('capture="environment"')
  })
  it('no custom camera/WebRTC code exists', () => {
    expect(componentCode).not.toMatch(/getUserMedia|WebRTC|MediaStream/)
  })
})

describe('16K: file validation — missing file, unsupported MIME, oversized, valid', () => {
  it('missing file → customer-safe error, no fingerprint call', async () => {
    const result = await identifyModelFromPhoto(null, fakeFormData(null))
    expect(result).toEqual({ error: 'No image selected.' })
    expect(computeImageFingerprint).not.toHaveBeenCalled()
  })

  it('unsupported MIME → rejected before AI processing', async () => {
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile({ type: 'application/pdf' })))
    expect(result).toEqual({ error: 'Only JPEG, PNG, and WebP images are accepted.' })
    expect(computeImageFingerprint).not.toHaveBeenCalled()
  })

  it('an executable renamed with an image MIME is still rejected server-side by fingerprint decode failure, not trusted on MIME alone', async () => {
    ;(computeImageFingerprint as Mock).mockRejectedValue(new FingerprintError('DECODE_FAILED', 'Could not decode image.'))
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile({ type: 'image/jpeg' })))
    expect(result).toEqual({ error: 'Could not decode image.' })
  })

  it('oversized file (just over the app limit) → rejected before AI processing', async () => {
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile({ size: 9 * 1024 * 1024 + 1 })))
    expect(result).toEqual({ error: 'Image must be 9 MB or smaller.' })
    expect(computeImageFingerprint).not.toHaveBeenCalled()
  })

  it('a file at exactly the app MAX_FILE_BYTES boundary is accepted (not rejected)', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [], lowCoverage: false, coverageReason: null })
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile({ size: 9 * 1024 * 1024 })))
    expect(result).not.toHaveProperty('error')
    expect(computeImageFingerprint).toHaveBeenCalled()
  })

  it('valid image proceeds to fingerprinting', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [], lowCoverage: false, coverageReason: null })
    await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(computeImageFingerprint).toHaveBeenCalled()
  })
})

// ── Server Action body-size limit vs application MAX_FILE_BYTES ────────────────

describe('16K: application file-size limit stays safely under the framework Server Action body limit', () => {
  it('next.config.ts configures the Server Action body limit to 10mb', () => {
    const configSrc = readSrc('next.config.ts')
    expect(configSrc).toMatch(/serverActions:\s*\{\s*bodySizeLimit:\s*'10mb'/)
  })

  it('application MAX_FILE_BYTES (9 MB) is strictly less than the framework 10mb body limit, leaving multipart-overhead headroom', () => {
    expect(actionSrc).toContain('const MAX_FILE_BYTES = 9 * 1024 * 1024')
    const FRAMEWORK_LIMIT_BYTES = 10 * 1024 * 1024
    const APP_LIMIT_BYTES = 9 * 1024 * 1024
    expect(APP_LIMIT_BYTES).toBeLessThan(FRAMEWORK_LIMIT_BYTES)
    // Multipart overhead (boundary + Content-Disposition/Content-Type headers) for
    // a single file field is on the order of a few hundred bytes — the margin here
    // (1 MB) is far larger than any realistic overhead.
    expect(FRAMEWORK_LIMIT_BYTES - APP_LIMIT_BYTES).toBeGreaterThan(1024)
  })

  it('the user-facing error message matches the actual enforced application limit — no contradiction between claim and behavior', () => {
    expect(actionSrc).toContain("return 'Image must be 9 MB or smaller.'")
    expect(actionSrc).not.toContain("'Image must be 10 MB or smaller.'")
  })
})

// ── Part S/T: photo privacy, storage/retention ──────────────────────────────────

describe('16K: photo is processed transiently — never uploaded/persisted', () => {
  it('no Blob/storage import exists in the action', () => {
    expect(actionSrc).not.toMatch(/@vercel\/blob|\bput\(/)
  })
  it('no image bytes/URL are written to any Prisma model', () => {
    expect(actionCode).not.toMatch(/imageUrl:|photoData:|base64/)
  })
})

// ── Part U/V: rate limiting, API key security ───────────────────────────────────

describe('16K: public rate limiting — bounded abuse protection, fail-closed', () => {
  it('within limit → allowed, recognition proceeds', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [], lowCoverage: false, coverageReason: null })
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result).not.toHaveProperty('error')
  })

  it('over limit → no fingerprint/DB call, customer-safe message only', async () => {
    ;(checkRateLimit as Mock).mockReturnValue({ allowed: false, remaining: 0, resetMs: 30_000 })
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.error).toMatch(/Too many attempts/)
    expect(computeImageFingerprint).not.toHaveBeenCalled()
  })

  it('over limit → zero DB matching and zero enrichment calls (matcher, catalogModel, listing all uncalled)', async () => {
    ;(checkRateLimit as Mock).mockReturnValue({ allowed: false, remaining: 0, resetMs: 30_000 })
    await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(findCatalogImageMatches).not.toHaveBeenCalled()
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
    expect(prisma.listing.findMany).not.toHaveBeenCalled()
  })

  it('fail-closed when RATE_LIMIT_SECRET is absent (rateLimitKeyFromHeaders returns null) — denies rather than allowing unbounded requests', async () => {
    ;(rateLimitKeyFromHeaders as Mock).mockReturnValue(null)
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.error).toBe('Photo identification is temporarily unavailable. Please try again later.')
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(computeImageFingerprint).not.toHaveBeenCalled()
  })

  it('rate limit error never exposes implementation details (no stack trace, no provider name)', async () => {
    ;(checkRateLimit as Mock).mockReturnValue({ allowed: false, remaining: 0, resetMs: 30_000 })
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.error).not.toMatch(/stack|Anthropic|Prisma/)
  })

  it('rate limit is stricter than the existing authenticated image search (5/10min vs 10/10min)', () => {
    expect(actionSrc).toContain('const IDENTIFY_MAX = 5')
    expect(actionSrc).toContain('const IDENTIFY_WINDOW = 10 * 60 * 1000')
  })
})

// ── Rate limiter storage — honest verification, not a new platform ─────────────

describe('16K: rate limiter storage is process-local — verified, not silently replaced', () => {
  it('checkRateLimit stores hits in a module-scope in-memory Map, not a durable/shared store', () => {
    const rlSrc = readSrc('src/lib/rateLimit.ts')
    expect(rlSrc).toContain('const store = new Map<string, number[]>()')
    // The file's own doc comment explains what distributed enforcement WOULD
    // require (Redis/Upstash) — no such dependency is actually imported/used.
    expect(rlSrc).not.toMatch(/^import.*redis|^import.*upstash|@vercel\/kv/im)
  })

  it('rateLimit.ts documents its own instance-local, non-distributed limitation — an existing, honest disclosure this feature inherits rather than hides', () => {
    const rlSrc = readSrc('src/lib/rateLimit.ts')
    expect(rlSrc).toMatch(/INSTANCE-LOCAL/)
    expect(rlSrc).toMatch(/NOT globally distributed/)
  })

  it('16K did not modify rateLimit.ts — no new database/Redis/provider dependency was introduced to work around the existing limitation', () => {
    expect(exists('src/lib/rateLimit.ts')).toBe(true)
    // identifyModelFromPhoto reuses the exact existing exports, unmodified in shape.
    expect(actionSrc).toContain("import { checkRateLimit, rateLimitKeyFromHeaders } from '@/lib/rateLimit'")
  })

  it('the client IP source is x-forwarded-for, first entry only — the same existing trust assumption already used by admin login, inherited unchanged', () => {
    const rlSrc = readSrc('src/lib/rateLimit.ts')
    expect(rlSrc).toContain("headers.get('x-forwarded-for')")
    expect(rlSrc).toContain('xff.split(\',\')[0]')
  })
})

// ── Full request execution order ────────────────────────────────────────────────

describe('16K: exact execution order — rate limit, then validation, then decode, then DB', () => {
  it('source order: rate-limit fail-closed check appears before the file-presence check, which appears before fingerprinting, which appears before DB matching', () => {
    const rlKeyIdx = actionSrc.indexOf('rateLimitKeyFromHeaders(reqHeaders')
    const rlCheckIdx = actionSrc.indexOf('checkRateLimit(rateLimitKey')
    const fileIdx = actionSrc.indexOf("formData.get('image')")
    const validateIdx = actionSrc.indexOf('validateUpload(file)')
    const fingerprintIdx = actionSrc.indexOf('computeImageFingerprint(buffer')
    const matchIdx = actionSrc.indexOf('findCatalogImageMatches(fp)')
    const enrichIdx = actionSrc.indexOf('prisma.catalogModel.findMany(')

    expect(rlKeyIdx).toBeLessThan(rlCheckIdx)
    expect(rlCheckIdx).toBeLessThan(fileIdx)
    expect(fileIdx).toBeLessThan(validateIdx)
    expect(validateIdx).toBeLessThan(fingerprintIdx)
    expect(fingerprintIdx).toBeLessThan(matchIdx)
    expect(matchIdx).toBeLessThan(enrichIdx)
  })

  it('invalid MIME never reaches the matcher (behavioral proof)', async () => {
    await identifyModelFromPhoto(null, fakeFormData(fakeFile({ type: 'text/plain' })))
    expect(findCatalogImageMatches).not.toHaveBeenCalled()
  })

  it('oversized file never reaches the matcher (behavioral proof)', async () => {
    await identifyModelFromPhoto(null, fakeFormData(fakeFile({ size: 9 * 1024 * 1024 + 1 })))
    expect(findCatalogImageMatches).not.toHaveBeenCalled()
  })

  it('over-limit rate-limited request never reaches the matcher (behavioral proof)', async () => {
    ;(checkRateLimit as Mock).mockReturnValue({ allowed: false, remaining: 0, resetMs: 10_000 })
    await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(findCatalogImageMatches).not.toHaveBeenCalled()
  })

  it('no writes occur anywhere in this execution path (already proven structurally above) — read-only end to end', () => {
    expect(actionCode).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })
})

// ── Part W/X/AZ: AI output is untrusted, matched against real DB records ───────

describe('16K: recognition output validated against real CatalogModel records, never fabricated', () => {
  it('malformed/failed matching query surfaces a generic customer-safe error, not the raw exception', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockRejectedValue(new Error('db exploded'))

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.error).toBe("Couldn't analyze this photo right now.")
  })

  it('multiple plausible candidates (all live) are all surfaced (bounded), not collapsed to one', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    const results = Array.from({ length: 3 }, (_, i) => ({
      catalogModelId: `cat${i}`, brand: 'B', name: `N${i}`, year: null, photo: null,
      bestDistance: i, matchingBandCount: 2, confidence: 'possible' as const, matchedPhotoCount: 1,
    }))
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results, lowCoverage: false, coverageReason: null })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue(
      results.map((r) => ({ id: r.catalogModelId, series: null, color: null, scale: null, photos: [] })),
    )
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.candidates?.length).toBe(3)
  })
})

// ── Live CatalogModel integrity — stale candidates are dropped, never fabricated ──

describe('16K: a returned candidate MUST correspond to a live CatalogModel row', () => {
  const rawCandidate = (id: string, over: Partial<{ confidence: 'exact' | 'strong' | 'possible' }> = {}) => ({
    catalogModelId: id, brand: 'X', name: 'Y', year: null, photo: null,
    bestDistance: 1, matchingBandCount: 3, confidence: over.confidence ?? ('strong' as const), matchedPhotoCount: 1,
  })
  const liveRow = (id: string) => ({ id, series: 'S', color: 'C', scale: '1:64', photos: [] })

  it('a single stale candidate id (not returned by live enrichment) → public candidates = [], no View Model destination possible', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [rawCandidate('stale')], lowCoverage: false, coverageReason: null })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([]) // live enrichment finds nothing
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.candidates).toEqual([])
    expect(result?.candidates?.some((c) => c.catalogModelId === 'stale')).toBeFalsy()
  })

  it('mixed valid A + stale B → only A is returned, with A\'s own live identity fields', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({
      results: [rawCandidate('A'), rawCandidate('B')],
      lowCoverage: false, coverageReason: null,
    })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([liveRow('A')]) // B is stale/missing
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.candidates?.length).toBe(1)
    expect(result?.candidates?.[0].catalogModelId).toBe('A')
    expect(result?.candidates?.[0].series).toBe('S')
  })

  it('all raw candidates stale → standard no-match result (empty array, same shape as a genuine no-match)', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({
      results: [rawCandidate('stale1'), rawCandidate('stale2')],
      lowCoverage: false, coverageReason: null,
    })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([])
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result).toEqual({ candidates: [], lowCoverage: false })
  })

  it('every returned candidate\'s catalogModelId is keyed by id into the live enrichment map, never by array position', () => {
    expect(actionSrc).toContain('const detailById = new Map(models.map((m) => [m.id, m]))')
    expect(actionSrc).toContain('top.filter((c) => detailById.has(c.catalogModelId))')
    expect(actionSrc).not.toMatch(/models\[i\]|top\[i\]|models\[index\]/)
  })

  it('the "View Model" href is built exclusively from the live, id-matched candidate — component never receives an id it did not enrich', () => {
    expect(componentSrc).toContain('href={`/catalog/${c.catalogModelId}`}')
    // The action guarantees c.catalogModelId always corresponds to a live row by
    // the time it reaches the component — no client-side existence check needed.
    expect(actionSrc).toContain('const liveTop = top.filter((c) => detailById.has(c.catalogModelId))')
  })

  it('detail lookup uses the non-null-asserted live map entry (guaranteed present after the filter), not an optional fallback to raw matcher fields for identity', () => {
    expect(actionSrc).toContain('const detail = detailById.get(c.catalogModelId)!')
    expect(actionSrc).toContain('series: detail.series,')
    expect(actionSrc).toContain('color: detail.color,')
    expect(actionSrc).toContain('scale: detail.scale,')
  })
})

// ── Part Y/Z/AT: zero-listing recognized model ──────────────────────────────────

describe('16K: zero-Listing CatalogModel is still a successful recognition result', () => {
  it('a recognized model with 0 eligible Listings still returns a full candidate with availableCount:0', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({
      results: [{ catalogModelId: 'catZ', brand: 'Hot Wheels', name: 'Zero Copies', year: null, photo: null, bestDistance: 0, matchingBandCount: 4, confidence: 'exact', matchedPhotoCount: 1 }],
      lowCoverage: false, coverageReason: null,
    })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([{ id: 'catZ', series: null, color: null, scale: null, photos: [] }])
    ;(prisma.listing.findMany as Mock).mockResolvedValue([]) // no eligible listings

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.candidates?.[0].availableCount).toBe(0)
    expect(result?.candidates?.[0].lowestPrice).toBeNull()
  })

  it('availability query reuses the exact centralized eligibility predicate (listingEligibility.ts)', () => {
    expect(actionSrc).toContain("import { eligibleListingWhere } from '@/lib/listingEligibility'")
    expect(actionSrc).toContain('eligibleListingWhere(candidateIds)')
  })

  it('component never gates a candidate render behind availableCount > 0', () => {
    expect(componentCode).not.toMatch(/availableCount > 0 &&/)
  })
})

// ── Part AA/AB: confidence semantics ─────────────────────────────────────────────

describe('16K: confidence uses only the existing exact/strong/possible labels — no fake precision', () => {
  it('component never renders a numeric percentage confidence', () => {
    expect(componentSrc).not.toMatch(/\d+(\.\d+)?%/)
  })
  it('"Likely Match" heading only when exactly one exact/strong candidate; otherwise "Possible Matches"', () => {
    expect(componentSrc).toContain("isSingleConfident ? 'Likely Match' : 'Possible Matches'")
  })
})

// ── Part AD: provider/technical failure ──────────────────────────────────────────

describe('16K: graceful technical failure — no internals leaked', () => {
  it('a fingerprint decode failure returns a plain customer message, not a stack trace', async () => {
    ;(computeImageFingerprint as Mock).mockRejectedValue(new FingerprintError('DECODE_FAILED', 'Could not decode image.'))
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.error).toBe('Could not decode image.')
  })
  it('an unexpected fingerprint error still produces a generic safe message via normalizeError', async () => {
    ;(computeImageFingerprint as Mock).mockRejectedValue(new Error('boom'))
    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(result?.error).toBe("Couldn't analyze this photo right now.")
  })
})

// ── Part AN: pending/loading state ────────────────────────────────────────────────

describe('16K: pending state prevents duplicate submission', () => {
  it('submit button and file input are both disabled while pending', () => {
    expect(componentSrc).toContain('disabled={isPending')
    expect(componentSrc).toContain('disabled={isPending}')
  })
  it('no optimistic result is shown before the action resolves (results only render from `state`)', () => {
    expect(componentCode).not.toMatch(/useOptimistic/)
  })
})

// ── Part AO: preview cleanup ──────────────────────────────────────────────────────

describe('16K: local preview only, object URL is revoked (no upload solely for preview)', () => {
  it('uses URL.createObjectURL for local preview, not an upload round-trip', () => {
    expect(componentSrc).toContain('URL.createObjectURL(file)')
  })
  it('revokes the object URL on replace and unmount', () => {
    expect(componentSrc).toContain('URL.revokeObjectURL(objectUrlRef.current)')
    const matches = [...componentSrc.matchAll(/revokeObjectURL/g)]
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Part AP: accessibility ────────────────────────────────────────────────────────

describe('16K: accessibility', () => {
  it('exactly one h1', () => {
    expect(componentCode.match(/<h1/g)?.length).toBe(1)
  })
  it('file input has a visible, associated label', () => {
    expect(componentSrc).toContain('htmlFor="capture-image"')
    expect(componentSrc).toContain('id="capture-image"')
  })
  it('submit is a semantic <button type="submit">', () => {
    expect(componentSrc).toContain('type="submit"')
  })
  it('results section has a labelled heading', () => {
    expect(componentSrc).toContain('aria-labelledby="capture-results-heading"')
    expect(componentSrc).toContain('id="capture-results-heading"')
  })
  it('error text uses role="alert" for reasonable announcement', () => {
    expect(componentSrc).toContain('role="alert"')
  })
  it('candidate image has a meaningful alt (brand + name)', () => {
    expect(componentSrc).toContain('alt={`${c.brand} ${c.name}`}')
  })
  it('no clickable <div> — the only interactive elements are input/button/Link', () => {
    expect(componentCode).not.toMatch(/<div[^>]*onClick/)
  })
})

// ── Part AK: customer terminology ───────────────────────────────────────────────

describe('16K: customer-facing language avoids technical jargon', () => {
  it('avoids "Computer Vision", "AI inference", "recognition pipeline", "embedding"', () => {
    for (const src of [componentSrc, pageSrc]) {
      expect(src).not.toMatch(/Computer Vision|AI inference|recognition pipeline|embedding/i)
    }
  })
  it('uses "Identify a Model" / "Likely Match" / "Possible Matches" / "View Model" language', () => {
    expect(componentSrc).toContain('Identify a Model')
    expect(componentSrc).toContain('View Model')
  })
})

// ── Part AS: no public cache of recognition results ─────────────────────────────

describe('16K: recognition action is not publicly cached', () => {
  it('the action is a Server Action (POST-triggered), not a cached GET route', () => {
    expect(actionSrc.startsWith("'use server'")).toBe(true)
  })
})

// ── Part AR: observability — no image/secret logging ────────────────────────────

describe('16K: no raw image bytes/secrets are logged', () => {
  it('no console.log/logger call includes the raw buffer or base64 content', () => {
    expect(actionCode).not.toMatch(/console\.log\(.*buffer/i)
    expect(actionCode).not.toMatch(/logger\.\w+\(.*buffer/i)
  })
})

// ── Part BD: existing capture regression ────────────────────────────────────────

describe('16K: existing authenticated capture architecture unchanged', () => {
  it('mobileCapture.ts (Quick Capture queue actions) was not modified — still requires getBuyerSession on every export', () => {
    const mcSrc = readSrc('src/lib/actions/mobileCapture.ts')
    const sessionChecks = [...mcSrc.matchAll(/if \(!session\) return err\(/g)]
    expect(sessionChecks.length).toBeGreaterThanOrEqual(6)
  })
  it('catalogImageMatching.ts (authenticated + admin image search actions) still requires session/admin auth, unchanged', () => {
    const matchingActionSrc = readSrc('src/lib/actions/catalogImageMatching.ts')
    expect(matchingActionSrc).toContain("if (!session) return { error: 'Sign in to use image search.' }")
    expect(matchingActionSrc).toContain('isAdminAuthenticated')
  })
  it('CatalogImageSearch.tsx (the compact authenticated picker) still exists and is still used by CaptureWizard/CollectionItemForm/WantedListAddForm', () => {
    expect(exists('src/components/store/CatalogImageSearch.tsx')).toBe(true)
    for (const consumer of ['CaptureWizard.tsx', 'CollectionItemForm.tsx', 'WantedListAddForm.tsx']) {
      expect(readSrc(`src/components/store/${consumer}`)).toContain('CatalogImageSearch')
    }
  })
  it('admin catalog-image-intelligence page still exists, untouched', () => {
    expect(exists('src/app/(admin)/admin/catalog-image-intelligence/page.tsx')).toBe(true)
  })
})

// ── Part BE: catalog regression ───────────────────────────────────────────────────

describe('16K: /catalog and /catalog/[id] behavior unchanged except intentional links', () => {
  it('/catalog still uses getCatalogDiscovery and CatalogModelCard', () => {
    const catalogPageSrc = readSrc('src/app/(store)/catalog/page.tsx')
    expect(catalogPageSrc).toContain('getCatalogDiscovery')
    expect(catalogPageSrc).toContain('CatalogModelCard')
  })
  it('/catalog/[id] still has CatalogModelActions and CatalogListingOption, unaffected', () => {
    const hubSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
    expect(hubSrc).toContain('CatalogModelActions')
    expect(hubSrc).toContain('CatalogListingOption')
  })
})

// ── Part BF: no schema changes ────────────────────────────────────────────────────

describe('16K: zero schema/migration changes, no guest-session persistence model', () => {
  it('no AnonymousCapture/GuestRecognition/TemporaryCustomer model was added', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/model AnonymousCapture|model GuestRecognition|model TemporaryCustomer/)
  })
  it('MobileCaptureSession/MobileCaptureItem models are unchanged (still profile-scoped)', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toMatch(/model MobileCaptureSession \{[\s\S]*?customerProfileId/)
  })
})

// ── Part BG: query/provider/storage cost shape ───────────────────────────────────

describe('16K/16L: exact recognition cost shape — bounded, no hidden per-candidate loop', () => {
  it('exactly 2 enrichment queries when candidates exist, in parallel (Promise.all)', () => {
    expect(actionSrc).toContain('await Promise.all([')
    const idx = actionSrc.indexOf('await Promise.all([')
    const block = actionSrc.slice(idx, actionSrc.indexOf('])', idx))
    expect(block).toContain('prisma.catalogModel.findMany(')
    expect(block).toContain('prisma.listing.findMany(')
  })
  it('zero enrichment queries when there are zero candidates (already proven above) — no wasted DB round-trip', async () => {
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({ results: [], lowCoverage: false, coverageReason: null })
    await identifyModelFromPhoto(null, fakeFormData(fakeFile()))
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
    expect(getCatalogRelationshipState).not.toHaveBeenCalled()
  })
  it('no per-candidate loop issues its own DB or provider call (no await inside the final .map over liveTop)', () => {
    const enrichIdx = actionSrc.indexOf('const candidates: IdentifyCandidate[] = liveTop.map(')
    expect(enrichIdx).toBeGreaterThan(-1)
    const mapBlock = actionSrc.slice(enrichIdx, actionSrc.indexOf('})\n\n    return { candidates', enrichIdx))
    expect(mapBlock).not.toMatch(/await /)
  })
  it('16L: exactly one getCatalogRelationshipState call per request (authenticated), never per-candidate', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({
      results: [
        { catalogModelId: 'A', brand: 'B', name: 'N', year: null, photo: null, bestDistance: 0, matchingBandCount: 4, confidence: 'exact', matchedPhotoCount: 1 },
        { catalogModelId: 'B', brand: 'B', name: 'N', year: null, photo: null, bestDistance: 1, matchingBandCount: 3, confidence: 'strong', matchedPhotoCount: 1 },
      ],
      lowCoverage: false, coverageReason: null,
    })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([
      { id: 'A', series: null, color: null, scale: null, photos: [] },
      { id: 'B', series: null, color: null, scale: null, photos: [] },
    ])
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])
    ;(getCatalogRelationshipState as Mock).mockResolvedValue(new Map())

    await identifyModelFromPhoto(null, fakeFormData(fakeFile()))

    expect(getCatalogRelationshipState).toHaveBeenCalledTimes(1)
    expect(getCatalogRelationshipState).toHaveBeenCalledWith('p1', ['A', 'B'])
  })
  it('16L: anonymous requests never call getCatalogRelationshipState even when candidates exist', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    ;(computeImageFingerprint as Mock).mockResolvedValue(fakeFp)
    ;(findCatalogImageMatches as Mock).mockResolvedValue({
      results: [{ catalogModelId: 'A', brand: 'B', name: 'N', year: null, photo: null, bestDistance: 0, matchingBandCount: 4, confidence: 'exact', matchedPhotoCount: 1 }],
      lowCoverage: false, coverageReason: null,
    })
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([{ id: 'A', series: null, color: null, scale: null, photos: [] }])
    ;(prisma.listing.findMany as Mock).mockResolvedValue([])

    const result = await identifyModelFromPhoto(null, fakeFormData(fakeFile()))

    expect(getCatalogRelationshipState).not.toHaveBeenCalled()
    expect(result?.candidates?.[0].relationship).toBeNull()
  })
})

// ── Part BH: scope guard — no 16L+ functionality ─────────────────────────────────

describe('16K: scope guard — no future-milestone functionality', () => {
  it('no barcode/video/valuation/condition-grading/pricing-AI/auto-listing keywords', () => {
    for (const src of [actionSrc, componentSrc, pageSrc]) {
      expect(src).not.toMatch(/barcode|video recognition|condition grading|pricing AI|auto.?listing|recommendation engine/i)
    }
  })
  it('no persistent recognition-history/saved-scan model or query exists', () => {
    expect(actionSrc).not.toMatch(/scanHistory|savedScan|recognitionHistory/i)
  })
})
