// 26B §28: deleteCollectionItem's ledger-aware delete guard. Once any lot has
// ever been allocated (remainingQuantity !== quantityAcquired), or any
// disposal exists (even reversed — history is never erased), ordinary hard
// delete is blocked and the customer is redirected to use "Mark Sold /
// Removed" instead. A genuinely mistaken entry (no allocation/disposal
// history at all) may still be deleted, atomically with its lots.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => {
  const client: Record<string, unknown> = {
    collectionItem: { findFirst: vi.fn(), deleteMany: vi.fn() },
    acquisitionLot: { deleteMany: vi.fn() },
  }
  client.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(client))
  return { prisma: client }
})
vi.mock('@vercel/blob', () => ({ del: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { deleteCollectionItem } from '@/lib/actions/collectionItems'

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    isPublic: false,
    photos: [],
    acquisitionLots: [{ id: 'lot1', quantityAcquired: 1, remainingQuantity: 1 }],
    disposals: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.$transaction as Mock).mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma))
  ;(prisma.collectionItem.deleteMany as Mock).mockResolvedValue({ count: 1 })
  ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
})

describe('deleteCollectionItem — ledger-history guard', () => {
  it('a lot that was never allocated (remainingQuantity === quantityAcquired) and no disposals -> delete proceeds', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(itemRow())
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT:/account/collection')
    expect(prisma.acquisitionLot.deleteMany).toHaveBeenCalledWith({ where: { collectionItemId: 'ci1' } })
    expect(prisma.collectionItem.deleteMany).toHaveBeenCalledWith({ where: { id: 'ci1', profileId: 'p1' } })
  })

  it('a partially-allocated lot (remainingQuantity < quantityAcquired) blocks delete — redirects with deleteBlocked=1', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(
      itemRow({ acquisitionLots: [{ id: 'lot1', quantityAcquired: 5, remainingQuantity: 3 }] }),
    )
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1?deleteBlocked=1')
    expect(prisma.acquisitionLot.deleteMany).not.toHaveBeenCalled()
    expect(prisma.collectionItem.deleteMany).not.toHaveBeenCalled()
  })

  it('a fully-allocated lot (remainingQuantity 0) blocks delete', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(
      itemRow({ acquisitionLots: [{ id: 'lot1', quantityAcquired: 2, remainingQuantity: 0 }] }),
    )
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1?deleteBlocked=1')
    expect(prisma.collectionItem.deleteMany).not.toHaveBeenCalled()
  })

  it('any disposal at all (even with all lots untouched — e.g. a correction scenario) blocks delete', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(
      itemRow({ disposals: [{ id: 'disp1' }] }),
    )
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1?deleteBlocked=1')
    expect(prisma.collectionItem.deleteMany).not.toHaveBeenCalled()
  })

  it('a REVERSED disposal still blocks delete — reversal never erases the historical fact', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(
      itemRow({ disposals: [{ id: 'disp1' }] }), // the select only returns { id }, reversedAt is irrelevant to this guard — presence alone blocks
    )
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1?deleteBlocked=1')
  })

  it('multiple lots where only one was ever allocated still blocks delete (any allocated lot is enough)', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(
      itemRow({
        acquisitionLots: [
          { id: 'lot1', quantityAcquired: 1, remainingQuantity: 1 },
          { id: 'lot2', quantityAcquired: 2, remainingQuantity: 1 },
        ],
      }),
    )
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1?deleteBlocked=1')
  })

  it('a mistaken entry with multiple never-allocated lots (e.g. two "Add Another" calls, neither ever disposed) is still deletable', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(
      itemRow({
        acquisitionLots: [
          { id: 'lot1', quantityAcquired: 1, remainingQuantity: 1 },
          { id: 'lot2', quantityAcquired: 2, remainingQuantity: 2 },
        ],
      }),
    )
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT:/account/collection')
    expect(prisma.acquisitionLot.deleteMany).toHaveBeenCalled()
    expect(prisma.collectionItem.deleteMany).toHaveBeenCalled()
  })

  it('deletion of lots and the CollectionItem happens inside the same transaction, lots removed first', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(itemRow())
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT')
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('an item belonging to another profile is never found — no info leak about its ledger state', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    await expect(deleteCollectionItem('not-mine')).rejects.toThrow('NEXT_REDIRECT:/account/collection')
    expect(prisma.acquisitionLot.deleteMany).not.toHaveBeenCalled()
  })

  it('no session redirects immediately, never queries the ledger', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    await expect(deleteCollectionItem('ci1')).rejects.toThrow('NEXT_REDIRECT')
    expect(prisma.collectionItem.findFirst).not.toHaveBeenCalled()
  })
})
