// 31B: proves the tx-injection design behaviorally, not just structurally —
// default (no client) calls use the global prisma client; an injected client
// is used for EVERY underlying query, with zero leak back to the global
// client. This is the hard correctness requirement behind auto-listing's
// SERIALIZABLE transaction snapshot (31B §8-§10/§67).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DbClient } from '@/lib/prisma'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    orderItem: { findMany: vi.fn() },
    externalMarketObservation: { findMany: vi.fn() },
    marketVariant: { findUnique: vi.fn() },
    listing: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getMarketSaleHistory } from '@/lib/marketSaleQuery'
import { getValuation } from '@/lib/marketValuation'
import { getInternalAskSummary } from '@/lib/marketAskQuery'
import { getPricingContext } from '@/lib/pricingContext'

function makeFakeTx() {
  return {
    orderItem: { findMany: vi.fn().mockResolvedValue([]) },
    externalMarketObservation: { findMany: vi.fn().mockResolvedValue([]) },
    marketVariant: { findUnique: vi.fn() },
    listing: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn(), findMany: vi.fn() },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
  ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
  ;(prisma.listing.count as Mock).mockResolvedValue(0)
})

describe('getMarketSaleHistory — tx injection', () => {
  it('default call (no client) uses the global prisma client', async () => {
    await getMarketSaleHistory({ catalogModelId: 'cat1' })
    expect(prisma.orderItem.findMany).toHaveBeenCalled()
    expect(prisma.externalMarketObservation.findMany).toHaveBeenCalled()
  })

  it('when a tx client is supplied, every query uses it — never the global prisma client', async () => {
    const tx = makeFakeTx()
    await getMarketSaleHistory({ catalogModelId: 'cat1' }, tx as unknown as DbClient)
    expect(tx.orderItem.findMany).toHaveBeenCalled()
    expect(tx.externalMarketObservation.findMany).toHaveBeenCalled()
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
  })
})

describe('getValuation — tx injection threads into EVERY underlying query, no mixed snapshot', () => {
  it('default call uses the global prisma client', async () => {
    await getValuation({ catalogModelId: 'cat1' })
    expect(prisma.orderItem.findMany).toHaveBeenCalled()
  })

  it('the marketVariantId validation lookup uses the injected tx, not global prisma', async () => {
    const tx = makeFakeTx()
    ;(tx.marketVariant.findUnique as Mock).mockResolvedValue({ catalogModelId: 'cat1' })
    await getValuation({ catalogModelId: 'cat1', marketVariantId: 'v1' }, tx as unknown as DbClient)
    expect(tx.marketVariant.findUnique).toHaveBeenCalled()
    expect(prisma.marketVariant.findUnique).not.toHaveBeenCalled()
  })

  it('the primary-window sale-history read uses the injected tx', async () => {
    const tx = makeFakeTx()
    await getValuation({ catalogModelId: 'cat1' }, tx as unknown as DbClient)
    expect(tx.orderItem.findMany).toHaveBeenCalled()
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
  })

  it('the extended-history fallback read (primary empty) ALSO uses the injected tx — no query silently falls back to global prisma', async () => {
    const tx = makeFakeTx()
    // primary + extended both resolve empty -> insufficient_data, but every read
    // along that path (2x getMarketSaleHistory: primary window + all-time extension)
    // must still go through tx, never prisma.
    const result = await getValuation({ catalogModelId: 'cat1' }, tx as unknown as DbClient)
    expect(result.status).toBe('insufficient_data')
    expect(tx.orderItem.findMany).toHaveBeenCalledTimes(2)
    expect(tx.externalMarketObservation.findMany).toHaveBeenCalledTimes(2)
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
  })
})

describe('getInternalAskSummary — tx injection', () => {
  it('default call uses the global prisma client', async () => {
    await getInternalAskSummary({ catalogModelId: 'cat1' })
    expect(prisma.listing.count).toHaveBeenCalled()
  })

  it('when a tx client is supplied, uses it — never the global prisma client', async () => {
    const tx = makeFakeTx()
    await getInternalAskSummary({ catalogModelId: 'cat1' }, tx as unknown as DbClient)
    expect(tx.listing.count).toHaveBeenCalled()
    expect(prisma.listing.count).not.toHaveBeenCalled()
  })

  it('non-zero availableCopies also routes the follow-up lowest/median reads through tx, never prisma', async () => {
    const tx = makeFakeTx()
    ;(tx.listing.count as Mock).mockResolvedValue(1)
    ;(tx.listing.findFirst as Mock).mockResolvedValue({ price: 10 })
    await getInternalAskSummary({ catalogModelId: 'cat1' }, tx as unknown as DbClient)
    expect(tx.listing.findFirst).toHaveBeenCalled()
    expect(prisma.listing.findFirst).not.toHaveBeenCalled()
  })
})

describe('getPricingContext — one coherent DB snapshot for the whole automation decision', () => {
  it('threads the SAME tx into both getValuation and getInternalAskSummary — never a mixed global/tx snapshot', async () => {
    const tx = makeFakeTx()
    await getPricingContext({ catalogModelId: 'cat1', asOf: new Date() }, tx as unknown as DbClient)
    expect(tx.orderItem.findMany).toHaveBeenCalled()
    expect(tx.listing.count).toHaveBeenCalled()
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
    expect(prisma.listing.count).not.toHaveBeenCalled()
  })

  it('default call (no client) uses the global prisma client for both', async () => {
    await getPricingContext({ catalogModelId: 'cat1', asOf: new Date() })
    expect(prisma.orderItem.findMany).toHaveBeenCalled()
    expect(prisma.listing.count).toHaveBeenCalled()
  })

  it('passes asOf straight through to valuation — no hidden new Date() read inside the composition', async () => {
    const asOf = new Date('2026-01-01T00:00:00Z')
    const context = await getPricingContext({ catalogModelId: 'cat1', asOf })
    expect(context.asOf).toBe(asOf)
    if (context.valuation.status !== 'input_error') {
      expect(context.valuation.asOf).toBe(asOf)
    }
  })
})
