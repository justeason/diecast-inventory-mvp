// 26C: Sold/Removed history query — sourced exclusively from the 26B ledger
// (CollectionDisposal + allocations + CollectionItem identity), never from
// Order/SellerSubmission/CollectionItem.quantity directly.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { collectionDisposal: { findMany: vi.fn() } },
}))

import { prisma } from '@/lib/prisma'
import { getCollectionDisposalHistory } from '@/lib/collectionDisposalHistoryQuery'

function disposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'disp1',
    collectionItemId: 'ci1',
    disposalType: 'platform_sale',
    quantity: 1,
    disposedAt: new Date('2026-06-01'),
    reversedAt: null,
    reversalReason: null,
    notes: null,
    grossProceedsCents: 2500,
    netProceedsCents: 2000,
    collectionItem: { brand: null, name: null, catalogId: 'cat1', catalog: { brand: 'Hot Wheels', name: 'Skyline R34' } },
    allocations: [{ allocatedRecordedCostCents: 1500 }],
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('getCollectionDisposalHistory — scoping and ordering', () => {
  it('scopes by profileId via collectionItem relation', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([])
    await getCollectionDisposalHistory('p1')
    const call = (prisma.collectionDisposal.findMany as Mock).mock.calls[0][0]
    expect(call.where.collectionItem).toEqual({ profileId: 'p1' })
  })

  it('orders disposedAt DESC, id DESC — a stable tie-break', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([])
    await getCollectionDisposalHistory('p1')
    const call = (prisma.collectionDisposal.findMany as Mock).mock.calls[0][0]
    expect(call.orderBy).toEqual([{ disposedAt: 'desc' }, { id: 'desc' }])
  })

  it('does not filter out reversed disposals — history remains visible, never hidden', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal({ reversedAt: new Date('2026-06-05') })])
    const result = await getCollectionDisposalHistory('p1')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].reversedAt).toEqual(new Date('2026-06-05'))
  })
})

describe('getCollectionDisposalHistory — pagination (§74)', () => {
  it('takes PAGE_SIZE+1 and returns a composite nextCursor when more remain', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => disposal({ id: `d${i}`, disposedAt: new Date(2026, 5, 20 - i) }))
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue(rows)
    const result = await getCollectionDisposalHistory('p1')
    expect(result.rows).toHaveLength(20)
    expect(result.nextCursor).toEqual({ disposedAtMs: rows[19].disposedAt.getTime(), id: 'd19' })
  })

  it('nextCursor is null when the page is not full', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal()])
    const result = await getCollectionDisposalHistory('p1')
    expect(result.nextCursor).toBeNull()
  })

  it('a cursor builds a composite (disposedAt < X) OR (disposedAt = X AND id < Y) where clause', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([])
    await getCollectionDisposalHistory('p1', { disposedAtMs: 1750000000000, id: 'd19' })
    const call = (prisma.collectionDisposal.findMany as Mock).mock.calls[0][0]
    expect(call.where.OR).toEqual([
      { disposedAt: { lt: new Date(1750000000000) } },
      { disposedAt: new Date(1750000000000), id: { lt: 'd19' } },
    ])
  })
})

describe('getCollectionDisposalHistory — disposal type labels are resolved by the UI, row carries the raw type', () => {
  it('carries disposalType through unchanged for the UI label map', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal({ disposalType: 'gift' })])
    const result = await getCollectionDisposalHistory('p1')
    expect(result.rows[0].disposalType).toBe('gift')
  })
})

describe('getCollectionDisposalHistory — realized figures (§70/§73)', () => {
  it('a fully-covered platform_sale: gross, net, allocated cost, and realized gain/loss are all populated', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal()])
    const result = await getCollectionDisposalHistory('p1')
    const row = result.rows[0]
    expect(row.grossProceedsCents).toBe(2500)
    expect(row.netProceedsCents).toBe(2000)
    expect(row.allocatedRecordedCostCents).toBe(1500)
    expect(row.realizedGainLossCents).toBe(500)
    expect(row.realizedStatus).toBe('calculable')
  })

  it('an external_sale with net proceeds and known cost is realized-calculable, gross may be null', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      disposal({ disposalType: 'external_sale', grossProceedsCents: null, netProceedsCents: 1000, allocations: [{ allocatedRecordedCostCents: 700 }] }),
    ])
    const result = await getCollectionDisposalHistory('p1')
    const row = result.rows[0]
    expect(row.grossProceedsCents).toBeNull()
    expect(row.realizedGainLossCents).toBe(300)
    expect(row.realizedStatus).toBe('calculable')
  })

  it('unknown allocated cost -> realized unavailable, never a fake $0 cost', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal({ allocations: [{ allocatedRecordedCostCents: null }] })])
    const result = await getCollectionDisposalHistory('p1')
    const row = result.rows[0]
    expect(row.allocatedRecordedCostCents).toBeNull()
    expect(row.realizedGainLossCents).toBeNull()
    expect(row.realizedStatus).toBe('unavailable')
  })

  it('unknown net proceeds -> realized unavailable', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal({ netProceedsCents: null })])
    const result = await getCollectionDisposalHistory('p1')
    expect(result.rows[0].realizedStatus).toBe('unavailable')
  })

  it('gift/trade/other_removal/correction never carry proceeds or a realized figure — not_applicable, never a fake realized loss', async () => {
    for (const type of ['gift', 'trade', 'other_removal', 'correction']) {
      ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal({ disposalType: type, grossProceedsCents: null, netProceedsCents: null })])
      const result = await getCollectionDisposalHistory('p1')
      const row = result.rows[0]
      expect(row.realizedStatus).toBe('not_applicable')
      expect(row.realizedGainLossCents).toBeNull()
      expect(row.allocatedRecordedCostCents).toBeNull()
    }
  })
})

describe('getCollectionDisposalHistory — history uses the allocation SNAPSHOT, never current lot cost (§71)', () => {
  it('the query never touches acquisitionLot at all — only the disposal\'s own allocation snapshot', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal()])
    await getCollectionDisposalHistory('p1')
    const call = (prisma.collectionDisposal.findMany as Mock).mock.calls[0][0]
    expect(call.select.allocations).toEqual({ select: { allocatedRecordedCostCents: true } })
    expect(JSON.stringify(call.select)).not.toMatch(/unitRecordedCostCents/)
  })
})

describe('getCollectionDisposalHistory — display name and no N+1 (§47/§78)', () => {
  it('one query fetches disposal + collectionItem + allocations together (no separate per-row query)', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([disposal()])
    await getCollectionDisposalHistory('p1')
    expect(prisma.collectionDisposal.findMany).toHaveBeenCalledTimes(1)
  })

  it('prefers the catalog match name; falls back to brand/name for freeform items', async () => {
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      disposal({ collectionItem: { brand: 'Generic', name: 'Some Car', catalogId: null, catalog: null } }),
    ])
    const result = await getCollectionDisposalHistory('p1')
    expect(result.rows[0].displayName).toBe('Generic Some Car')
  })
})
