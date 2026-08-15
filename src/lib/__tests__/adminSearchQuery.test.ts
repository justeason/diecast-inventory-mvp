// 15H Part H: global admin search DB-boundary tests. Bounded per-group results,
// minimum query length, and — most importantly (Part H section 28) — no buyer PII
// (email/phone/address) ever selected or matched, anywhere in this file.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { findMany: vi.fn() },
    catalogModel: { findMany: vi.fn() },
    sellerProfile: { findMany: vi.fn() },
    sellerPortfolio: { findMany: vi.fn() },
    sellerInboundShipment: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    listing: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { searchAdmin, MIN_QUERY_LENGTH } from '@/lib/adminSearchQuery'

function emptyAll() {
  ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([])
  ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([])
  ;(prisma.sellerProfile.findMany as Mock).mockResolvedValue([])
  ;(prisma.sellerPortfolio.findMany as Mock).mockResolvedValue([])
  ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValue([])
  ;(prisma.order.findMany as Mock).mockResolvedValue([])
  ;(prisma.listing.findMany as Mock).mockResolvedValue([])
}

describe('searchAdmin — minimum query length', () => {
  beforeEach(() => { vi.resetAllMocks(); emptyAll() })

  it('returns [] and issues no queries below MIN_QUERY_LENGTH', async () => {
    expect(MIN_QUERY_LENGTH).toBeGreaterThanOrEqual(2)
    const results = await searchAdmin('a'.repeat(MIN_QUERY_LENGTH - 1))
    expect(results).toEqual([])
    expect(prisma.itemInstance.findMany).not.toHaveBeenCalled()
  })

  it('returns [] for a whitespace-only query regardless of length', async () => {
    const results = await searchAdmin('   ')
    expect(results).toEqual([])
  })

  it('runs queries once the trimmed query meets MIN_QUERY_LENGTH', async () => {
    await searchAdmin('GT'.padEnd(MIN_QUERY_LENGTH, 'x'))
    expect(prisma.itemInstance.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('searchAdmin — bounded results, DB-side filtered', () => {
  beforeEach(() => { vi.resetAllMocks(); emptyAll() })

  it('every group query is take-bounded', async () => {
    await searchAdmin('porsche')
    for (const model of [
      prisma.itemInstance.findMany, prisma.catalogModel.findMany, prisma.sellerProfile.findMany,
      prisma.sellerPortfolio.findMany, prisma.sellerInboundShipment.findMany, prisma.order.findMany,
      prisma.listing.findMany,
    ]) {
      const call = (model as Mock).mock.calls[0][0]
      expect(call.take).toBeGreaterThan(0)
      expect(call.take).toBeLessThanOrEqual(25)
    }
  })

  it('groups with no matches are omitted entirely from the result, not returned empty', async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([
      { id: 'i1', sku: 'CT-001', catalog: { brand: 'Hot Wheels', name: 'GT3' } },
    ])
    const results = await searchAdmin('gt3')
    expect(results).toHaveLength(1)
    expect(results[0].group).toBe('items')
  })

  it('maps an item result to its detail page, carrying catalog label as sublabel', async () => {
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValue([
      { id: 'i1', sku: 'CT-0018352', catalog: { brand: 'Hot Wheels', name: 'Porsche 911 GT3' } },
    ])
    const results = await searchAdmin('CT-0018')
    expect(results[0].results[0]).toEqual({
      group: 'items', id: 'i1', label: 'CT-0018352', sublabel: 'Hot Wheels Porsche 911 GT3',
      href: '/admin/items/i1',
    })
  })
})

describe('searchAdmin — order search (Part H section 28)', () => {
  beforeEach(() => { vi.resetAllMocks(); emptyAll() })

  it('matches orders by id prefix only — never by buyer email/name/phone', async () => {
    await searchAdmin('ord_abc123')
    const call = (prisma.order.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ id: { startsWith: 'ord_abc123' } })
  })

  it('never selects buyer email/phone/address for an order result', async () => {
    await searchAdmin('ord_abc123')
    const call = (prisma.order.findMany as Mock).mock.calls[0][0]
    expect(call.select).not.toHaveProperty('buyerEmail')
    expect(call.select).not.toHaveProperty('buyerPhone')
    expect(call.select).not.toHaveProperty('buyerName')
  })
})

describe('searchAdmin — shipment result href (workbench vs submission fallback)', () => {
  beforeEach(() => { vi.resetAllMocks(); emptyAll() })

  it('links a received shipment straight to its workbench', async () => {
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValue([
      { id: 's1', trackingNumber: '1Z999', status: 'received', sellerSubmissionId: 'sub1' },
    ])
    const results = await searchAdmin('1Z999')
    expect(results[0].results[0].href).toBe('/admin/intake/workbench/s1')
  })

  it('links a draft/shipped shipment to its submission when the workbench is not yet applicable', async () => {
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValue([
      { id: 's2', trackingNumber: '1Z888', status: 'shipped', sellerSubmissionId: 'sub2' },
    ])
    const results = await searchAdmin('1Z888')
    expect(results[0].results[0].href).toBe('/admin/seller-submissions/sub2')
  })
})

describe('no buyer PII anywhere in the module source (structural, Part H section 28)', () => {
  it('adminSearchQuery.ts never references buyerEmail/buyerPhone/buyerName/customerProfile', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/adminSearchQuery.ts'), 'utf-8')
    expect(src).not.toMatch(/buyerEmail|buyerPhone|buyerName|customerProfile/)
  })

  it('adminSearchQuery.ts contains no create/update/delete/upsert calls — search is read-only', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/adminSearchQuery.ts'), 'utf-8')
    expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })
})
