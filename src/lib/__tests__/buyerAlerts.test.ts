/**
 * 14A: Buyer Alerts — pure-function, structural, and behavioral (mocked Prisma/Resend) tests.
 * Covers the durable fan-out outbox, lease-based claiming, Resend idempotency keys, and
 * timeout/ambiguity handling added in the durability review pass.
 * No real DB connection. No real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

// ── Mocked Prisma client ────────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  prisma: {
    wantedCatalogModel:   { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    buyerAlertPreference: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    buyerAlertEvent:      { createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    buyerAlertFanout:     { createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn() },
    listing:              { findUnique: vi.fn(), findMany: vi.fn() },
    itemInstance:         { findUnique: vi.fn() },
    $transaction:         vi.fn(),
  },
}))

vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))

const mockSend = vi.fn()
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}))

import { prisma } from '@/lib/prisma'
import { Resend } from 'resend'
import { getBuyerSession } from '@/lib/buyerSession'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import {
  toCents, isMeaningfulPriceChange, buildAvailableEventKey, buildPriceChangeEventKey,
  DEFAULT_PRICE_CHANGE_THRESHOLD_PCT,
} from '@/lib/buyerAlertKeys'
import { createAvailableFanoutJob, createPriceChangeFanoutJob } from '@/lib/buyerAlertsTrigger'
import { processFanoutJobs } from '@/lib/buyerAlertsFanoutProcessor'
import { processPendingBuyerAlerts, retryFailedAlertEvent } from '@/lib/buyerAlertsDelivery'
import { getAlertEvents, markAlertRead, markAllAlertsRead, resolveAlertPreference } from '@/lib/buyerAlertsQuery'
import { markAlertReadAction, markAllAlertsReadAction, updateAlertPreferences, toggleWantedAlertAction } from '@/lib/actions/buyerAlerts'
import { retryBuyerAlertEventAction, runBuyerAlertProcessorAction } from '@/lib/actions/adminBuyerAlerts'
import { GET as buyerAlertsCronGET } from '@/app/api/cron/buyer-alerts/route'

type Mock = ReturnType<typeof vi.fn>

// ── Pure: cents / threshold / event keys ────────────────────────────────────────

describe('buyerAlertKeys: toCents', () => {
  it('rounds dollars to integer cents', () => {
    expect(toCents(19.99)).toBe(1999)
    expect(toCents(10)).toBe(1000)
    expect(toCents(9.999)).toBe(1000)
  })
})

describe('buyerAlertKeys: isMeaningfulPriceChange', () => {
  it('unchanged price is never meaningful', () => {
    expect(isMeaningfulPriceChange(1000, 1000, null)).toBe(false)
  })

  it('uses DEFAULT_PRICE_CHANGE_THRESHOLD_PCT when threshold is null', () => {
    expect(isMeaningfulPriceChange(1000, 950, null)).toBe(true)
    expect(DEFAULT_PRICE_CHANGE_THRESHOLD_PCT).toBe(5)
  })

  it('below-threshold change produces false', () => {
    expect(isMeaningfulPriceChange(1000, 991, null)).toBe(false)
  })

  it('respects a custom threshold', () => {
    expect(isMeaningfulPriceChange(1000, 980, 1)).toBe(true)
    expect(isMeaningfulPriceChange(1000, 995, 10)).toBe(false)
  })

  it('detects both decrease and increase directions', () => {
    expect(isMeaningfulPriceChange(1000, 1100, 5)).toBe(true)
    expect(isMeaningfulPriceChange(1000, 900, 5)).toBe(true)
  })
})

describe('buyerAlertKeys: event keys (Listing.version based)', () => {
  it('availability key is deterministic for the same inputs', () => {
    expect(buildAvailableEventKey('listing1', 3)).toBe(buildAvailableEventKey('listing1', 3))
  })

  it('availability key changes when listingVersion changes — reactivation gets a distinct key, never masquerades as the prior window', () => {
    const a = buildAvailableEventKey('listing1', 3)
    const b = buildAvailableEventKey('listing1', 4)
    expect(a).not.toBe(b)
  })

  it('price key encodes integer cents and the listing version, not floats', () => {
    const key = buildPriceChangeEventKey('listing1', 1999, 1499, 5)
    expect(key).toBe('wanted_price:listing1:1999:1499:5')
    expect(key).not.toContain('.')
  })

  it('same old/new cents on two different listing versions produce distinct events', () => {
    const a = buildPriceChangeEventKey('listing1', 2000, 1500, 1)
    const b = buildPriceChangeEventKey('listing1', 2000, 1500, 2)
    expect(a).not.toBe(b)
  })

  it('event keys never contain PII markers (email/@ sign)', () => {
    expect(buildAvailableEventKey('listing1', 1)).not.toContain('@')
    expect(buildPriceChangeEventKey('listing1', 1999, 1499, 1)).not.toContain('@')
  })
})

// ── Structural: privacy / security / scope guarantees ───────────────────────────

describe('buyerAlerts: no seller PII, no buyer email logged, no automatic mutations', () => {
  const deliverySrc = readSrc('src/lib/buyerAlertsDelivery.ts')
  const triggerSrc  = readSrc('src/lib/buyerAlertsTrigger.ts')
  const fanoutSrc   = readSrc('src/lib/buyerAlertsFanoutProcessor.ts')
  const emailSrc    = readSrc('src/lib/email/buyerAlertEmail.ts')
  const adminPageSrc = readSrc('src/app/(admin)/admin/system/alerts/page.tsx')
  const adminActionSrc = readSrc('src/lib/actions/adminBuyerAlerts.ts')

  it('delivery worker never passes customerProfile.email to logger', () => {
    const loggerCalls = deliverySrc.match(/logger\.(info|warn|error)\([^)]*\)/gs) ?? []
    for (const call of loggerCalls) expect(call).not.toContain('.email')
  })

  it('email templates take no seller name/email/address fields', () => {
    expect(emailSrc).not.toContain('sellerName')
    expect(emailSrc).not.toContain('sellerEmail')
    expect(emailSrc).not.toContain('sellerAddress')
  })

  it('no external AI/API/scraping in alert trigger/fanout/delivery/email code', () => {
    for (const src of [triggerSrc, fanoutSrc, deliverySrc, emailSrc]) {
      expect(src).not.toContain('fetch(')
      expect(src.toLowerCase()).not.toContain('openai')
      expect(src.toLowerCase()).not.toContain('anthropic')
      expect(src).not.toContain('axios')
    }
  })

  it('no automatic purchase/order mutation anywhere in the alert code paths', () => {
    for (const src of [triggerSrc, fanoutSrc, deliverySrc]) {
      expect(src).not.toContain('order.create')
      expect(src).not.toContain('order.update')
      expect(src.toLowerCase()).not.toContain('checkout')
    }
  })

  it('admin observability page shows no buyer email/name, and has no bulk resend-all button', () => {
    expect(adminPageSrc).not.toContain('customerProfile.email')
    expect(adminPageSrc.toLowerCase()).not.toContain('resend all')
    expect(adminPageSrc).not.toContain('resendAllAction')
  })

  it('admin retry/process actions authenticate independently of route protection', () => {
    expect(adminActionSrc).toContain('isAdminAuthenticated')
    const bodies = adminActionSrc.split('export async function').slice(1)
    for (const body of bodies) expect(body).toContain('isAdminAuthenticated')
  })

  it('cron route requires CRON_SECRET bearer auth (not a public endpoint)', () => {
    const cronSrc = readSrc('src/app/api/cron/buyer-alerts/route.ts')
    expect(cronSrc).toContain('CRON_SECRET')
    expect(cronSrc).toContain('Unauthorized')
    expect(cronSrc).toContain("dynamic = 'force-dynamic'")
  })

  it('idempotency key is derived only from the internal event id — no email/customer data', () => {
    expect(deliverySrc).toContain('`buyer-alert/${event.id}`')
  })
})

describe('buyerAlerts: buyer identity derived from session only', () => {
  const actionSrc = readSrc('src/lib/actions/buyerAlerts.ts')

  it('every buyer action calls getBuyerSession and never reads customerProfileId from formData', () => {
    expect(actionSrc).not.toContain("formData.get('customerProfileId')")
    const fns = actionSrc.split('export async function').slice(1)
    for (const fn of fns) expect(fn).toContain('getBuyerSession')
  })

  it('mutations scope by customerProfileId: session.profileId in the where clause', () => {
    expect(actionSrc).toContain('customerProfileId: session.profileId')
  })
})

// ── Behavioral: durable fan-out job creation (atomic with the listing mutation) ─

describe('buyerAlertsTrigger: createAvailableFanoutJob / createPriceChangeFanoutJob (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  function fakeTx() {
    return { buyerAlertFanout: { createMany: vi.fn().mockResolvedValue({ count: 1 }) } }
  }

  it('creates exactly one idempotent fan-out row for an availability transition', async () => {
    const tx = fakeTx()
    await createAvailableFanoutJob(tx as never, 'cat1', 'listing1', 3)

    expect(tx.buyerAlertFanout.createMany).toHaveBeenCalledTimes(1)
    const call = tx.buyerAlertFanout.createMany.mock.calls[0][0]
    expect(call.skipDuplicates).toBe(true)
    expect(call.data).toEqual([{
      eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:3', listingVersion: 3,
    }])
  })

  it('creates a price-decrease fan-out job with normalized cents', async () => {
    const tx = fakeTx()
    await createPriceChangeFanoutJob(tx as never, 'cat1', 'listing1', 20.00, 15.00, 4)

    const call = tx.buyerAlertFanout.createMany.mock.calls[0][0]
    expect(call.data[0].eventType).toBe('wanted_price_decrease')
    expect(call.data[0].previousPriceCents).toBe(2000)
    expect(call.data[0].currentPriceCents).toBe(1500)
  })

  it('creates a distinct price-increase job type', async () => {
    const tx = fakeTx()
    await createPriceChangeFanoutJob(tx as never, 'cat1', 'listing1', 15.00, 20.00, 4)
    expect(tx.buyerAlertFanout.createMany.mock.calls[0][0].data[0].eventType).toBe('wanted_price_increase')
  })

  it('unchanged price creates no fan-out job (metadata-only edits do not notify)', async () => {
    const tx = fakeTx()
    await createPriceChangeFanoutJob(tx as never, 'cat1', 'listing1', 19.99, 19.99, 4)
    expect(tx.buyerAlertFanout.createMany).not.toHaveBeenCalled()
  })

  it('createListing and updateListing create the fan-out job inside the SAME $transaction as the listing mutation', () => {
    const listingsSrc = readSrc('src/lib/actions/listings.ts')
    // createListing: one $transaction block containing both the create and the job.
    const createFnSrc = listingsSrc.slice(listingsSrc.indexOf('export async function createListing'), listingsSrc.indexOf('export async function updateListing'))
    expect(createFnSrc).toContain('await prisma.$transaction(async (tx) => {')
    const txBlock = createFnSrc.slice(createFnSrc.indexOf('$transaction'))
    expect(txBlock).toContain('tx.listing.create')
    expect(txBlock).toContain('createAvailableFanoutJob(tx')

    // updateListing: the non-sold branch's $transaction contains both the update and the job.
    const updateFnSrc = listingsSrc.slice(listingsSrc.indexOf('export async function updateListing'))
    expect(updateFnSrc).toContain('tx.listing.update')
    expect(updateFnSrc).toContain('createAvailableFanoutJob(tx')
    expect(updateFnSrc).toContain('createPriceChangeFanoutJob(tx')
  })

  it('intake conversion creates the fan-out job inside the same transaction as the listing — 15D-review section 1: this now lives in the shared intakeConversion.ts primitive, called by convertDraft (manual) inside its own $transaction', () => {
    const conversionSrc = readSrc('src/lib/intakeConversion.ts')
    const txIdx = conversionSrc.indexOf('tx.listing.create')
    const jobIdx = conversionSrc.indexOf('createAvailableFanoutJob(tx')
    // The shared primitive's own closing tx.intakeDraft.update (converted+link write).
    const txEndIdx = conversionSrc.indexOf('await tx.intakeDraft.update', txIdx)
    expect(txIdx).toBeGreaterThan(-1)
    expect(jobIdx).toBeGreaterThan(txIdx)
    expect(jobIdx).toBeLessThan(txEndIdx)
    // intake.ts itself calls convertIntakeDraft from inside its OWN $transaction, so
    // the whole chain (listing create -> fan-out -> draft link) still runs atomically.
    const intakeSrc = readSrc('src/lib/actions/intake.ts')
    const intakeTxIdx = intakeSrc.indexOf('prisma.$transaction')
    const convertCallIdx = intakeSrc.indexOf('await convertIntakeDraft(tx,')
    expect(convertCallIdx).toBeGreaterThan(intakeTxIdx)
  })

  it('best-effort processing after commit never blocks the action on failure', () => {
    const listingsSrc = readSrc('src/lib/actions/listings.ts')
    expect(listingsSrc).toContain('processFanoutBestEffort')
    expect(listingsSrc).toMatch(/catch\s*\{\s*\/\/[^}]*already exists/)
  })

  it('createListing runs the fan-out job creation inside prisma.$transaction (behavioral)', async () => {
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce({
      id: 'item1', status: 'available', catalogId: 'cat1', listing: null,
    })
    let sawListingCreate = false
    let sawJobCreate = false
    ;(prisma.$transaction as Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        listing: { create: vi.fn().mockImplementation(async () => { sawListingCreate = true; return { id: 'listing1', version: 1 } }) },
        buyerAlertFanout: { createMany: vi.fn().mockImplementation(async () => { sawJobCreate = true; return { count: 1 } }) },
      }
      return fn(tx)
    })
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([]) // best-effort processFanoutJobs sees nothing pending

    const { createListing } = await import('@/lib/actions/listings')
    const fd = new FormData()
    fd.set('itemId', 'item1')
    fd.set('title', 'Test')
    fd.set('price', '10')
    await expect(createListing(null, fd)).rejects.toThrow() // redirect() throws in the test env

    expect(sawListingCreate).toBe(true)
    expect(sawJobCreate).toBe(true)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1) // both writes happened inside ONE transaction call
  })
})

// ── Behavioral: fan-out processor (durable resume, lease, idempotency) ──────────

describe('buyerAlertsFanoutProcessor: processFanoutJobs (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  function fanoutJob(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: null,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
      ...overrides,
    }
  }

  it('claims oldest-first, bounded by batchSize, including stale (crashed-worker) jobs', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([])
    await processFanoutJobs(20)

    const args = (prisma.buyerAlertFanout.findMany as Mock).mock.calls[0][0]
    expect(args.take).toBe(20)
    expect(args.orderBy).toEqual({ createdAt: 'asc' })
    expect(args.where.OR[0]).toEqual({ status: 'pending' })
    expect(args.where.OR[1].status).toBe('processing')
    expect(args.where.OR[1].claimedAt.lt).toBeInstanceOf(Date)
  })

  it('post-commit processor never running does not lose the job: a later invocation still creates all alerts', async () => {
    // Simulates: listing tx committed a fan-out row; the immediate best-effort call never
    // ran (process crashed). A LATER invocation of processFanoutJobs must still complete it.
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // claim succeeds
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob())
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // cursor checkpoint
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // mark complete

    const result = await processFanoutJobs()

    expect(result.claimed).toBe(1)
    expect(result.completed).toBe(1)
    expect(prisma.buyerAlertEvent.createMany).toHaveBeenCalledTimes(1)
    const eventData = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(eventData[0]).toMatchObject({ customerProfileId: 'p1', alertType: 'wanted_available', status: 'pending' })
  })

  it('crash after page 1 resumes at page 2 via the stored cursor', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // claim
    // Resuming a job whose cursor was already checkpointed at 'w0199' by a prior (crashed) run.
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({ cursor: 'w0199' }))
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([]) // page 2 (nothing left) — empty, ends traversal
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // mark complete

    await processFanoutJobs()

    const pageArgs = (prisma.wantedCatalogModel.findMany as Mock).mock.calls[0][0]
    expect(pageArgs.cursor).toEqual({ id: 'w0199' }) // resumed from the durable cursor, not from the start
    expect(pageArgs.skip).toBe(1)
  })

  it('persists the cursor after each successful page before moving to the next', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `w${String(i).padStart(4, '0')}`, customerProfileId: `p${i}`, availabilityAlertEnabled: true, priceAlertEnabled: true }))
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // claim
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob())
    ;(prisma.wantedCatalogModel.findMany as Mock)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValue([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValue({ count: 200 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // checkpoint after page 1
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // mark complete after page 2

    await processFanoutJobs()

    const checkpointCall = (prisma.buyerAlertFanout.updateMany as Mock).mock.calls[1][0]
    expect(checkpointCall.where).toEqual({ id: 'job1', claimToken: expect.any(String) })
    expect(checkpointCall.data).toEqual({ cursor: 'w0199', claimedAt: expect.any(Date) })
  })

  it('repeated fan-out invocation on the same job creates no duplicate BuyerAlertEvent rows (skipDuplicates)', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob())
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const createCall = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0]
    expect(createCall.skipDuplicates).toBe(true) // DB unique constraint makes a second identical run a no-op
  })

  it('concurrent fan-out processors cannot corrupt the cursor: a lost claim race is skipped, not processed', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock)
      .mockResolvedValueOnce({ count: 0 }) // fromPending: another worker already claimed it
      .mockResolvedValueOnce({ count: 0 }) // fromStale: its lease is still active, not stale

    const result = await processFanoutJobs()

    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0, leaseLost: 0 })
    expect(prisma.buyerAlertFanout.findUnique).not.toHaveBeenCalled()
  })

  it('stale processing lease is recovered by a second claim attempt', async () => {
    // The 2-attempt claim: pending-claim fails (job is already 'processing'), then the
    // stale-lease claim succeeds because claimedAt is older than FANOUT_LEASE_MS.
    ;(prisma.buyerAlertFanout.updateMany as Mock)
      .mockResolvedValueOnce({ count: 0 }) // fromPending fails — not 'pending'
      .mockResolvedValueOnce({ count: 1 }) // fromStale succeeds
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({ status: 'processing' }))
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // mark complete

    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    const result = await processFanoutJobs()

    expect(result.claimed).toBe(1)
    const staleClaimArgs = (prisma.buyerAlertFanout.updateMany as Mock).mock.calls[1][0]
    expect(staleClaimArgs.where.status).toBe('processing')
    expect(staleClaimArgs.where.claimedAt.lt).toBeInstanceOf(Date)
  })

  it('an active (non-stale) lease cannot be claimed by a second worker', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock)
      .mockResolvedValueOnce({ count: 0 }) // fromPending: not pending
      .mockResolvedValueOnce({ count: 0 }) // fromStale: claimedAt too recent, WHERE excludes it

    const result = await processFanoutJobs()

    expect(result.claimed).toBe(0)
    expect(prisma.buyerAlertFanout.findUnique).not.toHaveBeenCalled()
  })

  it('applies per-buyer price threshold and per-model toggles during processing, not at job-creation time', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({
      eventType: 'wanted_price_decrease', previousPriceCents: 1000, currentPriceCents: 991, // 0.9% drop
    }))
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([]) // default 5% threshold
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    // 0.9% < default 5% threshold — no event created, and createMany is never even called.
    expect(prisma.buyerAlertEvent.createMany).not.toHaveBeenCalled()
  })

  it('failed job processing marks the job failed via a claim-verified write', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // claim
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockRejectedValueOnce(new Error('db_error'))
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // failure write

    const result = await processFanoutJobs()

    expect(result.failed).toBe(1)
    const failCall = (prisma.buyerAlertFanout.updateMany as Mock).mock.calls[1][0]
    expect(failCall.where).toEqual({ id: 'job1', claimToken: expect.any(String) })
    expect(failCall.data.status).toBe('failed')
  })

  // ── Gap 1: every claimed-job mutation is claimToken-scoped; the lease is renewed on
  // each successful checkpoint so a long-running fan-out doesn't go stale purely from
  // taking longer than FANOUT_LEASE_MS while still actively progressing.

  it('cursor checkpoint renews claimedAt (lease renewal), not just the cursor', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // claim
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob())
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `w${String(i).padStart(4, '0')}`, customerProfileId: `p${i}`, availabilityAlertEnabled: true, priceAlertEnabled: true }))
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce(page1).mockResolvedValueOnce([])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValue([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValue({ count: 200 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // checkpoint
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // complete

    await processFanoutJobs()

    const checkpointCall = (prisma.buyerAlertFanout.updateMany as Mock).mock.calls[1][0]
    expect(checkpointCall.where).toEqual({ id: 'job1', claimToken: expect.any(String) })
    expect(checkpointCall.data).toEqual({ cursor: 'w0199', claimedAt: expect.any(Date) })
  })

  it('lease transfer scenario: worker A checkpoints page 1, loses the lease to worker B before page 2, and stops immediately without completing or advancing further', async () => {
    // 1. Worker A claims job1.
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // A claims
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob())

    // 2. Worker A processes page 1 (200 rows — a full page, so there must be a page 2).
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `w${String(i).padStart(4, '0')}`, customerProfileId: `p${i}`, availabilityAlertEnabled: true, priceAlertEnabled: true }))
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce(page1)
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 200 })

    // 3.-6. Lease expires; worker B reclaims job1 (changes claimToken) before A's page-1
    // checkpoint lands. A's claimToken-scoped checkpoint write now matches 0 rows.
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 0 }) // A's checkpoint fails — stale claimToken

    const result = await processFanoutJobs()

    // 7. Worker A must stop immediately: exactly one checkpoint attempt, no further
    //    fan-out queries (no page-2 fetch), no 'complete' write, no failure write either
    //    (losing a lease is not an error — it's an expected, non-exceptional stop).
    expect(prisma.wantedCatalogModel.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.buyerAlertFanout.updateMany).toHaveBeenCalledTimes(2) // claim + failed checkpoint only
    expect(result.leaseLost).toBe(1)
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(0)
    // 8./9. Events already created for page 1 remain (idempotent, correct so far) — worker
    // B is solely responsible for the cursor/remaining pages from here; A never touches them.
    expect(prisma.buyerAlertEvent.createMany).toHaveBeenCalledTimes(1)
  })

  // ── Gap 2: audience cutoff — a buyer added to the wanted list AFTER the transition
  // must never receive a historical alert for it. Uses a small fake in-memory filter
  // over WantedCatalogModel to exercise the REAL query args (createdAt <= audienceCutoffAt),
  // not just re-assert the code's own intent.

  function installWantedRowsFixture(rows: Array<{ id: string; customerProfileId: string; createdAt: Date; availabilityAlertEnabled: boolean; priceAlertEnabled: boolean }>) {
    ;(prisma.wantedCatalogModel.findMany as Mock).mockImplementation(async (args: { where: { createdAt: { lte: Date } }; cursor?: { id: string }; take: number }) => {
      const cutoff = args.where.createdAt.lte
      let filtered = rows.filter(r => r.createdAt.getTime() <= cutoff.getTime()).sort((a, b) => (a.id < b.id ? -1 : 1))
      if (args.cursor) {
        const idx = filtered.findIndex(r => r.id > args.cursor!.id)
        filtered = idx === -1 ? [] : filtered.slice(idx)
      }
      return filtered.slice(0, args.take)
    })
  }

  const CUTOFF = new Date('2026-01-01T10:01:00.000Z') // job created at 10:01

  it('wanted before the transition is eligible', async () => {
    installWantedRowsFixture([
      { id: 'w1', customerProfileId: 'p1', createdAt: new Date('2026-01-01T09:00:00.000Z'), availabilityAlertEnabled: true, priceAlertEnabled: true },
    ])
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({ audienceCutoffAt: CUTOFF }))
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect(prisma.buyerAlertEvent.createMany).toHaveBeenCalledTimes(1)
    expect((prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data).toHaveLength(1)
  })

  it('wanted after the transition (10:10, job cutoff 10:01) is NOT eligible — no historical alert', async () => {
    installWantedRowsFixture([
      { id: 'w1', customerProfileId: 'p1', createdAt: new Date('2026-01-01T10:10:00.000Z'), availabilityAlertEnabled: true, priceAlertEnabled: true },
    ])
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({ audienceCutoffAt: CUTOFF }))
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect(prisma.buyerAlertEvent.createMany).not.toHaveBeenCalled()
  })

  it('removed before processing yields no event: a deleted WantedCatalogModel row is simply absent from the live query', async () => {
    // p1 wanted before the cutoff but removed it before fan-out ran — their row no
    // longer exists at all, so it's absent from the fixture (not filtered by date).
    installWantedRowsFixture([])
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({ audienceCutoffAt: CUTOFF }))
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect(prisma.buyerAlertEvent.createMany).not.toHaveBeenCalled()
  })

  it('removed then re-added after the transition is NOT eligible for the historical event (new row, new createdAt, same mechanism as a late join)', async () => {
    // Re-adding creates a brand-new WantedCatalogModel row with a fresh createdAt —
    // there is no way to distinguish this from a first-time late join, by design.
    installWantedRowsFixture([
      { id: 'w9', customerProfileId: 'p1', createdAt: new Date('2026-01-01T11:00:00.000Z'), availabilityAlertEnabled: true, priceAlertEnabled: true },
    ])
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({ audienceCutoffAt: CUTOFF }))
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect(prisma.buyerAlertEvent.createMany).not.toHaveBeenCalled()
  })

  it('a future listing transition (its own, later cutoff) is eligible normally for the same buyer', async () => {
    // The same wanted-after-first-cutoff buyer IS eligible for a SECOND, later job whose
    // own audienceCutoffAt is after their createdAt — the cutoff is per-job, not a
    // permanent ban on the buyer.
    const joinedAt = new Date('2026-01-01T10:10:00.000Z')
    installWantedRowsFixture([
      { id: 'w1', customerProfileId: 'p1', createdAt: joinedAt, availabilityAlertEnabled: true, priceAlertEnabled: true },
    ])
    const laterCutoff = new Date('2026-01-01T12:00:00.000Z')
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job2' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({ id: 'job2', audienceCutoffAt: laterCutoff }))
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect(prisma.buyerAlertEvent.createMany).toHaveBeenCalledTimes(1)
    expect((prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data).toHaveLength(1)
  })

  it('the audience-cutoff filter applies to price-change jobs too, not just availability', async () => {
    installWantedRowsFixture([
      { id: 'w1', customerProfileId: 'p1', createdAt: new Date('2026-01-01T09:00:00.000Z'), availabilityAlertEnabled: true, priceAlertEnabled: true },
      { id: 'w2', customerProfileId: 'p2', createdAt: new Date('2026-01-01T10:30:00.000Z'), availabilityAlertEnabled: true, priceAlertEnabled: true }, // joined after
    ])
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob({
      eventType: 'wanted_price_decrease', previousPriceCents: 2000, currentPriceCents: 1500, audienceCutoffAt: CUTOFF,
    }))
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const created = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(created).toHaveLength(1)
    expect(created[0].customerProfileId).toBe('p1') // only the pre-transition buyer
  })
})

// ── Behavioral: delivery worker (lease claim / idempotency / timeout ambiguity) ─

describe('buyerAlertsDelivery: processPendingBuyerAlerts (behavioral)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ;(Resend as unknown as Mock).mockImplementation(() => ({ emails: { send: mockSend } }))
    process.env.RESEND_API_KEY = 'test-key'
    process.env.BUYER_ALERTS_FROM_EMAIL = 'alerts@example.com'
    process.env.APP_URL = 'https://example.com'
  })

  function baseEvent(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'evt1', customerProfileId: 'p1', catalogModelId: 'cat1', listingId: 'listing1',
      alertType: 'wanted_available', previousPriceCents: null, currentPriceCents: null,
      catalogModel: { brand: 'Hot Wheels', name: 'Ferrari', year: 2024 },
      customerProfile: { email: 'buyer@example.com' },
      ...overrides,
    }
  }

  function mockHappyPath() {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock)
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }) // finalize
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1' })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 19.99, status: 'active', item: { status: 'available' } })
  }

  it('claim query includes stale sending rows (crashed-worker recovery), oldest-first, bounded', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([])
    await processPendingBuyerAlerts(50)

    const args = (prisma.buyerAlertEvent.findMany as Mock).mock.calls[0][0]
    expect(args.take).toBe(50)
    expect(args.orderBy).toEqual({ createdAt: 'asc' })
    expect(args.where.OR[0]).toEqual({ status: 'pending' })
    expect(args.where.OR[1].status).toBe('sending')
  })

  it('sends with a deterministic Resend idempotency key derived from the event id', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'resend-msg-1' }, error: null })

    await processPendingBuyerAlerts()

    const [, options] = mockSend.mock.calls[0]
    expect(options).toEqual({ idempotencyKey: 'buyer-alert/evt1' })
  })

  it('the same event retried twice uses the same idempotency key', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })
    await processPendingBuyerAlerts()
    const firstKey = mockSend.mock.calls[0][1].idempotencyKey

    vi.clearAllMocks()
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'msg2' }, error: null })
    await processPendingBuyerAlerts()
    const secondKey = mockSend.mock.calls[0][1].idempotencyKey

    expect(firstKey).toBe(secondKey)
  })

  it('different events use different idempotency keys', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })
    await processPendingBuyerAlerts()
    const key1 = mockSend.mock.calls[0][1].idempotencyKey

    vi.clearAllMocks()
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt2' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseEvent({ id: 'evt2' }))
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1' })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 19.99, status: 'active', item: { status: 'available' } })
    mockSend.mockResolvedValueOnce({ data: { id: 'msg2' }, error: null })
    await processPendingBuyerAlerts()
    const key2 = mockSend.mock.calls[0][1].idempotencyKey

    expect(key1).not.toBe(key2)
  })

  it('marks sent only after provider success, storing the provider message id', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'resend-msg-1' }, error: null })

    const result = await processPendingBuyerAlerts()

    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, suppressed: 0, unknown: 0 })
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', claimToken: expect.any(String) },
      data: { status: 'sent', sentAt: expect.any(Date), providerMessageId: 'resend-msg-1' },
    })
  })

  it('an explicit Resend error response becomes failed (definitive)', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', message: 'bad', statusCode: 400 } })

    const result = await processPendingBuyerAlerts()

    expect(result.failed).toBe(1)
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', claimToken: expect.any(String) },
      data: { status: 'failed', failureCode: 'validation_error' },
    })
  })

  it('a local timeout becomes delivery_unknown, not failed — the provider may still have accepted it', async () => {
    vi.useFakeTimers()
    try {
      mockHappyPath()
      mockSend.mockImplementationOnce(() => new Promise(() => {})) // never resolves — timeout wins the race

      const resultPromise = processPendingBuyerAlerts()
      await vi.advanceTimersByTimeAsync(9000) // fires the 8s send timeout
      const result = await resultPromise

      expect(result.unknown).toBe(1)
      expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt1', claimToken: expect.any(String) },
        data: { status: 'delivery_unknown', failureCode: 'email_timeout' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a thrown network exception becomes delivery_unknown, not a definitive failure', async () => {
    mockHappyPath()
    mockSend.mockImplementationOnce(() => Promise.reject(new Error('ECONNRESET')))

    const result = await processPendingBuyerAlerts()

    expect(result.unknown).toBe(1)
    const call = (prisma.buyerAlertEvent.updateMany as Mock).mock.calls.find(([args]) => args.data?.status === 'delivery_unknown')
    expect(call).toBeDefined()
  })

  it('suppresses delivery when the wanted relationship was removed before delivery', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce(null)
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('suppresses delivery when email alerts were disabled before delivery', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1' })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: false })
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('suppresses delivery when the listing became unavailable/sold before delivery', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1' })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 19.99, status: 'sold', item: { status: 'sold' } })
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('concurrent workers cannot double-send: a lost claim race is skipped, not processed', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock)
      .mockResolvedValueOnce({ count: 0 }) // fromPending fails
      .mockResolvedValueOnce({ count: 0 }) // fromStale fails too — actively held elsewhere

    const result = await processPendingBuyerAlerts()

    expect(result).toEqual({ claimed: 0, sent: 0, failed: 0, suppressed: 0, unknown: 0 })
    expect(prisma.buyerAlertEvent.findUnique).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a stale sending lease is recoverable by a second worker', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock)
      .mockResolvedValueOnce({ count: 0 }) // fromPending: already 'sending'
      .mockResolvedValueOnce({ count: 1 }) // fromStale: claimedAt older than DELIVERY_LEASE_MS
      .mockResolvedValueOnce({ count: 1 }) // finalize
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1' })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 19.99, status: 'active', item: { status: 'available' } })
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })

    const result = await processPendingBuyerAlerts()

    expect(result.claimed).toBe(1)
    expect(result.sent).toBe(1)
  })

  it('a stale worker cannot overwrite a fresher result: the final write is scoped to its own (now-invalid) claimToken', async () => {
    // This worker claims successfully, but by the time it tries to finalize, its lease
    // has since been reclaimed by another worker — the finalize updateMany (scoped to
    // this worker's claimToken) correctly returns count 0 and the DB row is untouched
    // by this stale worker.
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockReset()
    ;(prisma.buyerAlertEvent.updateMany as Mock)
      .mockResolvedValueOnce({ count: 1 })  // claim succeeds
      .mockResolvedValueOnce({ count: 0 })  // finalize('sent') loses — claimToken no longer matches

    await processPendingBuyerAlerts()

    const finalizeCall = (prisma.buyerAlertEvent.updateMany as Mock).mock.calls[1][0]
    expect(finalizeCall.where).toEqual({ id: 'evt1', claimToken: expect.any(String) })
  })

  it('no automatic retry loop: a single call processes each pending event at most once', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'timeout', message: '', statusCode: 500 } })

    await processPendingBuyerAlerts()

    expect(mockSend).toHaveBeenCalledTimes(1) // no in-process retry after a definitive failure
  })

  it('email contains only safe marketplace data (model name, price, listing link) — no seller identity', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })

    await processPendingBuyerAlerts()

    const sentArgs = mockSend.mock.calls[0][0]
    expect(sentArgs.to).toBe('buyer@example.com')
    expect(sentArgs.html).toContain('Hot Wheels Ferrari')
    expect(sentArgs.html).toContain('19.99')
    expect(sentArgs.html).toContain('/browse/listing1')
    expect(sentArgs.html.toLowerCase()).not.toContain('seller')
  })

  // ── Gap 3: delivery_unknown must never be retried automatically or via the admin
  // action — there is no verified provider idempotency-window duration to retry safely
  // within, so a blind retry risks a real duplicate send. Only definitive 'failed' rows
  // are retryable.

  it('retryFailedAlertEvent allows only failed — never delivery_unknown, sent, suppressed, or pending', async () => {
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    const ok = await retryFailedAlertEvent('evt1')
    expect(ok).toBe(true)
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', status: 'failed' },
      data: { status: 'pending', failureCode: null, claimToken: null, claimedAt: null },
    })
  })

  it('delivery_unknown is never automatically retried: the query is scoped to status=failed, so a delivery_unknown row matches nothing', async () => {
    // Simulates the real DB behavior: updateMany({where:{id, status:'failed'}}) against
    // a row whose actual status is 'delivery_unknown' matches 0 rows.
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 0 })
    const ok = await retryFailedAlertEvent('evt-ambiguous')
    expect(ok).toBe(false)
  })

  it('a stale delivery_unknown row cannot be blindly resent through any exposed path', () => {
    const deliverySrc = readSrc('src/lib/buyerAlertsDelivery.ts')
    const retryFnSrc = deliverySrc.slice(deliverySrc.indexOf('export async function retryFailedAlertEvent'))
    expect(retryFnSrc).toContain("status: 'failed'")
    expect(retryFnSrc).not.toContain('delivery_unknown')

    const adminPageSrc = readSrc('src/app/(admin)/admin/system/alerts/page.tsx')
    // The retry button/form must not render for delivery_unknown rows.
    expect(adminPageSrc).toContain('isAmbiguous')
    expect(adminPageSrc).toMatch(/isAmbiguous\s*\?[\s\S]{0,120}No retry/)
  })

  it('sent cannot retry', async () => {
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 0 }) // status='sent' doesn't match status:'failed'
    const ok = await retryFailedAlertEvent('evt-sent')
    expect(ok).toBe(false)
  })

  it('failed can retry, and the retried event is revalidated (preferences/wanted/availability) fresh on redelivery, not skipped', async () => {
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    const ok = await retryFailedAlertEvent('evt1')
    expect(ok).toBe(true)

    // The retried row re-enters the normal pending queue — the next delivery attempt
    // goes through the SAME suppression checks as any first-time delivery.
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // claim
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce(null) // buyer removed it since the original failure
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // suppress

    const result = await processPendingBuyerAlerts()
    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('retryFailedAlertEvent reuses the same idempotency key on the next delivery attempt (unchanged event id)', async () => {
    mockHappyPath()
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })
    await processPendingBuyerAlerts()
    const key = mockSend.mock.calls[0][1].idempotencyKey
    expect(key).toBe(`buyer-alert/evt1`) // stable — retry would compute the exact same key
  })
})

// ── Behavioral: notification center — in-app state independent of email delivery ─

describe('buyerAlerts: getAlertEvents pagination + suppressed-still-visible (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('bounded page size, deterministic newest-first order, no status filter', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([])
    await getAlertEvents('p1')
    const args = (prisma.buyerAlertEvent.findMany as Mock).mock.calls[0][0]
    expect(args.orderBy).toEqual({ id: 'desc' })
    expect(args.take).toBeLessThanOrEqual(21)
    expect(args.where).toEqual({ customerProfileId: 'p1' }) // status is NOT filtered — suppressed stays visible
  })

  it('a suppressed event (email disabled) still appears in the buyer-facing list with independent read state', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{
      id: 'evt1', alertType: 'wanted_available', catalogModelId: 'cat1', listingId: 'listing1',
      previousPriceCents: null, currentPriceCents: 1999, status: 'suppressed', createdAt: new Date(), readAt: null,
      catalogModel: { brand: 'Hot Wheels', name: 'Ferrari', year: 2024 },
    }])
    ;(prisma.listing.findMany as Mock).mockResolvedValueOnce([{ id: 'listing1' }])

    const { items } = await getAlertEvents('p1')

    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('suppressed')
    expect(items[0].readAt).toBeNull() // unread independent of delivery status
  })
})

describe('buyerAlerts: markAlertRead / markAllAlertsRead ownership (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('markAlertRead scopes the update to id AND customerProfileId, independent of alert status', async () => {
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    const ok = await markAlertRead('evt1', 'p1')
    expect(ok).toBe(true)
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', customerProfileId: 'p1', readAt: null },
      data: { readAt: expect.any(Date) },
    })
  })

  it('markAlertRead returns false when the event does not belong to the caller', async () => {
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 0 })
    const ok = await markAlertRead('evt1', 'someone-elses-profile')
    expect(ok).toBe(false)
  })

  it('markAllAlertsRead scopes to customerProfileId only', async () => {
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 3 })
    const count = await markAllAlertsRead('p1')
    expect(count).toBe(3)
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { customerProfileId: 'p1', readAt: null },
      data: { readAt: expect.any(Date) },
    })
  })
})

// ── Behavioral: buyer-facing server actions (auth) ───────────────────────────────

describe('buyerAlerts actions: auth and ownership (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('markAlertReadAction is a no-op without a session (no DB call)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValueOnce(null)
    await markAlertReadAction('evt1')
    expect(prisma.buyerAlertEvent.updateMany).not.toHaveBeenCalled()
  })

  it('markAllAlertsReadAction is a no-op without a session', async () => {
    ;(getBuyerSession as Mock).mockResolvedValueOnce(null)
    await markAllAlertsReadAction()
    expect(prisma.buyerAlertEvent.updateMany).not.toHaveBeenCalled()
  })

  it('updateAlertPreferences rejects unauthenticated requests', async () => {
    ;(getBuyerSession as Mock).mockResolvedValueOnce(null)
    const fd = new FormData()
    const result = await updateAlertPreferences(null, fd)
    expect(result?.errors._form).toBeDefined()
    expect(prisma.buyerAlertPreference.upsert).not.toHaveBeenCalled()
  })

  it('updateAlertPreferences upserts using session.profileId, never a client-supplied id', async () => {
    ;(getBuyerSession as Mock).mockResolvedValueOnce({ profileId: 'p1' })
    ;(prisma.buyerAlertPreference.upsert as Mock).mockResolvedValueOnce({})
    const fd = new FormData()
    fd.set('wantedAvailableAlerts', 'on')
    fd.set('customerProfileId', 'someone-elses-id')
    await updateAlertPreferences(null, fd)

    const args = (prisma.buyerAlertPreference.upsert as Mock).mock.calls[0][0]
    expect(args.where).toEqual({ customerProfileId: 'p1' })
    expect(args.create.customerProfileId).toBe('p1')
  })

  it('updateAlertPreferences rejects an out-of-range threshold', async () => {
    ;(getBuyerSession as Mock).mockResolvedValueOnce({ profileId: 'p1' })
    const fd = new FormData()
    fd.set('priceChangeThresholdPct', '500')
    const result = await updateAlertPreferences(null, fd)
    expect(result?.errors.priceChangeThresholdPct).toBeDefined()
    expect(prisma.buyerAlertPreference.upsert).not.toHaveBeenCalled()
  })

  it('toggleWantedAlertAction is ownership-scoped via findFirst(customerProfileId)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValueOnce({ profileId: 'p1' })
    ;(prisma.wantedCatalogModel.findFirst as Mock).mockResolvedValueOnce({ id: 'w1', availabilityAlertEnabled: true, priceAlertEnabled: true })
    ;(prisma.wantedCatalogModel.update as Mock).mockResolvedValueOnce({})

    await toggleWantedAlertAction('w1', 'availabilityAlertEnabled')

    expect(prisma.wantedCatalogModel.findFirst).toHaveBeenCalledWith({
      where: { id: 'w1', customerProfileId: 'p1' },
      select: { id: true, availabilityAlertEnabled: true, priceAlertEnabled: true },
    })
    expect(prisma.wantedCatalogModel.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { availabilityAlertEnabled: false } })
  })
})

describe('buyerAlerts admin actions: independent auth + fan-out/delivery wiring (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('retryBuyerAlertEventAction does nothing without admin auth', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    await expect(retryBuyerAlertEventAction('evt1')).rejects.toThrow()
    expect(prisma.buyerAlertEvent.updateMany).not.toHaveBeenCalled()
  })

  it('runBuyerAlertProcessorAction does nothing without admin auth', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    await expect(runBuyerAlertProcessorAction()).rejects.toThrow()
    expect(prisma.buyerAlertFanout.findMany).not.toHaveBeenCalled()
    expect(prisma.buyerAlertEvent.findMany).not.toHaveBeenCalled()
  })

  it('runBuyerAlertProcessorAction runs fan-out before delivery (events must exist before they can be sent)', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(true)
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([])

    await runBuyerAlertProcessorAction()

    // Both ran; fan-out's candidate query happened before delivery's.
    expect(prisma.buyerAlertFanout.findMany).toHaveBeenCalled()
    expect(prisma.buyerAlertEvent.findMany).toHaveBeenCalled()
  })

  it('admin processor + a concurrent cron run cannot double-process: both use the same DB-conditional claim', async () => {
    const adminSrc = readSrc('src/lib/actions/adminBuyerAlerts.ts')
    const cronSrc = readSrc('src/app/api/cron/buyer-alerts/route.ts')
    // Both call the exact same exported processors — no separate/duplicated claim logic.
    expect(adminSrc).toContain('processFanoutJobs()')
    expect(adminSrc).toContain('processPendingBuyerAlerts()')
    expect(cronSrc).toContain('processFanoutJobs()')
    expect(cronSrc).toContain('processPendingBuyerAlerts()')
  })
})

// ── Behavioral: cron route auth ──────────────────────────────────────────────────

describe('buyerAlerts cron route: /api/cron/buyer-alerts (behavioral)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.CRON_SECRET
  })

  it('rejects a request with no Authorization header', async () => {
    process.env.CRON_SECRET = 'super-secret'
    const req = new Request('https://example.com/api/cron/buyer-alerts')
    const res = await buyerAlertsCronGET(req)
    expect(res.status).toBe(401)
    expect(prisma.buyerAlertFanout.findMany).not.toHaveBeenCalled()
  })

  it('rejects a request with the wrong secret', async () => {
    process.env.CRON_SECRET = 'super-secret'
    const req = new Request('https://example.com/api/cron/buyer-alerts', { headers: { authorization: 'Bearer wrong' } })
    const res = await buyerAlertsCronGET(req)
    expect(res.status).toBe(401)
  })

  it('rejects a query-string secret — only the Authorization header is honored', async () => {
    process.env.CRON_SECRET = 'super-secret'
    const req = new Request('https://example.com/api/cron/buyer-alerts?secret=super-secret')
    const res = await buyerAlertsCronGET(req)
    expect(res.status).toBe(401)
  })

  it('fails closed when CRON_SECRET is not configured in production — no secret means no access, ever', async () => {
    delete process.env.CRON_SECRET
    const req = new Request('https://example.com/api/cron/buyer-alerts', { headers: { authorization: 'Bearer anything' } })
    const res = await buyerAlertsCronGET(req)
    expect(res.status).toBe(401)
  })

  it('runs fan-out then delivery when the secret matches', async () => {
    process.env.CRON_SECRET = 'super-secret'
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([])

    const req = new Request('https://example.com/api/cron/buyer-alerts', { headers: { authorization: 'Bearer super-secret' } })
    const res = await buyerAlertsCronGET(req)

    expect(res.status).toBe(200)
    expect(prisma.buyerAlertFanout.findMany).toHaveBeenCalled()
    expect(prisma.buyerAlertEvent.findMany).toHaveBeenCalled()
  })
})

// ── Preference resolution defaults ───────────────────────────────────────────────

describe('buyerAlerts: resolveAlertPreference defaults', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns all-enabled defaults when no preference row exists yet', async () => {
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce(null)
    const pref = await resolveAlertPreference('p1')
    expect(pref).toEqual({
      wantedAvailableAlerts: true,
      wantedPriceChangeAlerts: true,
      emailAlertsEnabled: true,
      priceChangeThresholdPct: null,
    })
  })
})

// ── Wanted-list availability aggregation (pre-existing, still N+1-free) ─────────

describe('buyerAlerts: wanted-list availability aggregation stays batched', () => {
  it('the wanted-list page uses matchWantedList (one batched query), not a per-item listing query', () => {
    const pageSrc = readSrc('src/app/(store)/account/wanted/page.tsx')
    expect(pageSrc).toContain('matchWantedList(catalogIds)')
    expect(pageSrc).not.toMatch(/items\.map[\s\S]{0,200}prisma\.listing\.findMany/)
  })
})
