/**
 * 13B Mobile Intake Capture — structural and security tests.
 * Tests source structure, types, validation logic, and action exports.
 * Does not require DB or network.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')
const src  = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

const schemaSrc    = src('prisma/schema.prisma')
const actionsSrc   = src('src/lib/actions/mobileCapture.ts')
const wizardSrc    = src('src/components/store/CaptureWizard.tsx')
const reviewSrc    = src('src/components/store/CaptureReview.tsx')
const capturePage  = src('src/app/(store)/account/capture/page.tsx')
const reviewPage   = src('src/app/(store)/account/capture/review/page.tsx')
const sellCapture  = src('src/app/(store)/account/sell/capture/page.tsx')
const layoutSrc    = src('src/app/(store)/layout.tsx')
const migSrc       = src('prisma/migrations/20260805060000_add_mobile_capture/migration.sql')
const partialMigSrc = src('prisma/migrations/20260805070000_add_capture_session_partial_unique/migration.sql')

// ── Schema: MobileCaptureSession ──────────────────────────────────────────────

describe('schema: MobileCaptureSession', () => {
  it('model exists in schema', () => {
    expect(schemaSrc).toContain('model MobileCaptureSession')
  })
  it('has customerProfileId field', () => {
    expect(schemaSrc).toContain('customerProfileId')
  })
  it('has destination field', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureSession')
    expect(schemaSrc.indexOf('destination', idx)).toBeGreaterThan(idx)
  })
  it('has status field defaulting to draft', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureSession')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain("@default(\"draft\")")
  })
  it('has relation to CustomerProfile', () => {
    expect(schemaSrc).toContain('CustomerProfile')
    expect(schemaSrc).toContain('captureSessions')
  })
  it('has composite index on customerProfileId+status', () => {
    expect(schemaSrc).toContain('@@index([customerProfileId, status])')
  })
  it('has items relation to MobileCaptureItem', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureSession')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('MobileCaptureItem')
  })
  it('does not store image bytes, filename, fingerprint, match score, or customer-supplied profileId', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureSession')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).not.toContain('imageBytes')
    expect(body).not.toContain('filename')
    expect(body).not.toContain('fingerprint')
    expect(body).not.toContain('matchScore')
    expect(body).not.toContain('suppliedProfileId')
  })
})

// ── Schema: MobileCaptureItem ─────────────────────────────────────────────────

describe('schema: MobileCaptureItem', () => {
  it('model exists in schema', () => {
    expect(schemaSrc).toContain('model MobileCaptureItem')
  })
  it('has sessionId FK', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('sessionId')
  })
  it('has catalogModelId FK', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('catalogModelId')
  })
  it('has clientToken field for idempotency', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('clientToken')
  })
  it('has unique constraint on sessionId+clientToken', () => {
    expect(schemaSrc).toContain('@@unique([sessionId, clientToken])')
  })
  it('has isPublic field', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('isPublic')
  })
  it('has saleTypePreference field', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('saleTypePreference')
  })
  it('has cascade delete from session', () => {
    expect(schemaSrc).toContain('onDelete: Cascade')
  })
  it('has updatedAt for stale-check support', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('@updatedAt')
  })
  it('does not store image bytes, filename, queryImageUrl, matchScore, or image fingerprint hash', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).not.toContain('imageBytes')
    expect(body).not.toContain('queryImage')
    expect(body).not.toContain('filename')
    expect(body).not.toContain('matchScore')
    expect(body).not.toContain('imageFingerprint')
    expect(body).not.toContain('dHash')
    // payloadFingerprint IS intentionally stored (server-computed SHA-256 of item payload)
    expect(body).toContain('payloadFingerprint')
  })
})

describe('schema: CatalogModel has captureItems relation', () => {
  it('CatalogModel references MobileCaptureItem', () => {
    const idx = schemaSrc.indexOf('model CatalogModel')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('captureItems')
  })
})

// ── Migration: initial tables ─────────────────────────────────────────────────

describe('migration: 20260805060000_add_mobile_capture', () => {
  it('creates MobileCaptureSession table', () => {
    expect(migSrc).toContain('CREATE TABLE "MobileCaptureSession"')
  })
  it('creates MobileCaptureItem table', () => {
    expect(migSrc).toContain('CREATE TABLE "MobileCaptureItem"')
  })
  it('adds unique index for idempotency', () => {
    expect(migSrc).toContain('MobileCaptureItem_sessionId_clientToken_key')
  })
  it('adds composite index for draft session lookup', () => {
    expect(migSrc).toContain('MobileCaptureSession_customerProfileId_status_idx')
  })
  it('adds FK from session to CustomerProfile with CASCADE', () => {
    expect(migSrc).toContain('ON DELETE CASCADE')
    expect(migSrc).toContain('"CustomerProfile"')
  })
  it('adds FK from item to MobileCaptureSession with CASCADE', () => {
    expect(migSrc).toContain('"MobileCaptureSession"')
  })
  it('adds FK from item to CatalogModel', () => {
    expect(migSrc).toContain('"CatalogModel"')
  })
})

// ── Migration: partial unique index ──────────────────────────────────────────

describe('migration: 20260805070000_add_capture_session_partial_unique', () => {
  it('creates partial unique index on customerProfileId+destination WHERE status=draft', () => {
    expect(partialMigSrc).toContain("MobileCaptureSession_one_draft_per_dest_key")
    expect(partialMigSrc).toContain("customerProfileId")
    expect(partialMigSrc).toContain("destination")
    expect(partialMigSrc).toContain("draft")
  })
  it('is a partial index (WHERE clause)', () => {
    expect(partialMigSrc).toContain("WHERE")
  })
  it('allows multiple submitted sessions (no constraint on non-draft)', () => {
    // Partial index only covers draft rows — submitted rows are unconstrained
    expect(partialMigSrc).not.toContain("WHERE status = 'submitted'")
  })
})

// ── Server actions: exports ───────────────────────────────────────────────────

describe('mobileCapture actions: exports', () => {
  it('exports getOrCreateDraftSession', () => {
    expect(actionsSrc).toContain('export async function getOrCreateDraftSession')
  })
  it('exports addCaptureItem', () => {
    expect(actionsSrc).toContain('export async function addCaptureItem')
  })
  it('exports updateCaptureItem', () => {
    expect(actionsSrc).toContain('export async function updateCaptureItem')
  })
  it('exports removeCaptureItem', () => {
    expect(actionsSrc).toContain('export async function removeCaptureItem')
  })
  it('exports getCaptureSession', () => {
    expect(actionsSrc).toContain('export async function getCaptureSession')
  })
  it('exports submitCaptureSession', () => {
    expect(actionsSrc).toContain('export async function submitCaptureSession')
  })
  it('exports checkCollectionDuplicate', () => {
    expect(actionsSrc).toContain('export async function checkCollectionDuplicate')
  })
  it('exports updateExistingCollectionQuantity', () => {
    expect(actionsSrc).toContain('export async function updateExistingCollectionQuantity')
  })
  it("has 'use server' directive", () => {
    expect(actionsSrc.startsWith("'use server'")).toBe(true)
  })
})

// ── Auth checks ───────────────────────────────────────────────────────────────

describe('mobileCapture actions: auth checks', () => {
  it('all exported actions call getBuyerSession', () => {
    const calls = (actionsSrc.match(/getBuyerSession\(\)/g) ?? []).length
    expect(calls).toBeGreaterThanOrEqual(7)
  })
  it('all actions guard on null session', () => {
    const guards = (actionsSrc.match(/if \(!session\)/g) ?? []).length
    expect(guards).toBeGreaterThanOrEqual(7)
  })
  it('ownership verified via customerProfileId in session lookups (not browser-supplied)', () => {
    const ownershipChecks = (actionsSrc.match(/customerProfileId: session\.profileId/g) ?? []).length
    expect(ownershipChecks).toBeGreaterThanOrEqual(5)
  })
  it('updateExistingCollectionQuantity scopes update to profileId', () => {
    const idx = actionsSrc.indexOf('export async function updateExistingCollectionQuantity')
    const body = actionsSrc.slice(idx, idx + 1200)
    expect(body).toContain('profileId: session.profileId')
  })
})

// ── Input validation ──────────────────────────────────────────────────────────

describe('mobileCapture actions: input validation', () => {
  it('validates destination against allowlist', () => {
    expect(actionsSrc).toContain("VALID_DESTINATIONS")
    expect(actionsSrc).toContain("'collection'")
    expect(actionsSrc).toContain("'sell'")
  })
  it('validates condition against allowlist', () => {
    expect(actionsSrc).toContain("VALID_CONDITIONS")
    expect(actionsSrc).toContain("'mint'")
    expect(actionsSrc).toContain("'damaged'")
  })
  it('validates saleTypePreference against allowlist', () => {
    expect(actionsSrc).toContain("VALID_SALE_TYPES")
    expect(actionsSrc).toContain("'consignment'")
    expect(actionsSrc).toContain("'buyout'")
    expect(actionsSrc).toContain("'unsure'")
  })
  it('validates quantity bounds 1-999', () => {
    expect(actionsSrc).toContain('Quantity must be 1–999')
  })
  it('validates notes length max 500', () => {
    expect(actionsSrc).toContain('Notes must be 500 characters or fewer')
  })
  it('validates notes for control characters', () => {
    expect(actionsSrc).toContain('[\\x00-\\x1F\\x7F]')
  })
  it('requires clientToken in addCaptureItem', () => {
    expect(actionsSrc).toContain('Client token is required')
  })
  it('verifies catalogModel server-side before adding item', () => {
    expect(actionsSrc).toContain("prisma.catalogModel.findUnique")
    expect(actionsSrc).toContain("Catalog model not found")
  })
  it('updateExistingCollectionQuantity validates target 1-999', () => {
    const idx = actionsSrc.indexOf('export async function updateExistingCollectionQuantity')
    const body = actionsSrc.slice(idx, idx + 1200)
    expect(body).toContain('Quantity must be 1–999')
    expect(body).toContain('Number.isInteger')
  })
})

// ── Concurrent session creation ───────────────────────────────────────────────

describe('mobileCapture: concurrent draft-session creation', () => {
  it('getOrCreateDraftSession handles P2002 by re-fetching', () => {
    // The partial unique index on (customerProfileId, destination) WHERE status='draft'
    // causes concurrent creates to P2002. The action catches and re-fetches.
    expect(actionsSrc).toContain('isPrismaP2002(e)')
    const idx = actionsSrc.indexOf('getOrCreateDraftSession')
    const body = actionsSrc.slice(idx, idx + 800)
    expect(body).toContain('P2002')
    expect(body).toContain('findFirst')
  })
  it('isPrismaP2002 checks PrismaClientKnownRequestError code P2002', () => {
    expect(actionsSrc).toContain("e.code === 'P2002'")
    expect(actionsSrc).toContain('PrismaClientKnownRequestError')
  })
  it('partial unique index migration exists to back the P2002 recovery', () => {
    expect(partialMigSrc).toContain('MobileCaptureSession_one_draft_per_dest_key')
  })
})

// ── Client-token idempotency ──────────────────────────────────────────────────

describe('mobileCapture: client-token idempotency', () => {
  it('addCaptureItem uses create (not upsert) to get P2002 on duplicate token', () => {
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const body = actionsSrc.slice(idx, idx + 4000)
    expect(body).toContain('mobileCaptureItem.create')
    expect(body).not.toContain('mobileCaptureItem.upsert')
  })
  it('catches P2002 and re-fetches authoritative existing row', () => {
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const body = actionsSrc.slice(idx, idx + 7000)
    expect(body).toContain('isPrismaP2002(e)')
    expect(body).toContain('mobileCaptureItem.findUnique')
    expect(body).toContain('sessionId_clientToken')
  })
  it('detects same token with different payload fingerprint as idempotency conflict', () => {
    expect(actionsSrc).toContain('Client token conflict')
    expect(actionsSrc).toContain('existing.payloadFingerprint !== payloadFingerprint')
  })
  it('returns existing item unchanged on exact retry (same payload)', () => {
    // After P2002, re-fetched row is returned if fingerprint matches
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const body = actionsSrc.slice(idx, idx + 7000)
    const p2002Idx = body.indexOf('isPrismaP2002(e)')
    const afterP2002 = body.slice(p2002Idx, p2002Idx + 1000)
    expect(afterP2002).toContain('return ok(')
    expect(afterP2002).toContain('existing.')
  })
  it('concurrent adds with same clientToken produce exactly one row', () => {
    // Backed by @@unique([sessionId, clientToken]) in schema — one create wins, other P2002s
    expect(schemaSrc).toContain('@@unique([sessionId, clientToken])')
  })
})

// ── Stale-check on update ─────────────────────────────────────────────────────

describe('mobileCapture: stale-check on update', () => {
  it('updateCaptureItem uses updateMany with updatedAt condition', () => {
    expect(actionsSrc).toContain('mobileCaptureItem.updateMany')
    expect(actionsSrc).toContain('updatedAt: new Date(updatedAt)')
  })
  it('returns stale error when count is 0', () => {
    expect(actionsSrc).toContain('Item was modified elsewhere. Please refresh.')
  })
})

// ── Remove stale/idempotent behavior ─────────────────────────────────────────

describe('mobileCapture: removeCaptureItem', () => {
  it('uses deleteMany with ownership scope (id + sessionId)', () => {
    const idx = actionsSrc.indexOf('export async function removeCaptureItem')
    const body = actionsSrc.slice(idx, idx + 800)
    expect(body).toContain('deleteMany')
    expect(body).toContain('id: itemId')
    expect(body).toContain('sessionId')
  })
  it('returns clean result when row already removed (idempotent)', () => {
    const idx = actionsSrc.indexOf('export async function removeCaptureItem')
    const body = actionsSrc.slice(idx, idx + 800)
    expect(body).toContain('result.count')
    expect(body).toContain('removed: result.count > 0')
  })
})

// ── Session ownership and status guard ───────────────────────────────────────

describe('mobileCapture: session ownership and status guard', () => {
  it('all mutating actions check status is draft', () => {
    const draftChecks = (actionsSrc.match(/status !== 'draft'/g) ?? []).length
    expect(draftChecks).toBeGreaterThanOrEqual(4)
  })
  it('submit rejects empty queue', () => {
    expect(actionsSrc).toContain('NO_ITEMS')
  })
  it('submit rejects already-submitted session', () => {
    expect(actionsSrc).toContain('SESSION_NOT_DRAFT')
  })
})

// ── Batch submission: transaction with FOR UPDATE ─────────────────────────────

describe('mobileCapture: submission atomicity', () => {
  it('submitCaptureSession wraps conversions in a transaction', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain('$transaction')
  })
  it('acquires FOR UPDATE lock on session row before converting', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain('FOR UPDATE')
    expect(body).toContain('"MobileCaptureSession"')
  })
  it('re-reads session status after lock is held', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 6000)
    // findFirst inside transaction (after lock) re-checks status
    expect(body).toContain("tx.mobileCaptureSession.findFirst")
  })
  it('marks session submitted inside the same transaction', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain("tx.mobileCaptureSession.update")
    expect(body).toContain("status: 'submitted'")
  })
  it('any failure throws and rolls back all conversions', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain("throw")
    expect(body).toContain("COLLECTION_DUPLICATE")
  })
  it('transaction has a timeout', () => {
    expect(actionsSrc).toContain('timeout: 30_000')
  })
})

// ── Concurrent submit protection ──────────────────────────────────────────────

describe('mobileCapture: concurrent submit', () => {
  it('FOR UPDATE lock serializes concurrent submits', () => {
    // Second submit blocks on the lock; after first commits (status=submitted),
    // second reads status!='draft' and returns SESSION_NOT_DRAFT error.
    expect(actionsSrc).toContain('FOR UPDATE')
    expect(actionsSrc).toContain('SESSION_NOT_DRAFT')
    expect(actionsSrc).toContain('Session already submitted.')
  })
  it('rate limit on submit prevents burst', () => {
    expect(actionsSrc).toContain('capture_submit:${session.profileId}')
    expect(actionsSrc).toContain('CAPTURE_SUB_MAX')
    expect(actionsSrc).toContain('CAPTURE_SUB_WINDOW')
  })
})

// ── Collection duplicate: explicit resolution ─────────────────────────────────

describe('mobileCapture: collection duplicate resolution', () => {
  it('checkCollectionDuplicate returns existing item id, quantity, and updatedAt', () => {
    expect(actionsSrc).toContain('ExistingCollectionInfo')
    expect(actionsSrc).toContain('isDuplicate: true')
    expect(actionsSrc).toContain('existing:')
    expect(actionsSrc).toContain('updatedAt: existing.updatedAt.toISOString()')
  })
  it('updateExistingCollectionQuantity uses updateMany with profileId+updatedAt stale check', () => {
    const idx = actionsSrc.indexOf('export async function updateExistingCollectionQuantity')
    const body = actionsSrc.slice(idx, idx + 1200)
    expect(body).toContain('collectionItem.updateMany')
    expect(body).toContain('profileId: session.profileId')
    expect(body).toContain('updatedAt: new Date(expectedUpdatedAt)')
  })
  it('updateExistingCollectionQuantity uses target quantity (absolute, not delta) for retry safety', () => {
    const idx = actionsSrc.indexOf('export async function updateExistingCollectionQuantity')
    const body = actionsSrc.slice(idx, idx + 1200)
    expect(body).toContain('targetQty')
    expect(body).toContain('quantity: targetQty')
  })
  it('returns stale error when row was modified elsewhere', () => {
    const idx = actionsSrc.indexOf('export async function updateExistingCollectionQuantity')
    const body = actionsSrc.slice(idx, idx + 1200)
    expect(body).toContain('Collection item was modified elsewhere')
  })
  it('wizard shows dup_resolution step when duplicate detected', () => {
    expect(wizardSrc).toContain("'dup_resolution'")
    expect(wizardSrc).toContain('existingItem')
    expect(wizardSrc).toContain('handleUpdateExisting')
    expect(wizardSrc).toContain('handleSkipDuplicate')
  })
  it('wizard skip: does not add item to queue, goes back to capture step', () => {
    const idx = wizardSrc.indexOf('function handleSkipDuplicate')
    const body = wizardSrc.slice(idx, idx + 200)
    expect(body).toContain("setStep('capture')")
    expect(body).not.toContain('addCaptureItem')
  })
  it('wizard update-existing: calls updateExistingCollectionQuantity with target qty', () => {
    expect(wizardSrc).toContain('updateExistingCollectionQuantity')
    expect(wizardSrc).toContain('existingItem.updatedAt')
  })
  it('submit: collection duplicate inside transaction causes full rollback', () => {
    expect(actionsSrc).toContain('COLLECTION_DUPLICATE')
    expect(actionsSrc).toContain('throw Object.assign')
  })
  it('wizard shows current quantity in resolution UI', () => {
    expect(wizardSrc).toContain('existingItem.quantity')
  })
})

// ── Seller submission: records created ───────────────────────────────────────

describe('mobileCapture: seller submission records', () => {
  it('creates only SellerSubmission with status submitted', () => {
    const idx = actionsSrc.indexOf("sellerSubmission.create")
    const body = actionsSrc.slice(idx, idx + 900)
    expect(body).toContain("status: 'submitted'")
  })
  it('does not create ItemInstance, Listing, Order, or OrderItem', () => {
    expect(actionsSrc).not.toContain('itemInstance.create')
    expect(actionsSrc).not.toContain('listing.create')
    expect(actionsSrc).not.toContain('order.create')
    expect(actionsSrc).not.toContain('orderItem.create')
  })
  it('does not create SellerAgreement, SellerInboundShipment, or SellerPayout', () => {
    expect(actionsSrc).not.toContain('sellerAgreement.create')
    expect(actionsSrc).not.toContain('sellerInboundShipment.create')
    expect(actionsSrc).not.toContain('sellerPayout.create')
    expect(actionsSrc).not.toContain('sellerPayoutLine.create')
  })
  it('does not create pricing guidance or pricingPreference', () => {
    expect(actionsSrc).not.toContain('pricingPreference.create')
    expect(actionsSrc).not.toContain('sellerPricingPreference')
  })
  it('collects saleTypePreference before conversion', () => {
    expect(actionsSrc).toContain('saleTypePreference: item.saleTypePreference')
  })
  it('each capture item creates one seller submission (separate submissions per item)', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain('for (const item of')
    expect(body).toContain('tx.sellerSubmission.create')
  })
})

// ── Query-image privacy ───────────────────────────────────────────────────────

describe('mobileCapture: query-image privacy', () => {
  it('wizard uses existing searchCatalogByImage action (12G-C)', () => {
    expect(wizardSrc).toContain('searchCatalogByImage')
    expect(wizardSrc).toContain('CatalogImageSearch')
  })
  it('no image bytes, URL, filename, or image hash stored in capture items', () => {
    expect(actionsSrc).not.toContain('imageUrl')
    expect(actionsSrc).not.toContain('imageBytes')
    expect(actionsSrc).not.toContain('filename')
    expect(actionsSrc).not.toContain('dHash')
    expect(actionsSrc).not.toContain('imageFingerprint')
    // payloadFingerprint IS present — it is the server-computed SHA-256 of item data, not image data
    expect(actionsSrc).toContain('payloadFingerprint')
    expect(actionsSrc).not.toContain('queryImageFingerprint')
  })
  it('no Blob upload in actions', () => {
    expect(actionsSrc).not.toContain('blob')
    expect(actionsSrc).not.toContain('Blob')
  })
  it('no external AI/API calls in capture actions', () => {
    expect(actionsSrc).not.toContain('anthropic')
    expect(actionsSrc).not.toContain('openai')
    expect(actionsSrc).not.toContain('fetch(')
  })
  it('wizard does not send image bytes to server actions', () => {
    const addIdx = wizardSrc.indexOf('addCaptureItem')
    // addCaptureItem call should not pass any image-related prop
    const callBody = wizardSrc.slice(addIdx, addIdx + 300)
    expect(callBody).not.toContain('image')
    expect(callBody).not.toContain('photo')
    expect(callBody).not.toContain('file')
  })
})

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('mobileCapture: rate limiting', () => {
  it('addCaptureItem rate-limited before any DB work', () => {
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const sessionIdx = actionsSrc.indexOf('getBuyerSession', idx)
    const rateLimitIdx = actionsSrc.indexOf('checkRateLimit', idx)
    const dbWorkIdx = actionsSrc.indexOf('mobileCaptureSession.findFirst', idx)
    // Rate limit check before DB lookup
    expect(rateLimitIdx).toBeLessThan(dbWorkIdx)
    expect(rateLimitIdx).toBeGreaterThan(sessionIdx)
  })
  it('rate limit key for add is scoped to profileId', () => {
    expect(actionsSrc).toContain("capture_add:${session.profileId}")
  })
  it('rate limit for add is 60 per hour', () => {
    expect(actionsSrc).toContain('CAPTURE_ADD_MAX')
    expect(actionsSrc).toContain('CAPTURE_ADD_WINDOW')
    const addMax = actionsSrc.match(/CAPTURE_ADD_MAX\s*=\s*(\d+)/)?.[1]
    expect(Number(addMax)).toBe(60)
  })
  it('submitCaptureSession has rate limit before lock acquisition', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const rateLimitIdx = actionsSrc.indexOf('checkRateLimit', idx)
    const txIdx = actionsSrc.indexOf('$transaction', idx)
    expect(rateLimitIdx).toBeGreaterThan(idx)
    expect(rateLimitIdx).toBeLessThan(txIdx)
  })
  it('rate limit key for submit is scoped to profileId', () => {
    expect(actionsSrc).toContain("capture_submit:${session.profileId}")
  })
  it('rate limit for submit is 10 per hour', () => {
    expect(actionsSrc).toContain('CAPTURE_SUB_MAX')
    const subMax = actionsSrc.match(/CAPTURE_SUB_MAX\s*=\s*(\d+)/)?.[1]
    expect(Number(subMax)).toBe(10)
  })
  it('rate limiting is instance-local (in-memory Map)', () => {
    const rlSrc = src('src/lib/rateLimit.ts')
    expect(rlSrc).toContain('Map')
  })
})

// ── Pagination/query batching ─────────────────────────────────────────────────

describe('mobileCapture: no N+1 query pattern', () => {
  it('getCaptureSession fetches all items and catalog data in one query', () => {
    const idx = actionsSrc.indexOf('export async function getCaptureSession')
    const body = actionsSrc.slice(idx, idx + 800)
    // items with catalog selected inline (no per-item fetches)
    expect(body).toContain("catalog: { select:")
    expect(body).toContain("orderBy: { createdAt: 'asc' }")
  })
  it('items are ordered deterministically by createdAt ASC', () => {
    expect(actionsSrc).toContain("orderBy: { createdAt: 'asc' }")
  })
  it('only minimal catalog fields sent to client (brand, name, year)', () => {
    expect(actionsSrc).toContain("brand: true, name: true, year: true")
  })
})

// ── CaptureWizard component ───────────────────────────────────────────────────

describe('CaptureWizard: structure', () => {
  it("has 'use client' directive", () => {
    expect(wizardSrc.startsWith("'use client'")).toBe(true)
  })
  it('uses searchCatalogByImage for camera search', () => {
    expect(wizardSrc).toContain('searchCatalogByImage')
  })
  it('uses CatalogImageSearch component', () => {
    expect(wizardSrc).toContain('CatalogImageSearch')
  })
  it('uses CatalogModelSearch for text search', () => {
    expect(wizardSrc).toContain('CatalogModelSearch')
  })
  it('has destination selection step', () => {
    expect(wizardSrc).toContain("'destination'")
    expect(wizardSrc).toContain('collection')
    expect(wizardSrc).toContain('sell')
  })
  it('has capture step', () => {
    expect(wizardSrc).toContain("'capture'")
  })
  it('has explicit duplicate resolution step (not silent)', () => {
    expect(wizardSrc).toContain("'dup_resolution'")
  })
  it('has details step with form fields', () => {
    expect(wizardSrc).toContain("'details'")
    expect(wizardSrc).toContain('quantity')
    expect(wizardSrc).toContain('condition')
  })
  it('has queued confirmation step', () => {
    expect(wizardSrc).toContain("'queued'")
  })
  it('shows sale type selector for sell destination', () => {
    expect(wizardSrc).toContain('saleType')
    expect(wizardSrc).toContain('SALE_TYPES')
  })
  it('shows isPublic checkbox for collection destination', () => {
    expect(wizardSrc).toContain('isPublic')
  })
  it('accepts presetDestination prop to skip destination step', () => {
    expect(wizardSrc).toContain('presetDestination')
    expect(wizardSrc).toContain("presetDestination ? 'capture' : 'destination'")
  })
  it('calls getOrCreateDraftSession on destination select', () => {
    expect(wizardSrc).toContain('getOrCreateDraftSession')
  })
  it('calls addCaptureItem on form submit', () => {
    expect(wizardSrc).toContain('addCaptureItem')
  })
  it('calls checkCollectionDuplicate after model select for collection', () => {
    expect(wizardSrc).toContain('checkCollectionDuplicate')
  })
  it('navigates to review page with session ID', () => {
    expect(wizardSrc).toContain('/account/capture/review?session=')
  })
  it('generates clientToken with randomness and model ID', () => {
    expect(wizardSrc).toContain('clientToken')
    expect(wizardSrc).toContain('Math.random')
    expect(wizardSrc).toContain('selected.id')
  })
  it('shows queue count in navigation', () => {
    expect(wizardSrc).toContain('queueCount')
  })
})

// ── CaptureReview component ───────────────────────────────────────────────────

describe('CaptureReview: structure', () => {
  it("has 'use client' directive", () => {
    expect(reviewSrc.startsWith("'use client'")).toBe(true)
  })
  it('calls removeCaptureItem', () => {
    expect(reviewSrc).toContain('removeCaptureItem')
  })
  it('calls updateCaptureItem for quantity edit', () => {
    expect(reviewSrc).toContain('updateCaptureItem')
  })
  it('calls submitCaptureSession', () => {
    expect(reviewSrc).toContain('submitCaptureSession')
  })
  it('shows session-level error after submit failure', () => {
    expect(reviewSrc).toContain('error')
  })
  it('redirects to collection after full success', () => {
    expect(reviewSrc).toContain('/account/collection')
  })
  it('redirects to sell after full success for sell destination', () => {
    expect(reviewSrc).toContain('/account/sell')
  })
  it('shows submitted confirmation', () => {
    expect(reviewSrc).toContain('All items submitted')
  })
  it('disables inputs while submitting or after result', () => {
    expect(reviewSrc).toContain('disabled={submitting || !!results}')
  })
})

// ── Pages ─────────────────────────────────────────────────────────────────────

describe('pages: /account/capture', () => {
  it('renders CaptureWizard', () => {
    expect(capturePage).toContain('CaptureWizard')
  })
  it('has metadata title', () => {
    expect(capturePage).toContain("title: 'Quick Capture'")
  })
})

describe('pages: /account/capture/review', () => {
  it('renders CaptureReview', () => {
    expect(reviewPage).toContain('CaptureReview')
  })
  it('redirects when no session param', () => {
    expect(reviewPage).toContain("redirect('/account/capture')")
  })
  it('calls getBuyerSession for auth guard', () => {
    expect(reviewPage).toContain('getBuyerSession')
  })
  it('calls getCaptureSession', () => {
    expect(reviewPage).toContain('getCaptureSession')
  })
  it('awaits searchParams', () => {
    expect(reviewPage).toContain('await searchParams')
  })
})

describe('pages: /account/sell/capture', () => {
  it('renders CaptureWizard with sell preset', () => {
    expect(sellCapture).toContain('CaptureWizard')
    expect(sellCapture).toContain('presetDestination="sell"')
  })
})

// ── Navigation ────────────────────────────────────────────────────────────────

describe('navigation: Quick Capture link', () => {
  it('store layout has Quick Capture link', () => {
    expect(layoutSrc).toContain('/account/capture')
    expect(layoutSrc).toContain('Quick Capture')
  })
})

// ── Security invariants ───────────────────────────────────────────────────────

describe('security: cross-customer access', () => {
  it('session lookup always includes customerProfileId from session (never browser-supplied)', () => {
    const findCalls = (actionsSrc.match(/mobileCaptureSession\.findFirst\s*\(\s*\{/g) ?? []).length
    const withOwnership = (actionsSrc.match(/customerProfileId: session\.profileId/g) ?? []).length
    expect(withOwnership).toBeGreaterThanOrEqual(findCalls)
  })
  it('item delete scoped to sessionId (preventing cross-session removal)', () => {
    expect(actionsSrc).toContain('where: { id: itemId, sessionId }')
  })
})

describe('security: no PII logged', () => {
  it('normalizeError context has no email, name, or profileId value', () => {
    const contexts = [...actionsSrc.matchAll(/'capture\.[^']+'/g)].map(m => m[0])
    // Event name should be a string key, not a PII value
    contexts.forEach(ctx => {
      expect(ctx).not.toContain('@')  // no email
    })
  })
})

describe('security: no automatic catalog linking', () => {
  it('submissions link only via provided catalogModelId (server-verified)', () => {
    expect(actionsSrc).toContain('catalogId: item.catalogModelId')
    expect(actionsSrc).not.toContain('autoLink')
    expect(actionsSrc).not.toContain('matchCatalog')
  })
})

// ── Schema: new fields on MobileCaptureItem ───────────────────────────────────

describe('schema: MobileCaptureItem new fields', () => {
  it('has acquisitionDate optional field', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('acquisitionDate')
    expect(body).toContain('DateTime?')
  })
  it('has payloadFingerprint field', () => {
    const idx = schemaSrc.indexOf('model MobileCaptureItem')
    const body = schemaSrc.slice(idx, schemaSrc.indexOf('\n}', idx))
    expect(body).toContain('payloadFingerprint')
    expect(body).toContain('String')
  })
  it('has unique constraint on sessionId+catalogModelId', () => {
    expect(schemaSrc).toContain('@@unique([sessionId, catalogModelId])')
  })
})

// ── Migration: new item fields ────────────────────────────────────────────────

describe('migration: 20260805080000_add_capture_item_fields', () => {
  const fieldMigSrc = src('prisma/migrations/20260805080000_add_capture_item_fields/migration.sql')

  it('adds acquisitionDate column', () => {
    expect(fieldMigSrc).toContain('ADD COLUMN "acquisitionDate"')
    expect(fieldMigSrc).toContain('TIMESTAMP(3)')
  })
  it('adds payloadFingerprint column', () => {
    expect(fieldMigSrc).toContain('ADD COLUMN "payloadFingerprint"')
    expect(fieldMigSrc).toContain('TEXT NOT NULL')
  })
  it('drops temporary default from payloadFingerprint', () => {
    expect(fieldMigSrc).toContain('DROP DEFAULT')
  })
  it('adds unique constraint on sessionId+catalogModelId', () => {
    expect(fieldMigSrc).toContain('MobileCaptureItem_sessionId_catalogModelId_key')
    expect(fieldMigSrc).toContain('UNIQUE ("sessionId", "catalogModelId")')
  })
})

// ── Full-payload fingerprint idempotency ──────────────────────────────────────

describe('mobileCapture: full-payload fingerprint', () => {
  it('exports cancelCaptureSession', () => {
    expect(actionsSrc).toContain('export async function cancelCaptureSession')
  })
  it('computePayloadFingerprint uses SHA-256 via crypto module', () => {
    expect(actionsSrc).toContain("import crypto from 'crypto'")
    expect(actionsSrc).toContain('createHash')
    expect(actionsSrc).toContain("'sha256'")
    expect(actionsSrc).toContain('computePayloadFingerprint')
  })
  it('fingerprint includes all 7 normalized item fields', () => {
    const idx = actionsSrc.indexOf('function computePayloadFingerprint')
    const body = actionsSrc.slice(idx, idx + 500)
    expect(body).toContain('catalogModelId')
    expect(body).toContain('quantity')
    expect(body).toContain('acquisitionDate')
    expect(body).toContain('condition')
    expect(body).toContain('notes')
    expect(body).toContain('isPublic')
    expect(body).toContain('saleTypePreference')
  })
  it('fingerprint does NOT include clientToken, sessionId, profileId, or image data', () => {
    const idx = actionsSrc.indexOf('function computePayloadFingerprint')
    const body = actionsSrc.slice(idx, idx + 500)
    expect(body).not.toContain('clientToken')
    expect(body).not.toContain('sessionId')
    expect(body).not.toContain('profileId')
    expect(body).not.toContain('image')
    expect(body).not.toContain('photo')
  })
  it('uses null-byte separator between fingerprint fields', () => {
    expect(actionsSrc).toContain("'\\x00'")
  })
  it('compares existing.payloadFingerprint to computed value on P2002 retry', () => {
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain('existing.payloadFingerprint !== payloadFingerprint')
  })
  it('fingerprint is computed from server-resolved catalog ID (not client-supplied)', () => {
    // Search for the call site (has object literal) not the function definition
    const idx = actionsSrc.indexOf('computePayloadFingerprint({')
    const body = actionsSrc.slice(idx, idx + 300)
    expect(body).toContain('catalog.id')
  })
  it('P2002 on clientToken constraint dispatches to fingerprint check', () => {
    const idx = actionsSrc.indexOf("constraint.includes('clientToken')")
    expect(idx).toBeGreaterThan(-1)
    const body = actionsSrc.slice(idx, idx + 700)
    expect(body).toContain('payloadFingerprint')
    expect(body).toContain('mobileCaptureItem.findUnique')
  })
})

// ── Duplicate catalogModelId in queue ─────────────────────────────────────────

describe('mobileCapture: duplicate model in queue', () => {
  it('@@unique([sessionId, catalogModelId]) prevents two rows for same model', () => {
    expect(schemaSrc).toContain('@@unique([sessionId, catalogModelId])')
  })
  it('P2002 on catalogModelId constraint returns user-facing error', () => {
    const idx = actionsSrc.indexOf("constraint.includes('catalogModelId')")
    expect(idx).toBeGreaterThan(-1)
    const body = actionsSrc.slice(idx, idx + 200)
    expect(body).toContain('already in your capture batch')
  })
  it('P2002 on catalogModelId constraint dispatched separately from clientToken', () => {
    expect(actionsSrc).toContain("constraint.includes('clientToken')")
    expect(actionsSrc).toContain("constraint.includes('catalogModelId')")
    // Two separate branches
    const cIdx = actionsSrc.indexOf("constraint.includes('clientToken')")
    const mIdx = actionsSrc.indexOf("constraint.includes('catalogModelId')")
    expect(cIdx).not.toBe(mIdx)
  })
  it('submission pre-validation catches duplicate model IDs in queue', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 8000)
    expect(body).toContain('seenModels')
    expect(body).toContain('DUPLICATE_MODEL_IN_QUEUE')
  })
  it('p2002ConstraintName reads target from Prisma error meta', () => {
    expect(actionsSrc).toContain('p2002ConstraintName')
    expect(actionsSrc).toContain('e.meta?.target')
  })
})

// ── Acquisition date ──────────────────────────────────────────────────────────

describe('mobileCapture: acquisition date', () => {
  it('CaptureItemInput includes acquisitionDate field', () => {
    const idx = actionsSrc.indexOf('type CaptureItemInput')
    const body = actionsSrc.slice(idx, idx + 300)
    expect(body).toContain('acquisitionDate')
    expect(body).toContain('string | null')
  })
  it('CaptureItemResult includes acquisitionDate field', () => {
    const idx = actionsSrc.indexOf('type CaptureItemResult')
    const body = actionsSrc.slice(idx, idx + 300)
    expect(body).toContain('acquisitionDate')
  })
  it('acquisitionDate validated: future date rejected', () => {
    expect(actionsSrc).toContain('Acquisition date cannot be in the future.')
  })
  it('acquisitionDate validated: malformed date rejected', () => {
    expect(actionsSrc).toContain('Invalid acquisition date.')
  })
  it('acquisitionDate only accepted for collection destination', () => {
    const idx = actionsSrc.indexOf("destination === 'collection'")
    const body = actionsSrc.slice(idx, idx + 400)
    expect(body).toContain('acquisitionDate')
  })
  it('acquisitionDate silently stripped for sell destination', () => {
    const idx = actionsSrc.indexOf("sell: ignore acquisitionDate silently")
    expect(idx).toBeGreaterThan(-1)
  })
  it('acquisitionDate maps to CollectionItem.purchaseDate on submission', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 8000)
    expect(body).toContain('purchaseDate')
    expect(body).toContain('item.acquisitionDate')
  })
  it('getCaptureSession returns acquisitionDate for each item', () => {
    const idx = actionsSrc.indexOf('export async function getCaptureSession')
    const body = actionsSrc.slice(idx, idx + 1200)
    expect(body).toContain('acquisitionDate')
  })
  it('wizard shows acquisition date input for collection destination only', () => {
    // The label text is unique and close to both the conditional and the state binding
    const labelIdx = wizardSrc.indexOf('Acquisition date')
    expect(labelIdx).toBeGreaterThan(-1)
    // Look back 300 chars for the destination==='collection' guard wrapping the input
    const before = wizardSrc.slice(Math.max(0, labelIdx - 300), labelIdx)
    expect(before).toContain("destination === 'collection'")
    // Look forward 200 chars for the state binding
    const after = wizardSrc.slice(labelIdx, labelIdx + 200)
    expect(after).toContain('acquisitionDate')
  })
  it('wizard passes acquisitionDate to addCaptureItem', () => {
    const idx = wizardSrc.indexOf('addCaptureItem(')
    const body = wizardSrc.slice(idx, idx + 400)
    expect(body).toContain('acquisitionDate')
  })
  it('review displays acquisitionDate when present', () => {
    expect(reviewSrc).toContain('acquisitionDate')
    expect(reviewSrc).toContain('toLocaleDateString')
  })
  it('submission pre-validation rejects invalid acquisitionDate', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 8000)
    expect(body).toContain('INVALID_DATE')
  })
})

// ── Queue bound ───────────────────────────────────────────────────────────────

describe('mobileCapture: queue bound', () => {
  it('MAX_CAPTURE_ITEMS_PER_SESSION constant is 100', () => {
    expect(actionsSrc).toContain('MAX_CAPTURE_ITEMS_PER_SESSION = 100')
  })
  it('queue bound enforced inside transaction with session lock (race-safe)', () => {
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const txIdx = actionsSrc.indexOf('$transaction', idx)
    const boundIdx = actionsSrc.indexOf('MAX_CAPTURE_ITEMS_PER_SESSION', idx)
    expect(txIdx).toBeGreaterThan(idx)
    expect(boundIdx).toBeGreaterThan(txIdx) // bound check is INSIDE the tx
  })
  it('count check uses itemCount under session lock', () => {
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain('mobileCaptureItem.count')
    expect(body).toContain('QUEUE_FULL')
  })
  it('returns user-facing error when queue full', () => {
    expect(actionsSrc).toContain('Queue is full. Maximum')
  })
  it('addCaptureItem acquires FOR UPDATE lock on session before count check', () => {
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const body = actionsSrc.slice(idx, idx + 6000)
    const forUpdateIdx = body.indexOf('FOR UPDATE')
    const countIdx = body.indexOf('mobileCaptureItem.count')
    expect(forUpdateIdx).toBeGreaterThan(-1)
    expect(countIdx).toBeGreaterThan(forUpdateIdx)
  })
  it('add lock prevents double-add race exceeding limit', () => {
    // Both concurrent adds acquire FOR UPDATE; second sees updated count
    const idx = actionsSrc.indexOf('export async function addCaptureItem')
    const body = actionsSrc.slice(idx, idx + 6000)
    expect(body).toContain('FOR UPDATE')
    expect(body).toContain('itemCount >= MAX_CAPTURE_ITEMS_PER_SESSION')
  })
  it('add transaction has a timeout', () => {
    expect(actionsSrc).toContain('timeout: 10_000')
  })
})

// ── Session cancellation ──────────────────────────────────────────────────────

describe('mobileCapture: session cancellation', () => {
  it('cancelCaptureSession is exported', () => {
    expect(actionsSrc).toContain('export async function cancelCaptureSession')
  })
  it('requires auth session', () => {
    const idx = actionsSrc.indexOf('export async function cancelCaptureSession')
    const body = actionsSrc.slice(idx, idx + 800)
    expect(body).toContain('getBuyerSession')
    expect(body).toContain('if (!session)')
  })
  it('only cancels draft sessions (not submitted/cancelled)', () => {
    const idx = actionsSrc.indexOf('export async function cancelCaptureSession')
    const body = actionsSrc.slice(idx, idx + 1400)
    expect(body).toContain("status: 'cancelled'")
    expect(body).toContain('SESSION_NOT_DRAFT')
    expect(body).toContain('Only draft sessions can be cancelled.')
  })
  it('verifies ownership with customerProfileId before cancelling', () => {
    const idx = actionsSrc.indexOf('export async function cancelCaptureSession')
    const body = actionsSrc.slice(idx, idx + 1400)
    expect(body).toContain('customerProfileId: session.profileId')
  })
  it('acquires FOR UPDATE lock before status check (race-safe)', () => {
    const idx = actionsSrc.indexOf('export async function cancelCaptureSession')
    const body = actionsSrc.slice(idx, idx + 1400)
    const forUpdateIdx = body.indexOf('FOR UPDATE')
    const statusCheckIdx = body.indexOf('SESSION_NOT_DRAFT')
    expect(forUpdateIdx).toBeGreaterThan(-1)
    expect(statusCheckIdx).toBeGreaterThan(forUpdateIdx)
  })
  it('sets status to cancelled (not deleted) so history is preserved', () => {
    const idx = actionsSrc.indexOf('export async function cancelCaptureSession')
    const body = actionsSrc.slice(idx, idx + 1400)
    expect(body).toContain("status: 'cancelled'")
    expect(body).not.toContain('mobileCaptureSession.delete')
  })
  it('cancelled status frees partial unique draft index (allows new draft for same destination)', () => {
    // Partial index only covers WHERE status='draft'; cancelled rows are unconstrained
    expect(partialMigSrc).toContain("WHERE")
    expect(partialMigSrc).toContain("draft")
    // Cancellation sets status='cancelled' which falls outside the partial index
    const idx = actionsSrc.indexOf('export async function cancelCaptureSession')
    const body = actionsSrc.slice(idx, idx + 1400)
    expect(body).toContain("'cancelled'")
  })
  it('wizard has cancel batch button and confirmation', () => {
    expect(wizardSrc).toContain('cancelCaptureSession')
    expect(wizardSrc).toContain('cancelConfirm')
    expect(wizardSrc).toContain('Cancel batch')
  })
  it('review page has cancel batch button and confirmation', () => {
    expect(reviewSrc).toContain('cancelCaptureSession')
    expect(reviewSrc).toContain('cancelConfirm')
    expect(reviewSrc).toContain('Cancel batch')
  })
  it('cancel redirects to /account after success', () => {
    expect(wizardSrc).toContain("router.push('/account')")
    expect(reviewSrc).toContain("router.push('/account')")
  })
})

// ── Submission pre-validation ─────────────────────────────────────────────────

describe('mobileCapture: submission pre-validation', () => {
  it('pre-validation runs under session lock before any conversion', () => {
    const idx = actionsSrc.indexOf('export async function submitCaptureSession')
    const body = actionsSrc.slice(idx, idx + 8000)
    const forUpdateIdx = body.indexOf('FOR UPDATE')
    const preValIdx = body.indexOf('Pre-validation')
    const collectionCreateIdx = body.indexOf('tx.collectionItem.create')
    expect(forUpdateIdx).toBeGreaterThan(-1)
    expect(preValIdx).toBeGreaterThan(forUpdateIdx)
    expect(preValIdx).toBeLessThan(collectionCreateIdx)
  })
  it('pre-validation catches seller fields on collection items', () => {
    expect(actionsSrc).toContain('SELLER_FIELD_IN_COLLECTION')
    expect(actionsSrc).toContain('Invalid item data for collection.')
  })
  it('pre-validation catches collection fields on seller items', () => {
    expect(actionsSrc).toContain('COLLECTION_FIELD_IN_SELLER')
    expect(actionsSrc).toContain('Invalid item data for seller.')
  })
  it('pre-validation catches missing saleTypePreference for seller items', () => {
    expect(actionsSrc).toContain('MISSING_SALE_TYPE')
    expect(actionsSrc).toContain('missing a valid sale preference')
  })
  it('pre-validation catches duplicate model IDs in the queue', () => {
    expect(actionsSrc).toContain('DUPLICATE_MODEL_IN_QUEUE')
    expect(actionsSrc).toContain('Duplicate model in queue')
  })
  it('pre-validation catches invalid quantity', () => {
    expect(actionsSrc).toContain('INVALID_QUANTITY')
    expect(actionsSrc).toContain('invalid quantity')
  })
  it('pre-validation catches invalid date', () => {
    expect(actionsSrc).toContain('INVALID_DATE')
    expect(actionsSrc).toContain('invalid acquisition date')
  })
  it('any pre-validation failure throws and no conversions are written', () => {
    const idx = actionsSrc.indexOf('Pre-validation: check all items before converting any')
    expect(idx).toBeGreaterThan(-1)
    // The tx throw rolls back — conversion code is separate for loop below
    const preValEndIdx = actionsSrc.indexOf('// Conversion:', idx)
    expect(preValEndIdx).toBeGreaterThan(idx)
  })
})
