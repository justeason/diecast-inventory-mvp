import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    intakeDraft: { findMany: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    sellerProfile: { findMany: vi.fn(), findUnique: vi.fn() },
    sellerAgreement: { findFirst: vi.fn() },
    sellerSubmission: { findUnique: vi.fn() },
    itemInstance: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({ getPricingIntelligence: vi.fn().mockResolvedValue(null) }))

import { prisma } from '@/lib/prisma'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import { searchExceptionQueue, getExceptionQueueSummary, getExceptionDetail } from '@/lib/intakeExceptionQueueQuery'

function baseDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft1', workbenchExceptionCode: 'unknown_model', workbenchExceptionNote: 'No model resolved.',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    brand: null, name: null, condition: 'mint', cardedOrLoose: 'carded',
    catalogModel: null,
    intakeLocation: { label: 'B-14-03' },
    sellerInboundShipmentId: 'ship1',
    sellerInboundShipment: { trackingNumber: 'TRACK1', sellerPortfolioId: 'port1', sellerPortfolio: { id: 'port1', name: 'Summer 2026' } },
    sellerSubmission: { profileId: 'prof1', sellerPortfolioId: 'port1', sellerPortfolio: { id: 'port1', name: 'Summer 2026' } },
    ...overrides,
  }
}

describe('searchExceptionQueue — listing/pagination/filters (section 5/6/7)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns rows with resolved seller/portfolio/shipment labels', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([baseDraftRow()])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([{ profileId: 'prof1', profile: { name: 'Alice', email: 'a@x.com' } }])

    const page = await searchExceptionQueue({}, null)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: 'draft1', code: 'unknown_model', sellerLabel: 'Alice', portfolioName: 'Summer 2026', shipmentTrackingNumber: 'TRACK1', source: 'workbench',
    })
  })

  it('draftLabel falls back to brand/name when no catalog resolved; catalogLabel is null', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([baseDraftRow({ brand: 'Hot Wheels', name: 'Porsche 911' })])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    const page = await searchExceptionQueue({}, null)
    expect(page.items[0].catalogLabel).toBeNull()
    expect(page.items[0].draftLabel).toBe('Hot Wheels Porsche 911')
  })

  it('a manual (non-workbench) draft — no sellerInboundShipmentId — is labeled source "manual"', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([baseDraftRow({ sellerInboundShipmentId: null, sellerInboundShipment: null })])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    const page = await searchExceptionQueue({}, null)
    expect(page.items[0].source).toBe('manual')
  })

  it('keyset pagination: fetches pageSize+1 with a cursor, never OFFSET', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({}, 'cursor1', 25)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.take).toBe(26)
    expect(call.cursor).toEqual({ id: 'cursor1' })
    expect(call.skip).toBe(1)
    expect(call.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
  })

  it('reports nextCursor only when more rows exist beyond the page', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => baseDraftRow({ id: `d${i}` }))
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce(rows)
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    const page = await searchExceptionQueue({}, null, 2)
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBe('d1')
  })

  it('no duplicates/omissions: the page never returns more than pageSize items even when hasMore', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => baseDraftRow({ id: `d${i}` }))
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce(rows)
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    const page = await searchExceptionQueue({}, null, 4)
    expect(page.items.map((i) => i.id)).toEqual(['d0', 'd1', 'd2', 'd3'])
  })

  it('applies the code filter DB-side', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ code: 'invalid_storage' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.workbenchExceptionCode).toBe('invalid_storage')
  })

  it('applies the category filter as an IN clause over that category\'s codes', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ category: 'data_fixable' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.workbenchExceptionCode.in.sort()).toEqual(['invalid_storage', 'missing_condition', 'unknown_model'])
  })

  it('applies the shipment filter DB-side', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ shipmentId: 'ship1' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.sellerInboundShipmentId).toBe('ship1')
  })

  it('applies the portfolio filter via either the shipment or submission portfolio link', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ portfolioId: 'port1' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.OR).toEqual([
      { sellerInboundShipment: { sellerPortfolioId: 'port1' } },
      { sellerSubmission: { sellerPortfolioId: 'port1' } },
    ])
  })

  it('applies the seller (profileId) filter DB-side', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ profileId: 'prof1' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.sellerSubmission).toEqual({ profileId: 'prof1' })
  })

  it('applies an age-group filter as a DB-side date range', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ ageGroup: '>3d' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.createdAt).toBeDefined()
  })

  it('free-text search matches draft id, shipment id, brand/name, catalog model, and portfolio name', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ q: 'porsche' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.OR.length).toBeGreaterThan (3)
  })

  it('combines a portfolio filter AND a text search via AND, not silently dropping one', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ portfolioId: 'port1', q: 'porsche' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.AND).toHaveLength(2)
    expect(call.where.OR).toBeUndefined()
  })

  it('the open-exception predicate is always applied, even with other filters', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([])
    await searchExceptionQueue({ code: 'unknown_model' }, null)
    const call = (prisma.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.convertedItemId).toBeNull()
    expect(call.where.status).toEqual({ not: 'rejected' })
  })

  it('seller hydration is a single bounded batch query, never per-row (no N+1)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => baseDraftRow({ id: `d${i}`, sellerSubmission: { profileId: `prof${i % 3}`, sellerPortfolioId: 'port1', sellerPortfolio: { id: 'port1', name: 'P' } } }))
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce(rows)
    ;(prisma.sellerProfile.findMany as Mock).mockResolvedValueOnce([
      { profileId: 'prof0', profile: { name: 'A', email: 'a@x.com' } },
      { profileId: 'prof1', profile: { name: 'B', email: 'b@x.com' } },
      { profileId: 'prof2', profile: { name: 'C', email: 'c@x.com' } },
    ])
    await searchExceptionQueue({}, null)
    expect((prisma.sellerProfile.findMany as Mock).mock.calls.length).toBe(1)
    const call = (prisma.sellerProfile.findMany as Mock).mock.calls[0][0]
    expect(call.where.profileId.in.sort()).toEqual(['prof0', 'prof1', 'prof2'])
  })

  it('no seller batch query at all when the page has no drafts with a submission', async () => {
    ;(prisma.intakeDraft.findMany as Mock).mockResolvedValueOnce([])
    const page = await searchExceptionQueue({}, null)
    expect(page.items).toEqual([])
    expect(prisma.sellerProfile.findMany).not.toHaveBeenCalled()
  })
})

describe('getExceptionQueueSummary — DB-side grouped counts (section 5/30)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('aggregates counts by code via a single groupBy call, never a loaded list', async () => {
    ;(prisma.intakeDraft.groupBy as Mock).mockResolvedValueOnce([
      { workbenchExceptionCode: 'unknown_model', _count: { _all: 7 } },
      { workbenchExceptionCode: 'invalid_storage', _count: { _all: 4 } },
      { workbenchExceptionCode: 'missing_condition', _count: { _all: 2 } },
      { workbenchExceptionCode: 'unexpected_overage', _count: { _all: 3 } },
      { workbenchExceptionCode: 'conversion_failed', _count: { _all: 2 } },
    ])
    ;(prisma.intakeDraft.findFirst as Mock).mockResolvedValueOnce({ createdAt: new Date('2026-01-01') })

    const summary = await getExceptionQueueSummary()
    expect(summary.open).toBe(18)
    expect(summary.byCode).toEqual({ unknown_model: 7, invalid_storage: 4, missing_condition: 2, unexpected_overage: 3, conversion_failed: 2 })
    expect(summary.byCategory).toEqual({ data_fixable: 13, retryable: 2, commercial_blocker: 3 })
    expect((prisma.intakeDraft.groupBy as Mock).mock.calls.length).toBe(1)
  })

  it('scopes to a portfolio/shipment when provided', async () => {
    ;(prisma.intakeDraft.groupBy as Mock).mockResolvedValueOnce([])
    ;(prisma.intakeDraft.findFirst as Mock).mockResolvedValueOnce(null)
    await getExceptionQueueSummary({ shipmentId: 'ship1' })
    const call = (prisma.intakeDraft.groupBy as Mock).mock.calls[0][0]
    expect(call.where.sellerInboundShipmentId).toBe('ship1')
  })

  it('oldestCreatedAt is null when there are no open exceptions', async () => {
    ;(prisma.intakeDraft.groupBy as Mock).mockResolvedValueOnce([])
    ;(prisma.intakeDraft.findFirst as Mock).mockResolvedValueOnce(null)
    const summary = await getExceptionQueueSummary()
    expect(summary.oldestCreatedAt).toBeNull()
    expect(summary.open).toBe(0)
  })
})

describe('getExceptionDetail — bounded detail read (section 9/28)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns null for a missing draft', async () => {
    ;(prisma.intakeDraft.findUnique as Mock).mockResolvedValueOnce(null)
    expect(await getExceptionDetail('missing')).toBeNull()
  })

  it('returns null for a draft that is not an open exception (workbenchExceptionCode null) — detail is exception-only', async () => {
    ;(prisma.intakeDraft.findUnique as Mock).mockResolvedValueOnce({ id: 'd1', workbenchExceptionCode: null, sellerSubmissionId: null })
    expect(await getExceptionDetail('d1')).toBeNull()
  })

  it('loads submission/portfolio/agreement/shipment/seller context and pricing only for the selected catalog model', async () => {
    ;(prisma.intakeDraft.findUnique as Mock).mockResolvedValueOnce({
      id: 'd1', status: 'draft', workbenchExceptionCode: 'unknown_model', workbenchExceptionNote: 'x', createdAt: new Date(),
      brand: null, name: null, year: null, series: null, color: null, scale: null,
      condition: 'mint', cardedOrLoose: 'carded', conditionNotes: null, frontPhotoUrl: null, backPhotoUrl: null,
      catalogModelId: 'cat1', storageLocationId: 'loc1', convertedItemId: null,
      catalogModel: { brand: 'Hot Wheels', name: 'Porsche 911' },
      intakeLocation: { label: 'B-14-03' },
      sellerSubmissionId: 'sub1',
      sellerSubmission: { id: 'sub1', profileId: 'prof1', sellerPortfolioId: 'port1', sellerPortfolio: { id: 'port1', name: 'Summer' } },
      sellerInboundShipmentId: 'ship1',
      sellerInboundShipment: { id: 'ship1', trackingNumber: 'TRACK1', receivedQuantity: 120, sellerPortfolioId: 'port1', sellerPortfolio: { id: 'port1', name: 'Summer' } },
    })
    ;(prisma.sellerAgreement.findFirst as Mock).mockResolvedValueOnce({ id: 'agr1', status: 'accepted', type: 'consignment' })
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ profileId: 'prof1' })
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce({ profile: { name: 'Alice', email: 'a@x.com' } })
    ;(getPricingIntelligence as Mock).mockResolvedValueOnce({ catalogModelId: 'cat1', estimatedValueCents: 1850 })

    const detail = await getExceptionDetail('d1')
    expect(detail).toMatchObject({
      code: 'unknown_model', catalogLabel: 'Hot Wheels Porsche 911', storageLabel: 'B-14-03',
      sellerLabel: 'Alice', portfolio: { id: 'port1', name: 'Summer' }, agreement: { id: 'agr1', status: 'accepted' },
      shipment: { id: 'ship1', trackingNumber: 'TRACK1', receivedQuantity: 120 },
    })
    expect(detail!.pricing).toMatchObject({ estimatedValueCents: 1850 })
    expect(getPricingIntelligence).toHaveBeenCalledWith('cat1')
  })

  it('never fetches pricing when no catalog model is resolved (unknown_model, still unresolved)', async () => {
    ;(prisma.intakeDraft.findUnique as Mock).mockResolvedValueOnce({
      id: 'd1', status: 'draft', workbenchExceptionCode: 'unknown_model', workbenchExceptionNote: 'x', createdAt: new Date(),
      brand: null, name: null, year: null, series: null, color: null, scale: null,
      condition: null, cardedOrLoose: null, conditionNotes: null, frontPhotoUrl: null, backPhotoUrl: null,
      catalogModelId: null, storageLocationId: null, convertedItemId: null,
      catalogModel: null, intakeLocation: null,
      sellerSubmissionId: null, sellerSubmission: null,
      sellerInboundShipmentId: null, sellerInboundShipment: null,
    })
    const detail = await getExceptionDetail('d1')
    expect(detail!.pricing).toBeNull()
    expect(getPricingIntelligence).not.toHaveBeenCalled()
  })

  it('this module never mutates — no create/update/delete calls anywhere in the file', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/intakeExceptionQueueQuery.ts'), 'utf-8')
    expect(src).not.toMatch(/\.(create|update|delete|upsert|updateMany|deleteMany)\(/)
  })

  it('15E-review section 1/7: exposes immutable initial evidence separately from the current code/note, so a caller can tell they differ', async () => {
    ;(prisma.intakeDraft.findUnique as Mock).mockResolvedValueOnce({
      id: 'd1', status: 'draft', workbenchExceptionCode: 'invalid_storage', workbenchExceptionNote: 'Storage is missing.', createdAt: new Date(),
      initialExceptionCode: 'unknown_model', initialExceptionNote: 'No model resolved.', initialExceptionAt: new Date('2026-01-01T00:00:00Z'),
      brand: null, name: null, year: null, series: null, color: null, scale: null,
      condition: 'mint', cardedOrLoose: 'carded', conditionNotes: null, frontPhotoUrl: null, backPhotoUrl: null,
      catalogModelId: null, storageLocationId: null, convertedItemId: null,
      catalogModel: null, intakeLocation: null,
      sellerSubmissionId: null, sellerSubmission: null,
      sellerInboundShipmentId: null, sellerInboundShipment: null,
    })
    const detail = await getExceptionDetail('d1')
    expect(detail).toMatchObject({ code: 'invalid_storage', initialCode: 'unknown_model', initialNote: 'No model resolved.' })
    expect(detail!.initialExceptionAt).toEqual(new Date('2026-01-01T00:00:00Z'))
  })

  it('15E-review section 7: a resolved (converted) draft exposes the created item\'s SKU', async () => {
    ;(prisma.intakeDraft.findUnique as Mock).mockResolvedValueOnce({
      id: 'd1', status: 'converted', workbenchExceptionCode: 'unknown_model', workbenchExceptionNote: 'x', createdAt: new Date(),
      initialExceptionCode: 'unknown_model', initialExceptionNote: 'x', initialExceptionAt: new Date(),
      brand: null, name: null, year: null, series: null, color: null, scale: null,
      condition: 'mint', cardedOrLoose: 'carded', conditionNotes: null, frontPhotoUrl: null, backPhotoUrl: null,
      catalogModelId: 'cat1', storageLocationId: 'loc1', convertedItemId: 'item1',
      catalogModel: { brand: 'Hot Wheels', name: 'Porsche 911' }, intakeLocation: { label: 'B-14-03' },
      sellerSubmissionId: null, sellerSubmission: null,
      sellerInboundShipmentId: null, sellerInboundShipment: null,
    })
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValueOnce({ sku: 'HW-0042' })
    const detail = await getExceptionDetail('d1')
    expect(detail!.convertedItemSku).toBe('HW-0042')
  })
})
