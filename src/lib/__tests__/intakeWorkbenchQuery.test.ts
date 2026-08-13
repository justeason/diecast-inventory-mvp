import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    sellerInboundShipment: { findUnique: vi.fn() },
    sellerSubmission: { findUnique: vi.fn() },
    sellerAgreement: { findMany: vi.fn() },
    sellerPortfolio: { findUnique: vi.fn() },
    sellerProfile: { findUnique: vi.fn() },
    itemInstance: { count: vi.fn(), findMany: vi.fn() },
    intakeDraft: { count: vi.fn() },
    intakeWorkbenchSession: { findUnique: vi.fn() },
    sellerLifecycleEvent: { findFirst: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getWorkbenchContext } from '@/lib/intakeWorkbenchQuery'

function baseShipment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ship1', status: 'received', carrier: 'UPS', trackingNumber: 'TRACK1',
    expectedQuantity: 120, receivedQuantity: 120, shippedAt: new Date('2026-01-01'), receivedAt: new Date('2026-01-05'),
    sellerSubmissionId: 'sub1', sellerPortfolioId: 'port1',
    ...overrides,
  }
}

function baseSubmission(overrides: Record<string, unknown> = {}) {
  return { id: 'sub1', quantity: 120, status: 'approved_for_intake', condition: 'mint', cardedOrLoose: 'carded', profileId: 'prof1', ...overrides }
}

function defaultMocks() {
  ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([{ id: 'agr1', type: 'consignment', status: 'accepted', commissionPercent: null, commissionSource: null, sellerPortfolioId: 'port1' }])
  ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValue({ id: 'port1', name: 'Summer 2026', acceptedItemCount: 120 })
  ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValue({ id: 'sp1', profile: { name: 'Alice', email: 'a@x.com' } })
  ;(prisma.itemInstance.count as Mock).mockResolvedValue(47)
  ;(prisma.intakeDraft.count as Mock).mockResolvedValue(3)
  ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
  ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValue(null)
  ;(prisma.sellerLifecycleEvent.findFirst as Mock).mockResolvedValue(null)
}

describe('getWorkbenchContext (section 3/4)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns null for a missing shipment', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(null)
    expect(await getWorkbenchContext('missing')).toBeNull()
  })

  it('loads seller, portfolio, agreement, and progress in one authoritative context — no re-selection needed', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx).toMatchObject({
      shipment: { id: 'ship1', status: 'received', expectedQuantity: 120, receivedQuantity: 120 },
      submission: { id: 'sub1', quantity: 120 },
      portfolio: { id: 'port1', name: 'Summer 2026' },
      seller: { sellerProfileId: 'sp1', label: 'Alice' },
      agreement: { id: 'agr1', type: 'consignment', status: 'accepted' },
      sourceType: 'consignment',
      eligibilityBlocked: null,
      defaults: { condition: 'mint', cardedOrLoose: 'carded' },
    })
    expect(ctx!.progress).toEqual({ expected: 120, received: 120, processed: 47, exceptions: 3, remaining: 70 })
  })

  it('surfaces eligibilityBlocked (never eligible=true) when no accepted agreement exists, without throwing', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValueOnce([{ id: 'agr1', type: 'consignment', status: 'proposed', commissionPercent: null, commissionSource: null, sellerPortfolioId: 'port1' }])
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({ id: 'port1', name: 'P', acceptedItemCount: null })
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ id: 'sp1', profile: { name: 'Alice', email: 'a@x.com' } })
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(0)
    ;(prisma.intakeDraft.count as Mock).mockResolvedValueOnce(0)
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce(null)
    ;(prisma.sellerLifecycleEvent.findFirst as Mock).mockResolvedValueOnce(null)

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx!.sourceType).toBeNull()
    expect(ctx!.agreement).toBeNull()
    expect(ctx!.eligibilityBlocked).toMatch(/acceptance has not been recorded/)
  })

  it('recent items are bounded (a single findMany call with a take limit), never the full shipment inventory', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([
      { id: 'i1', sku: 'HW-0001', createdAt: new Date(), catalog: { brand: 'Hot Wheels', name: 'Porsche' }, location: { label: 'B-14-03' } },
    ])

    await getWorkbenchContext('ship1')
    expect((prisma.itemInstance.findMany as Mock).mock.calls.length).toBe(1)
    const call = (prisma.itemInstance.findMany as Mock).mock.calls[0][0]
    expect(call.take).toBeGreaterThan(0)
    expect(call.take).toBeLessThanOrEqual(20)
    expect(call.where).toEqual({ sellerInboundShipmentId: 'ship1' })
  })

  it('counts are DB-side aggregates (count calls), never a loaded list summed in JS', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()

    await getWorkbenchContext('ship1')
    expect((prisma.itemInstance.count as Mock).mock.calls.length).toBe(1)
    expect((prisma.intakeDraft.count as Mock).mock.calls.length).toBe(1)
    const exceptionCountArgs = (prisma.intakeDraft.count as Mock).mock.calls[0][0]
    expect(exceptionCountArgs.where).toMatchObject({ sellerInboundShipmentId: 'ship1', status: { not: 'converted' }, workbenchExceptionCode: { not: null } })
  })

  it('exception count is a physical-unit count: a 5-unit exception batch (5 IntakeDraft rows sharing the same batch) reports exceptions=5, not 1 (section 5)', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(0)
    ;(prisma.intakeDraft.count as Mock).mockResolvedValueOnce(5)

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx!.progress.exceptions).toBe(5)
    // received(120) - processed(0) - exceptions(5): remaining accounts for every physical unit.
    expect(ctx!.progress.remaining).toBe(115)
  })

  it('an active lease is surfaced as held; an expired one is not (never permanently blocks)', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce({ claimToken: 'other', expiresAt: new Date(Date.now() + 60_000) })

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx!.lease.held).toBe(true)
  })

  it('an expired lease row is reported as not held', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce({ claimToken: 'other', expiresAt: new Date(Date.now() - 60_000) })

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx!.lease.held).toBe(false)
  })

  it('reconciliation.status is "in_progress" and observedPhysical/variance are still live-computed when no reconciliation event exists yet', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment({ receivedQuantity: 200 }))
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(194)
    ;(prisma.intakeDraft.count as Mock).mockResolvedValueOnce(3)

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx!.reconciliation).toMatchObject({ status: 'in_progress', observedPhysical: 197, variance: -3, hasUnresolvedExceptions: true, lastReconciledAt: null })
  })

  it('reconciliation.status is "reconciled" when a prior event matches the CURRENT live counts exactly (variance 0)', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment({ receivedQuantity: 200 }))
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(197)
    ;(prisma.intakeDraft.count as Mock).mockResolvedValueOnce(3)
    const reconciledAt = new Date('2026-02-01T00:00:00Z')
    ;(prisma.sellerLifecycleEvent.findFirst as Mock).mockResolvedValueOnce({
      metadata: { recordedReceived: 200, observedPhysical: 200 }, occurredAt: reconciledAt,
    })

    const ctx = await getWorkbenchContext('ship1')
    // 197 processed + 3 exceptions = 200 observed, matches the recorded snapshot exactly.
    expect(ctx!.reconciliation).toMatchObject({ status: 'reconciled', observedPhysical: 200, variance: 0, hasUnresolvedExceptions: true, lastReconciledAt: reconciledAt })
  })

  it('reconciliation.status is "reconciled_with_variance" when the current (matching) snapshot has nonzero variance', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment({ receivedQuantity: 200 }))
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(194)
    ;(prisma.intakeDraft.count as Mock).mockResolvedValueOnce(3)
    const reconciledAt = new Date('2026-02-01T00:00:00Z')
    ;(prisma.sellerLifecycleEvent.findFirst as Mock).mockResolvedValueOnce({
      metadata: { recordedReceived: 200, observedPhysical: 197 }, occurredAt: reconciledAt,
    })

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx!.reconciliation).toMatchObject({ status: 'reconciled_with_variance', observedPhysical: 197, variance: -3, lastReconciledAt: reconciledAt })
  })

  it('a STALE reconciliation event (counts changed since — e.g. an exception got resolved) reverts to "in_progress", never silently kept as reconciled', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment({ receivedQuantity: 200 }))
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()
    // Live counts now show 200 processed, 0 exceptions (an exception got resolved into a conversion).
    ;(prisma.itemInstance.count as Mock).mockResolvedValueOnce(200)
    ;(prisma.intakeDraft.count as Mock).mockResolvedValueOnce(0)
    // But the last reconciliation event captured the OLD state (197 observed).
    ;(prisma.sellerLifecycleEvent.findFirst as Mock).mockResolvedValueOnce({
      metadata: { recordedReceived: 200, observedPhysical: 197 }, occurredAt: new Date('2026-02-01T00:00:00Z'),
    })

    const ctx = await getWorkbenchContext('ship1')
    expect(ctx!.reconciliation.status).toBe('in_progress')
    expect(ctx!.reconciliation.lastReconciledAt).toBeNull()
    expect(ctx!.reconciliation.observedPhysical).toBe(200)
  })

  it('the reconciliation lookup is bounded (findFirst, take-1-equivalent, indexed sourceEntityType/sourceEntityId)', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValueOnce(baseShipment())
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce(baseSubmission())
    defaultMocks()

    await getWorkbenchContext('ship1')
    expect((prisma.sellerLifecycleEvent.findFirst as Mock).mock.calls.length).toBe(1)
    const call = (prisma.sellerLifecycleEvent.findFirst as Mock).mock.calls[0][0]
    expect(call.where).toMatchObject({ sourceEntityType: 'SellerInboundShipment', sourceEntityId: 'ship1', eventType: 'shipment_intake_reconciled' })
  })

  it('this module never mutates — no create/update/delete calls anywhere in the file', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/intakeWorkbenchQuery.ts'), 'utf-8')
    expect(src).not.toMatch(/\.(create|update|delete|upsert|updateMany|deleteMany)\(/)
  })
})
