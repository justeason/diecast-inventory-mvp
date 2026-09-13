// 21B §20-24/§44-46: createOrder is the ONE production OrderItem.create call site
// (verified structurally below). Every new OrderItem must snapshot catalogModelId/
// marketVariantId (mutable identity pointers) AND snapshotPackagingType/
// snapshotCondition (immutable sale-time facts) from the authoritative ItemInstance
// in the SAME creation flow.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    listing: { findMany: vi.fn() },
    customerProfile: { upsert: vi.fn().mockResolvedValue({ id: 'prof1' }) },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn() }))
vi.mock('@/lib/actions/sellerPayouts', () => ({ ensureConsignmentPayoutLinesForCompletedOrder: vi.fn() }))
vi.mock('@/lib/actions/sellerLifecycle', () => ({ ensureSellerLifecycleEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))

import { prisma } from '@/lib/prisma'
import { createOrder } from '@/lib/actions/orders'

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing1',
    itemId: 'item1',
    price: 10,
    item: { catalogId: 'cat1', marketVariantId: 'variant1', cardedOrLoose: 'carded', condition: 'mint' },
    ...overrides,
  }
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    order: { create: vi.fn().mockResolvedValue({ id: 'order1' }) },
    orderItem: { create: vi.fn().mockResolvedValue({}) },
    itemInstance: { update: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function formData(): FormData {
  const fd = new FormData()
  fd.set('listingIds', 'listing1')
  fd.set('buyerName', 'Jane Buyer')
  fd.set('buyerEmail', 'jane@example.com')
  return fd
}

describe('createOrder — OrderItem snapshot (21B)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'prof1' })
  })

  it('copies catalogModelId, marketVariantId, snapshotPackagingType, and snapshotCondition from the authoritative ItemInstance at creation, tagged sale_time (21C)', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'prof1' })
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, formData())).resolves.toEqual({ success: true, orderId: 'order1' })

    expect(tx.orderItem.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order1',
        itemId: 'item1',
        listingId: 'listing1',
        price: 10,
        catalogModelId: 'cat1',
        marketVariantId: 'variant1',
        snapshotPackagingType: 'carded',
        snapshotCondition: 'mint',
        snapshotProvenance: 'sale_time',
      },
    })
  })

  it('21C: snapshotProvenance is always the literal "sale_time" — never caller-supplied, never derived from formData', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    const tx = makeTx()
    mockTransaction(tx)
    const fd = formData()
    fd.set('snapshotProvenance', 'legacy_model_only') // malicious/stray field — must be ignored
    await expect(createOrder(null, fd)).resolves.toEqual({ success: true, orderId: 'order1' })
    expect((tx.orderItem.create as Mock).mock.calls[0][0].data.snapshotProvenance).toBe('sale_time')
  })

  it('reads item.catalogId/marketVariantId/cardedOrLoose/condition via an include on the listings fetch — never a second query', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    const tx = makeTx()
    mockTransaction(tx)
    await expect(createOrder(null, formData())).resolves.toEqual({ success: true, orderId: 'order1' })

    const call = (prisma.listing.findMany as Mock).mock.calls[0][0]
    expect(call.include).toEqual({
      item: { select: { catalogId: true, marketVariantId: true, cardedOrLoose: true, condition: true } },
    })
  })

  it('snapshots a null marketVariantId as-is (an unclassified ItemInstance is never coerced to a fabricated variant)', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ item: { catalogId: 'cat1', marketVariantId: null, cardedOrLoose: 'loose', condition: 'good' } }),
    ])
    const tx = makeTx()
    mockTransaction(tx)
    await expect(createOrder(null, formData())).resolves.toEqual({ success: true, orderId: 'order1' })

    const call = (tx.orderItem.create as Mock).mock.calls[0][0]
    expect(call.data.marketVariantId).toBeNull()
    expect(call.data.snapshotPackagingType).toBe('loose')
  })

  it('multiple cart items each snapshot their OWN item — never the first item\'s facts applied to all', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ id: 'listing1', itemId: 'item1', item: { catalogId: 'catA', marketVariantId: 'varA', cardedOrLoose: 'carded', condition: 'mint' } }),
      listingRow({ id: 'listing2', itemId: 'item2', item: { catalogId: 'catB', marketVariantId: 'varB', cardedOrLoose: 'loose', condition: 'fair' } }),
    ])
    const fd = new FormData()
    fd.append('listingIds', 'listing1')
    fd.append('listingIds', 'listing2')
    fd.set('buyerName', 'Jane Buyer')
    fd.set('buyerEmail', 'jane@example.com')
    const tx = makeTx()
    mockTransaction(tx)
    await expect(createOrder(null, fd)).resolves.toEqual({ success: true, orderId: 'order1' })

    const calls = (tx.orderItem.create as Mock).mock.calls
    expect(calls[0][0].data.catalogModelId).toBe('catA')
    expect(calls[0][0].data.snapshotCondition).toBe('mint')
    expect(calls[1][0].data.catalogModelId).toBe('catB')
    expect(calls[1][0].data.snapshotCondition).toBe('fair')
  })
})

describe('OrderItem.create — exactly one production call site (structural)', () => {
  it('orders.ts is the only file in src/lib that calls orderItem.create/createMany/upsert', () => {
    const projectRoot = process.cwd()
    const libDir = path.join(projectRoot, 'src/lib')

    function walk(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      return entries.flatMap((e) => {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) return walk(full)
        if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) return [full]
        return []
      })
    }

    const files = walk(libDir).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`))
    const matches = files.filter((f) => /orderItem\.(create|createMany|upsert)\(/.test(fs.readFileSync(f, 'utf-8')))
    expect(matches).toEqual([path.join(libDir, 'actions/orders.ts')])
  })

  it('the OrderItem.create payload includes all four 21B fields plus the 21C provenance literal (source inspection)', () => {
    const src = readSrc('src/lib/actions/orders.ts')
    const idx = src.indexOf('await tx.orderItem.create(')
    const block = src.slice(idx, src.indexOf('})', idx))
    expect(block).toContain('catalogModelId: listing.item.catalogId')
    expect(block).toContain('marketVariantId: listing.item.marketVariantId')
    expect(block).toContain('snapshotPackagingType: listing.item.cardedOrLoose')
    expect(block).toContain('snapshotCondition: listing.item.condition')
    expect(block).toContain("snapshotProvenance: 'sale_time'")
  })
})
