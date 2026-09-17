// 26B: createCollectionItem's founding-AcquisitionLot wiring — manual create
// with a purchase price (known cost), manual create with no price (unknown
// cost), "I Own It" source detection, and freeform (catalogId=null) items
// remaining fully ledger-supported. Complements collectionItemConcurrency.test.ts,
// which covers the race/duplicate-detection side of the same action.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => {
  const client: Record<string, unknown> = {
    catalogModel: { findUnique: vi.fn() },
    collectionItem: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    acquisitionLot: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
  }
  client.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(client))
  return { prisma: client }
})
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { createCollectionItem } from '@/lib/actions/collectionItems'

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.$transaction as Mock).mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma))
  ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
  ;(prisma.acquisitionLot.create as Mock).mockResolvedValue({ id: 'lot1' })
  ;(prisma.collectionItem.update as Mock).mockResolvedValue({ id: 'updated' })
  ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
})

describe('createCollectionItem — manual create with a purchase price creates a KNOWN-cost founding lot', () => {
  it('a valid per-item purchase price produces unitRecordedCostCents in cents, costKnowledge known', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(
      createCollectionItem(null, fd({ catalogId: 'cat1', quantity: '3', purchasePrice: '12.50' })),
    ).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.unitRecordedCostCents).toBe(1250)
    expect(lotCall.data.costKnowledge).toBe('known')
    expect(lotCall.data.quantityAcquired).toBe(3)
  })

  it('quantity>1 with a price is still treated as a per-item cost (NEW 26B unit-cost lots stay usable, unlike legacy ambiguous rows)', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(
      createCollectionItem(null, fd({ catalogId: 'cat1', quantity: '4', purchasePrice: '10.00' })),
    ).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.unitRecordedCostCents).toBe(1000)
    expect(lotCall.data.costKnowledge).toBe('known')
  })

  it('no purchase price -> unitRecordedCostCents null, costKnowledge unknown, never invented', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(
      createCollectionItem(null, fd({ catalogId: 'cat1', quantity: '1' })),
    ).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.unitRecordedCostCents).toBeNull()
    expect(lotCall.data.costKnowledge).toBe('unknown')
  })
})

describe('createCollectionItem — acquisition source detection', () => {
  it('formData.source=i_own_it (set by addToCollectionAction) -> founding lot source i_own_it', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(
      createCollectionItem(null, fd({ catalogId: 'cat1', source: 'i_own_it' })),
    ).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.source).toBe('i_own_it')
  })

  it('no source in formData (the general manual "Add Item" form) -> founding lot source manual', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(
      createCollectionItem(null, fd({ catalogId: 'cat1' })),
    ).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.source).toBe('manual')
  })

  it('an unrecognized/arbitrary source value never leaks through as-is — only i_own_it is special-cased, everything else falls back to manual', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(
      createCollectionItem(null, fd({ catalogId: 'cat1', source: 'something_else' })),
    ).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.source).toBe('manual')
  })
})

describe('createCollectionItem — freeform items (catalogId=null) remain fully ledger-supported', () => {
  it('a freeform item still gets a founding AcquisitionLot in the same transaction, scoped by CollectionItem identity (no catalogId dependency)', async () => {
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'freeform-1' })
    const f = fd({ brand: 'Generic Brand', name: 'Some Car', quantity: '2', purchasePrice: '5.00' })
    await expect(createCollectionItem(null, f)).rejects.toThrow()
    expect(prisma.catalogModel.findUnique).not.toHaveBeenCalled()
    const createCall = (prisma.collectionItem.create as Mock).mock.calls[0][0]
    expect(createCall.data.catalogId).toBeUndefined()
    expect(createCall.data.quantity).toBe(0)
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.collectionItemId).toBe('freeform-1')
    expect(lotCall.data.quantityAcquired).toBe(2)
    expect(lotCall.data.unitRecordedCostCents).toBe(500)
  })
})

describe('createCollectionItem — atomicity of CollectionItem + founding lot', () => {
  it('both writes happen inside the same prisma.$transaction call', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(createCollectionItem(null, fd({ catalogId: 'cat1' }))).rejects.toThrow()
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('acquiredAt on the founding lot comes from the submitted purchaseDate verbatim, never fabricated', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(
      createCollectionItem(null, fd({ catalogId: 'cat1', purchaseDate: '2025-03-01' })),
    ).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.acquiredAt).toEqual(new Date('2025-03-01'))
  })

  it('no purchaseDate submitted -> acquiredAt null, never defaulted to today', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })
    await expect(createCollectionItem(null, fd({ catalogId: 'cat1' }))).rejects.toThrow()
    const lotCall = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(lotCall.data.acquiredAt).toBeNull()
  })
})
