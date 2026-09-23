/**
 * 34B: Wanted Target Price Alerts — built entirely on the existing 14A buyer-alert
 * pipeline (trigger -> fan-out -> delivery). No new fanout job type, no new schema,
 * no new preference toggle. Covers: price-change crossing, activation crossing,
 * one-event-per-recipient precedence, null-target/preference regressions, canonical
 * money conversion, delivery re-validation, email/in-app copy, and privacy/merge
 * regression coverage per the 34B spec's test plan (§47-63).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    wantedCatalogModel:   { findMany: vi.fn(), findUnique: vi.fn() },
    buyerAlertPreference: { findMany: vi.fn(), findUnique: vi.fn() },
    buyerAlertEvent:      { createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    buyerAlertFanout:     { createMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    listing:              { findUnique: vi.fn() },
  },
}))

const mockSend = vi.fn()
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}))

import { prisma } from '@/lib/prisma'
import { Resend } from 'resend'
import { processFanoutJobs } from '@/lib/buyerAlertsFanoutProcessor'
import { processPendingBuyerAlerts } from '@/lib/buyerAlertsDelivery'
import { createAvailableFanoutJob } from '@/lib/buyerAlertsTrigger'
import { buildWantedPriceTargetReachedEmail } from '@/lib/email/buyerAlertEmail'

type Mock = ReturnType<typeof vi.fn>

const D = (s: string) => new Prisma.Decimal(s)

beforeEach(() => vi.resetAllMocks())

// ── §0/§19/§64/§65 — schema/migrations/packages untouched ──────────────────────

describe('§19/§64 — no new schema/crossing-state, migration count unchanged', () => {
  it('migration count is unchanged at 53', () => {
    const dirs = fs.readdirSync(path.join(process.cwd(), 'prisma/migrations')).filter((f) => fs.statSync(path.join(process.cwd(), 'prisma/migrations', f)).isDirectory())
    expect(dirs.length).toBe(53)
  })

  it('WantedCatalogModel gained no new crossing-state column', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/currentlyBelowThreshold|lastThresholdAlertAt|lastThresholdPrice|thresholdArmed/i)
  })

  it('package.json is unchanged (0 new packages)', () => {
    expect(readSrc('package.json')).not.toMatch(/"resend2"|"node-cron"|"bull"|"bullmq"/)
  })
})

// ── §18/§37/§38 — boundaries: no Lowest-Ask query, no Market Signals/external ───

describe('§18/§37/§38 — boundaries respected', () => {
  it('the fanout processor never imports a Lowest-Ask / ask-depth query', () => {
    const src = readSrc('src/lib/buyerAlertsFanoutProcessor.ts')
    expect(src).not.toMatch(/getInternalAskSummary|getInternalAskDepth|marketAskQuery/)
  })

  it('trigger/fanout/delivery never reference Market Signals/EMV/external market research', () => {
    for (const f of ['src/lib/buyerAlertsTrigger.ts', 'src/lib/buyerAlertsFanoutProcessor.ts', 'src/lib/buyerAlertsDelivery.ts']) {
      const src = readSrc(f)
      expect(src).not.toMatch(/marketSignals|marketValuation|externalMarketResearch|getValuation/i)
    }
  })

  it('target-alert copy never uses the phrase "Lowest Ask"', () => {
    for (const f of ['src/lib/email/buyerAlertEmail.ts', 'src/app/(store)/account/wanted/page.tsx']) {
      expect(stripComments(readSrc(f))).not.toMatch(/Lowest Ask/)
    }
  })
})

// ── §47 — TEST: price crossing ──────────────────────────────────────────────────

describe('§4/§47 — price-change crossing rule', () => {
  function fanoutJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job1', eventType: 'wanted_price_decrease', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_price:listing1:3500:2900:2', previousPriceCents: 3500, currentPriceCents: 2900,
      listingVersion: 2, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
      ...overrides,
    }
  }

  function wantedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true,
      maxDesiredPrice: D('30.00'),
      ...overrides,
    }
  }

  async function runOnce(jobOverrides: Record<string, unknown>, rowOverrides: Record<string, unknown> = {}) {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // claim
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob(jobOverrides))
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([wantedRow(rowOverrides)])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // checkpoint
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // complete
    await processFanoutJobs()
    const calls = (prisma.buyerAlertEvent.createMany as Mock).mock.calls
    return calls.length > 0 ? calls[0][0].data : []
  }

  it('$35 -> $29 crossing a $30 target produces a target event', async () => {
    const events = await runOnce({ previousPriceCents: 3500, currentPriceCents: 2900 })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_price_target_reached')
  })

  it('$29 -> $20 (already below target) does not re-fire a target event — generic decrease semantics apply', async () => {
    // A large enough drop to clear the existing generic meaningful-change threshold too,
    // isolating this test to the target-crossing rule rather than the unrelated 5% filter.
    const events = await runOnce({ previousPriceCents: 2900, currentPriceCents: 2000 })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_price_decrease')
  })

  it('$28 -> $31 (increase, crosses back above target) never produces a target event', async () => {
    const events = await runOnce({ eventType: 'wanted_price_increase', previousPriceCents: 2800, currentPriceCents: 3100 })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_price_increase')
  })

  it('$31 -> $30 crossing the target again DOES re-fire (no persisted crossing state)', async () => {
    const events = await runOnce({ previousPriceCents: 3100, currentPriceCents: 3000 })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_price_target_reached')
  })

  it('$31 -> $30.01 (does not reach target) produces no target event', async () => {
    const events = await runOnce({ previousPriceCents: 3100, currentPriceCents: 3001 })
    expect(events.find((e: { alertType: string }) => e.alertType === 'wanted_price_target_reached')).toBeUndefined()
  })
})

// ── §48 — TEST: activation ──────────────────────────────────────────────────────

describe('§5/§48 — activation crossing rule', () => {
  function fanoutJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
      ...overrides,
    }
  }

  async function runOnce(jobOverrides: Record<string, unknown>, rowOverrides: Record<string, unknown> = {}) {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(fanoutJob(jobOverrides))
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00'), ...rowOverrides },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    await processFanoutJobs()
    const calls = (prisma.buyerAlertEvent.createMany as Mock).mock.calls
    return calls.length > 0 ? calls[0][0].data : []
  }

  it('new/reactivated listing at $29 with priceAlertEnabled=true produces a target alert', async () => {
    const events = await runOnce({ currentPriceCents: 2900 })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_price_target_reached')
  })

  it('new listing at $31 (above target) falls through to existing availability behavior', async () => {
    const events = await runOnce({ currentPriceCents: 3100 })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_available')
  })

  it('the eventKey on the target event is the SAME as the underlying job eventKey (no second key)', async () => {
    const events = await runOnce({ currentPriceCents: 2900, eventKey: 'wanted_available:listing1:1' })
    expect(events[0].eventKey).toBe('wanted_available:listing1:1')
  })
})

// ── §49 — TEST: precedence / no duplicates ──────────────────────────────────────

describe('§6/§49 — precedence: exactly one event per recipient per fanout job', () => {
  it('activation below target with BOTH toggles enabled: exactly one event, type=target', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data).toHaveLength(1)
    expect(data[0].alertType).toBe('wanted_price_target_reached')
  })

  it('price decrease crossing target: exactly one event, type=target (never target+decrease)', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_price_decrease', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_price:listing1:3500:2900:2', previousPriceCents: 3500, currentPriceCents: 2900,
      listingVersion: 2, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data).toHaveLength(1)
    expect(data[0].alertType).toBe('wanted_price_target_reached')
  })
})

// ── Follow-up patch: two-layer price-alert preference semantics (§1-§10) ────────

describe('Follow-up §1/§2 — target eligibility respects BOTH price-alert preference layers', () => {
  function activationJob() {
    return {
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    }
  }

  function decreaseJob() {
    return {
      id: 'job1', eventType: 'wanted_price_decrease', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_price:listing1:3500:2900:2', previousPriceCents: 3500, currentPriceCents: 2900,
      listingVersion: 2, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    }
  }

  async function runOnce(job: Record<string, unknown>, row: Record<string, unknown>, pref: Record<string, unknown> | null) {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(job)
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([row])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce(pref ? [pref] : [])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // checkpoint (fires even with 0 events)
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // complete
    await processFanoutJobs()
    const calls = (prisma.buyerAlertEvent.createMany as Mock).mock.calls
    return calls.length > 0 ? calls[0][0].data : []
  }

  it('A. global price=false, row price=true, activation below target, both availability layers enabled -> exactly one wanted_available, zero target', async () => {
    const events = await runOnce(
      activationJob(),
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
      { customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: false, emailAlertsEnabled: true, priceChangeThresholdPct: null },
    )
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_available')
  })

  it('B. global price=false, row price=true, price decrease crosses target -> zero target, zero generic price alert', async () => {
    const events = await runOnce(
      decreaseJob(),
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
      { customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: false, emailAlertsEnabled: true, priceChangeThresholdPct: null },
    )
    expect(events).toHaveLength(0)
  })

  it('C. global price=true, row price=false, price decrease crosses target -> zero target (and zero generic, since row.priceAlertEnabled gates the generic branch too)', async () => {
    const events = await runOnce(
      decreaseJob(),
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: false, maxDesiredPrice: D('30.00') },
      { customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: true, emailAlertsEnabled: true, priceChangeThresholdPct: null },
    )
    expect(events).toHaveLength(0)
  })

  it('D. global price=true, row price=true, crosses target -> exactly one target', async () => {
    const events = await runOnce(
      decreaseJob(),
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
      { customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: true, emailAlertsEnabled: true, priceChangeThresholdPct: null },
    )
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_price_target_reached')
  })

  it('H. target condition true but target eligibility disabled must not suppress an otherwise-enabled availability event', async () => {
    // Same scenario as A, restated to make the precedence-ordering guarantee explicit:
    // an ineligible target never silently swallows a valid availability alert.
    const events = await runOnce(
      activationJob(),
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: false, maxDesiredPrice: D('30.00') },
      { customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: true, emailAlertsEnabled: true, priceChangeThresholdPct: null },
    )
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_available')
  })
})

describe('Follow-up §6 — delivery-time revalidation of both price-alert preference layers', () => {
  beforeEach(() => {
    ;(Resend as unknown as Mock).mockImplementation(() => ({ emails: { send: mockSend } }))
    process.env.RESEND_API_KEY = 'test-key'
    process.env.BUYER_ALERTS_FROM_EMAIL = 'alerts@example.com'
    process.env.APP_URL = 'https://example.com'
  })

  function targetEvent() {
    return {
      id: 'evt1', customerProfileId: 'p1', catalogModelId: 'cat1', listingId: 'listing1',
      alertType: 'wanted_price_target_reached', previousPriceCents: 3500, currentPriceCents: 2900,
      catalogModel: { brand: 'Hot Wheels', name: 'Ferrari', year: 2024 },
      customerProfile: { email: 'buyer@example.com' },
    }
  }

  it('E. global wantedPriceChangeAlerts disabled after event creation -> no target email, suppressed', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(targetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1', maxDesiredPrice: D('30.00'), priceAlertEnabled: true })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true, wantedPriceChangeAlerts: false })

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', claimToken: expect.any(String) },
      data: { status: 'suppressed', failureCode: 'price_alerts_disabled' },
    })
  })

  it('F. row.priceAlertEnabled disabled after event creation -> no target email, suppressed', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(targetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1', maxDesiredPrice: D('30.00'), priceAlertEnabled: false })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true, wantedPriceChangeAlerts: true })

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', claimToken: expect.any(String) },
      data: { status: 'suppressed', failureCode: 'price_alerts_disabled' },
    })
  })

  it('G. emailAlertsEnabled=false: no email delivery (in-app persistence is a fanout-time concern, unaffected here)', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(targetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1', maxDesiredPrice: D('30.00'), priceAlertEnabled: true })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: false, wantedPriceChangeAlerts: true })

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', claimToken: expect.any(String) },
      data: { status: 'suppressed', failureCode: 'email_disabled' },
    })
  })

  it('G (fanout side): emailAlertsEnabled=false still creates the in-app BuyerAlertEvent row, just pre-suppressed (existing semantics, unchanged for target)', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([
      { customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: true, emailAlertsEnabled: false, priceChangeThresholdPct: null },
    ])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data).toHaveLength(1)
    expect(data[0].alertType).toBe('wanted_price_target_reached')
    expect(data[0].status).toBe('suppressed') // row exists (in-app), just pre-marked not-to-send
  })
})

// ── §50 — TEST: null target ──────────────────────────────────────────────────────

describe('§12/§50 — null maxDesiredPrice: all existing behavior unchanged', () => {
  it('activation below what WOULD be a target, but maxDesiredPrice is null: existing availability alert fires, no target event', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: null },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data).toHaveLength(1)
    expect(data[0].alertType).toBe('wanted_available')
  })
})

// ── §51 — TEST: preferences ──────────────────────────────────────────────────────

describe('§13/§14/§51 — priceAlertEnabled / availabilityAlertEnabled interaction', () => {
  function activationJob() {
    return {
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    }
  }

  async function runWithRow(row: Record<string, unknown>) {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce(activationJob())
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'w1', customerProfileId: 'p1', ...row }])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    await processFanoutJobs()
    const calls = (prisma.buyerAlertEvent.createMany as Mock).mock.calls
    return calls.length > 0 ? calls[0][0].data : []
  }

  it('priceAlertEnabled=false: no target event even though the price condition is met', async () => {
    const events = await runWithRow({ availabilityAlertEnabled: true, priceAlertEnabled: false, maxDesiredPrice: D('30.00') })
    expect(events.find((e: { alertType: string }) => e.alertType === 'wanted_price_target_reached')).toBeUndefined()
  })

  it('availabilityAlertEnabled=true + priceAlertEnabled=false + activation below target: existing availability alert still fires', async () => {
    const events = await runWithRow({ availabilityAlertEnabled: true, priceAlertEnabled: false, maxDesiredPrice: D('30.00') })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_available')
  })

  it('priceAlertEnabled=true + availabilityAlertEnabled=false + activation below target: target event fires anyway', async () => {
    const events = await runWithRow({ availabilityAlertEnabled: false, priceAlertEnabled: true, maxDesiredPrice: D('30.00') })
    expect(events).toHaveLength(1)
    expect(events[0].alertType).toBe('wanted_price_target_reached')
  })
})

// ── §52 — TEST: priceChangeThresholdPct interaction ─────────────────────────────

describe('§15/§52 — priceChangeThresholdPct does not suppress a genuine target crossing', () => {
  it('a target crossing fires even when the % move is below the buyer\'s generic threshold', async () => {
    // $30.50 -> $29.99 is a ~1.7% move — well under a 5%+ generic threshold — but still
    // crosses a $30 target, so the target alert must fire regardless.
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_price_decrease', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_price:listing1:3050:2999:2', previousPriceCents: 3050, currentPriceCents: 2999,
      listingVersion: 2, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([{ customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: true, emailAlertsEnabled: true, priceChangeThresholdPct: 50 }])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data).toHaveLength(1)
    expect(data[0].alertType).toBe('wanted_price_target_reached')
  })

  it('generic (non-crossing) price-change alerts still respect priceChangeThresholdPct unchanged', async () => {
    // No target set — a small move below the buyer's threshold produces no event at all.
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_price_decrease', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_price:listing1:3050:2999:2', previousPriceCents: 3050, currentPriceCents: 2999,
      listingVersion: 2, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: null },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([{ customerProfileId: 'p1', wantedAvailableAlerts: true, wantedPriceChangeAlerts: true, emailAlertsEnabled: true, priceChangeThresholdPct: 50 }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // checkpoint (no events pushed, still checkpoints)
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 }) // complete

    await processFanoutJobs()

    expect(prisma.buyerAlertEvent.createMany).not.toHaveBeenCalled()
  })
})

// ── §53 — TEST: canonical money ──────────────────────────────────────────────────

describe('§11/§53 — canonical cents conversion for maxDesiredPrice', () => {
  it('a Decimal maxDesiredPrice of exactly the current price counts as reached (<=, not <)', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2999,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('29.99') },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data[0].alertType).toBe('wanted_price_target_reached')
  })

  it('a sub-cent Decimal boundary (29.995 rounds to 3000 cents via ROUND_HALF_UP) is honored', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 3000,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('29.995') },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data[0].alertType).toBe('wanted_price_target_reached') // 29.995 -> 3000 cents, currentCents 3000 <= 3000
  })

  it('legacy event-key conversion (toCents/Math.round) is unchanged for price-change jobs', () => {
    const src = readSrc('src/lib/buyerAlertKeys.ts')
    expect(src).toContain('Math.round(dollars * 100)')
  })

  it('the availability trigger now stamps currentPriceCents using the existing toCents helper (not a second ad hoc conversion)', () => {
    const src = readSrc('src/lib/buyerAlertsTrigger.ts')
    const fnSrc = src.slice(src.indexOf('export async function createAvailableFanoutJob'))
    expect(fnSrc).toContain('toCents(priceDollars)')
  })
})

// ── §54 — TEST: idempotency ──────────────────────────────────────────────────────

describe('§9/§54 — idempotency: retrying the same fanout event creates no duplicate target row', () => {
  it('createMany is called with skipDuplicates: true for a page containing a target event', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: D('30.00') },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect((prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].skipDuplicates).toBe(true)
  })
})

// ── §55 — TEST: delivery revalidation ────────────────────────────────────────────

describe('§22/§23/§55 — delivery-time revalidation for target events', () => {
  beforeEach(() => {
    ;(Resend as unknown as Mock).mockImplementation(() => ({ emails: { send: mockSend } }))
    process.env.RESEND_API_KEY = 'test-key'
    process.env.BUYER_ALERTS_FROM_EMAIL = 'alerts@example.com'
    process.env.APP_URL = 'https://example.com'
  })

  function baseTargetEvent(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'evt1', customerProfileId: 'p1', catalogModelId: 'cat1', listingId: 'listing1',
      alertType: 'wanted_price_target_reached', previousPriceCents: 3500, currentPriceCents: 2900,
      catalogModel: { brand: 'Hot Wheels', name: 'Ferrari', year: 2024 },
      customerProfile: { email: 'buyer@example.com' },
      ...overrides,
    }
  }

  it('sends when the listing price is still <= the target at delivery time', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseTargetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1', maxDesiredPrice: D('30.00'), priceAlertEnabled: true })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true, wantedPriceChangeAlerts: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 29.00, status: 'active', item: { status: 'available' } })
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })

    const result = await processPendingBuyerAlerts()

    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, suppressed: 0, unknown: 0 })
  })

  it('suppresses (does not send) when the listing price has since risen back above the target', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseTargetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1', maxDesiredPrice: D('30.00'), priceAlertEnabled: true })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true, wantedPriceChangeAlerts: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 32.00, status: 'active', item: { status: 'available' } })

    const result = await processPendingBuyerAlerts()

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, suppressed: 1, unknown: 0 })
    expect(mockSend).not.toHaveBeenCalled()
    expect(prisma.buyerAlertEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', claimToken: expect.any(String) },
      data: { status: 'suppressed', failureCode: 'target_no_longer_met' },
    })
  })

  it('suppresses when the listing is no longer active (existing revalidation, unweakened)', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseTargetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1', maxDesiredPrice: D('30.00'), priceAlertEnabled: true })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true, wantedPriceChangeAlerts: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 29.00, status: 'sold', item: { status: 'sold' } })

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('suppresses when the Wanted row was removed since the event was created', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseTargetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce(null)

    const result = await processPendingBuyerAlerts()

    expect(result.suppressed).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not issue an extra query beyond the existing stillWanted lookup to re-check the target', async () => {
    ;(prisma.buyerAlertEvent.findMany as Mock).mockResolvedValueOnce([{ id: 'evt1' }])
    ;(prisma.buyerAlertEvent.updateMany as Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertEvent.findUnique as Mock).mockResolvedValueOnce(baseTargetEvent())
    ;(prisma.wantedCatalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'w1', maxDesiredPrice: D('30.00'), priceAlertEnabled: true })
    ;(prisma.buyerAlertPreference.findUnique as Mock).mockResolvedValueOnce({ emailAlertsEnabled: true, wantedPriceChangeAlerts: true })
    ;(prisma.listing.findUnique as Mock).mockResolvedValueOnce({ price: 29.00, status: 'active', item: { status: 'available' } })
    mockSend.mockResolvedValueOnce({ data: { id: 'msg1' }, error: null })

    await processPendingBuyerAlerts()

    expect(prisma.wantedCatalogModel.findUnique).toHaveBeenCalledTimes(1)
  })
})

// ── §56 — TEST: in-app ────────────────────────────────────────────────────────────

describe('§21/§56 — in-app alert card for the target type', () => {
  const pageSrc = readSrc('src/app/(store)/account/wanted/page.tsx')

  it('ALERT_LABELS includes a human-readable label for wanted_price_target_reached', () => {
    expect(pageSrc).toMatch(/wanted_price_target_reached:\s*'At your target price'/)
  })

  it('the label uses factual copy, no "Lowest Ask"/investment language', () => {
    expect(pageSrc).not.toMatch(/Great deal|Undervalued|Buy now|Act fast|Before it rises|Investment opportunity/i)
  })

  it('target events use the same read/unread and listing-link render path as existing types (no separate branch)', () => {
    // Only one .map() render loop exists for alert events — no type-specific duplicate card path.
    const alertsViewSrc = pageSrc.slice(pageSrc.indexOf('showAlerts'), pageSrc.indexOf('Wanted list view'))
    expect((alertsViewSrc.match(/items\.map\(/g) ?? []).length).toBe(1)
  })
})

// ── §57 — TEST: email ─────────────────────────────────────────────────────────────

describe('§7/§20/§25/§26/§57 — target-price email builder', () => {
  it('builds factual copy with model name, price, and listing link', () => {
    const built = buildWantedPriceTargetReachedEmail({ modelName: 'Hot Wheels Ferrari (2024)', priceDollars: 29.0, listingUrl: 'https://example.com/browse/listing1' })
    expect(built.subject).toContain('Hot Wheels Ferrari (2024)')
    expect(built.html).toContain('at or below your desired price')
    expect(built.html).toContain('$29.00')
    expect(built.html).toContain('https://example.com/browse/listing1')
    expect(built.text).toContain('$29.00')
  })

  it('never uses "Lowest Ask" or speculative/investment language', () => {
    const built = buildWantedPriceTargetReachedEmail({ modelName: 'Ferrari', priceDollars: 29.0, listingUrl: 'https://example.com/browse/listing1' })
    for (const forbidden of ['Lowest Ask', 'Great deal', 'Undervalued', 'Buy now', 'Act fast', 'before it rises', 'Investment opportunity']) {
      expect(built.html).not.toContain(forbidden)
      expect(built.text).not.toContain(forbidden)
    }
  })

  it('the email footer includes a real clickable Manage alert preferences link to /account/wanted?view=alerts', () => {
    const built = buildWantedPriceTargetReachedEmail({ modelName: 'Ferrari', priceDollars: 29.0, listingUrl: 'https://example.com/browse/listing1' })
    expect(built.html).toMatch(/<a href="[^"]*\/account\/wanted\?view=alerts"[^>]*>Manage alert preferences<\/a>/)
  })

  it('is not labeled a one-click unsubscribe (no such mechanism exists)', () => {
    const built = buildWantedPriceTargetReachedEmail({ modelName: 'Ferrari', priceDollars: 29.0, listingUrl: 'https://example.com/browse/listing1' })
    expect(built.html.toLowerCase()).not.toContain('one-click unsubscribe')
    expect(built.html).not.toContain('List-Unsubscribe')
  })

  it('the existing availability/price-change emails also gained the same real Manage-preferences link', () => {
    const src = readSrc('src/lib/email/buyerAlertEmail.ts')
    const shellSrc = src.slice(src.indexOf('function shell'), src.indexOf('function manageUrl'))
    expect(shellSrc).toMatch(/<a href="[^"]*manageUrl\(\)[^"]*"[^>]*>Manage alert preferences<\/a>/)
  })
})

// ── §58 — TEST: Want copy ─────────────────────────────────────────────────────────

describe('§27/§58 — Want copy honesty', () => {
  it('the compact catalog-card Want control is unchanged (still just "♡ Want", no clutter)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/components/store/CatalogModelCard.tsx'), 'utf-8')
    expect(src).not.toMatch(/enabled by default|alerts will highlight/)
  })

  it('the Wanted/Alerts account surface explains alerts are on by default', () => {
    const src = readSrc('src/app/(store)/account/wanted/page.tsx')
    expect(src).toContain('Availability and price alerts are enabled by default when you add a model to Wanted')
  })

  it('no new Watch concept was introduced', () => {
    for (const f of ['src/app/(store)/account/wanted/page.tsx', 'src/lib/actions/wantedList.ts', 'src/lib/buyerAlertsFanoutProcessor.ts']) {
      expect(readSrc(f)).not.toMatch(/Watchlist|Price Watch|\bWatch\b/)
    }
  })

  it('maxDesiredPrice inputs gained helper copy connecting them to alert behavior', () => {
    for (const f of ['src/components/store/WantedListAddForm.tsx', 'src/components/store/WantedEditForm.tsx']) {
      expect(readSrc(f)).toContain('When set, price alerts will highlight when a listing reaches this price.')
    }
  })
})

// ── §59 — TEST: privacy ───────────────────────────────────────────────────────────

describe('§31/§59 — maxDesiredPrice never exposed publicly', () => {
  it('no (store) catalog/browse page renders maxDesiredPrice', () => {
    for (const f of ['src/app/(store)/catalog/[id]/page.tsx', 'src/app/(store)/browse/[id]/page.tsx']) {
      expect(readSrc(f)).not.toMatch(/maxDesiredPrice/)
    }
  })

  it('the email builders never take another user\'s maxDesiredPrice as input (single-recipient shape only)', () => {
    const src = stripComments(readSrc('src/lib/email/buyerAlertEmail.ts'))
    expect(src).not.toMatch(/customerProfileId|maxDesiredPrice/)
  })
})

// ── §60 — TEST: merge ─────────────────────────────────────────────────────────────

describe('§32/§60 — catalog-merge regression: maxDesiredPrice conflict resolution unchanged', () => {
  it('reconcileWantedCatalogModelMerge still carries maxDesiredPrice through the freshest-updatedAt-wins rule, with no new field added', () => {
    const src = readSrc('src/lib/actions/catalog.ts')
    const fnSrc = src.slice(src.indexOf('async function reconcileWantedCatalogModelMerge'), src.indexOf('// 18C: ExternalMarketObservation'))
    expect(fnSrc).toContain('maxDesiredPrice: freshest.maxDesiredPrice')
    expect(fnSrc).not.toMatch(/currentlyBelowThreshold|lastThresholdAlertAt|lastThresholdPrice/)
  })
})

// ── §61 — TEST: performance ────────────────────────────────────────────────────────

describe('§33/§61 — fanout performance: no per-row DB query added', () => {
  it('processes a full 200-row page with exactly one wantedCatalogModel.findMany call and one preference batch load', async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({
      id: `w${String(i).padStart(4, '0')}`, customerProfileId: `p${i}`,
      availabilityAlertEnabled: true, priceAlertEnabled: true,
      maxDesiredPrice: i % 2 === 0 ? D('30.00') : null,
    }))
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce(page).mockResolvedValueOnce([])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValue([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValue({ count: 200 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect(prisma.wantedCatalogModel.findMany).toHaveBeenCalledTimes(2) // page 1 + empty page 2
    expect(prisma.buyerAlertPreference.findMany).toHaveBeenCalledTimes(1) // one batched load for page 1
    const data = (prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data
    expect(data).toHaveLength(200)
    expect(data.filter((e: { alertType: string }) => e.alertType === 'wanted_price_target_reached')).toHaveLength(100)
  })
})

// ── §62 — TEST: existing alert-type regressions ──────────────────────────────────

describe('§36/§62 — existing alert types unaffected for customers without maxDesiredPrice', () => {
  it('wanted_available fires normally with maxDesiredPrice=null', async () => {
    ;(prisma.buyerAlertFanout.findMany as Mock).mockResolvedValueOnce([{ id: 'job1' }])
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.findUnique as Mock).mockResolvedValueOnce({
      id: 'job1', eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:1', previousPriceCents: null, currentPriceCents: 2900,
      listingVersion: 1, status: 'pending', cursor: null, audienceCutoffAt: new Date(),
    })
    ;(prisma.wantedCatalogModel.findMany as Mock).mockResolvedValueOnce([
      { id: 'w1', customerProfileId: 'p1', availabilityAlertEnabled: true, priceAlertEnabled: true, maxDesiredPrice: null },
    ])
    ;(prisma.buyerAlertPreference.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.buyerAlertEvent.createMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    ;(prisma.buyerAlertFanout.updateMany as Mock).mockResolvedValueOnce({ count: 1 })

    await processFanoutJobs()

    expect((prisma.buyerAlertEvent.createMany as Mock).mock.calls[0][0].data[0].alertType).toBe('wanted_available')
  })

  it('createAvailableFanoutJob still writes exactly the pre-34B fields plus currentPriceCents (eventKey/listingVersion/eventType unchanged)', async () => {
    const tx = { buyerAlertFanout: { createMany: vi.fn().mockResolvedValue({ count: 1 }) } }
    await createAvailableFanoutJob(tx as never, 'cat1', 'listing1', 5, 12.5)
    const call = tx.buyerAlertFanout.createMany.mock.calls[0][0]
    expect(call.data[0]).toEqual({
      eventType: 'wanted_available', listingId: 'listing1', catalogModelId: 'cat1',
      eventKey: 'wanted_available:listing1:5', listingVersion: 5, currentPriceCents: 1250,
    })
  })
})

// ── §63 — TEST: Market boundary (no import) ──────────────────────────────────────

describe('§63 — no marketSignals/marketValuation/externalMarketResearch import anywhere in the target-alert path', () => {
  it('static import scan across all touched files', () => {
    for (const f of [
      'src/lib/buyerAlertsTrigger.ts',
      'src/lib/buyerAlertsFanoutProcessor.ts',
      'src/lib/buyerAlertsDelivery.ts',
      'src/lib/email/buyerAlertEmail.ts',
    ]) {
      const src = readSrc(f)
      expect(src).not.toMatch(/from '@\/lib\/marketSignals/)
      expect(src).not.toMatch(/from '@\/lib\/marketValuation/)
      expect(src).not.toMatch(/from '@\/lib\/externalMarketResearch/)
    }
  })
})
