// 15K (execution-snapshot pass, Part 1): proves getCatalogValuations threads a
// caller-supplied client through to EVERY underlying read (CatalogModel,
// OrderItem comparable sales, Listing active asks) — not just some of them. A
// caller holding an open transaction (auto-listing execution) must never have one
// of these three reads silently fall back to the disconnected global client.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findMany: vi.fn() },
    orderItem: { findMany: vi.fn() },
    listing: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getCatalogValuations } from '@/lib/advancedValuationQuery'

const ASOF = new Date('2026-08-01T00:00:00.000Z')

function fakeClient() {
  return {
    catalogModel: { findMany: vi.fn().mockResolvedValue([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }]) },
    orderItem: { findMany: vi.fn().mockResolvedValue([]) },
    listing: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

beforeEach(() => vi.resetAllMocks())

describe('getCatalogValuations — client threading', () => {
  it('defaults to the global prisma client for all three reads when none is supplied', async () => {
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'cat1', brand: 'H', name: 'M', series: null, year: null }])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.listing.findMany as Mock).mockResolvedValueOnce([])

    await getCatalogValuations(['cat1'], ASOF)

    expect(prisma.catalogModel.findMany).toHaveBeenCalled()
    expect(prisma.orderItem.findMany).toHaveBeenCalled()
    expect(prisma.listing.findMany).toHaveBeenCalled()
  })

  it('a supplied client is used for CatalogModel metadata, comparable sales (OrderItem), AND active asks (Listing) — none silently fall back to the global client', async () => {
    const tx = fakeClient()
    await getCatalogValuations(['cat1'], ASOF, tx as never)

    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
    expect(prisma.listing.findMany).not.toHaveBeenCalled()

    expect(tx.catalogModel.findMany).toHaveBeenCalledTimes(1)
    expect(tx.listing.findMany).toHaveBeenCalledTimes(1)
    // orderItem.findMany is only reached once a target with a catalog match exists;
    // fetchComparableSalesBatch queries per target chunk (1 chunk here).
    expect(tx.orderItem.findMany).toHaveBeenCalledTimes(1)
  })
})
