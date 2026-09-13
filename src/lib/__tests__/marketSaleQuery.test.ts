// 22B: canonical market-SALE evidence layer. Pure-mapper tests (no DB) plus
// mocked-prisma behavioral tests for the query-orchestration functions,
// matching this codebase's established convention (see advancedValuationQuery.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    orderItem: { findMany: vi.fn(), count: vi.fn() },
    externalMarketObservation: { findMany: vi.fn(), count: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import {
  toInternalMarketSale,
  toExternalMarketSale,
  compareMarketSaleObservations,
  getMarketSaleHistory,
  getLatestSale,
  getSaleCount,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  type InternalSaleCandidateRow,
  type ExternalSaleCandidateRow,
  type MarketSaleObservation,
} from '@/lib/marketSaleQuery'

function internalRow(overrides: Partial<InternalSaleCandidateRow> = {}): InternalSaleCandidateRow {
  return {
    id: 'oi1',
    price: 19.99,
    catalogModelId: 'cat1',
    marketVariantId: 'v1',
    snapshotPackagingType: 'carded',
    snapshotCondition: 'mint',
    snapshotProvenance: 'sale_time',
    order: { status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-01-01T00:00:00Z') },
    ...overrides,
  }
}

function externalRow(overrides: Partial<ExternalSaleCandidateRow> = {}): ExternalSaleCandidateRow {
  return {
    id: 'obs1',
    provider: 'ebay',
    matchStatus: 'matched',
    matchMethod: 'manual',
    catalogModelId: 'cat1',
    marketVariantId: null,
    marketVariant: null,
    observationType: 'sold',
    soldAt: new Date('2026-01-01T00:00:00Z'),
    currency: 'USD',
    price: new Prisma.Decimal('25.00'),
    ...overrides,
  }
}

// ── §55: internal eligibility — the critical 22B correction over the legacy predicate ──

describe('toInternalMarketSale — internal sale eligibility (§55)', () => {
  it('complete + paid + completedAt + price>0 -> included', () => {
    expect(toInternalMarketSale(internalRow())).not.toBeNull()
  })

  it('complete + UNPAID -> excluded', () => {
    expect(toInternalMarketSale(internalRow({ order: { status: 'complete', paymentStatus: 'unpaid', completedAt: new Date() } }))).toBeNull()
  })

  it('complete + requested -> excluded', () => {
    expect(toInternalMarketSale(internalRow({ order: { status: 'complete', paymentStatus: 'requested', completedAt: new Date() } }))).toBeNull()
  })

  it('paid but not complete -> excluded', () => {
    expect(toInternalMarketSale(internalRow({ order: { status: 'paid', paymentStatus: 'paid', completedAt: null } }))).toBeNull()
  })

  it('complete with completedAt null -> excluded', () => {
    expect(toInternalMarketSale(internalRow({ order: { status: 'complete', paymentStatus: 'paid', completedAt: null } }))).toBeNull()
  })

  it('complete paid price=0 -> excluded', () => {
    expect(toInternalMarketSale(internalRow({ price: 0 }))).toBeNull()
  })

  it('cancelled paid -> excluded', () => {
    expect(toInternalMarketSale(internalRow({ order: { status: 'cancelled', paymentStatus: 'paid', completedAt: new Date() } }))).toBeNull()
  })

  it('ItemInstance.status is never consulted — this module has no such input at all, so a "still sold after cancelled" scenario cannot leak in', () => {
    const row = internalRow({ order: { status: 'cancelled', paymentStatus: 'paid', completedAt: new Date() } })
    expect(Object.keys(row)).not.toContain('itemStatus')
    expect(toInternalMarketSale(row)).toBeNull()
  })
})

// ── §56: internal provenance ──

describe('toInternalMarketSale — provenance (§56)', () => {
  it('sale_time row is fully eligible (model/variant/condition all resolvable)', () => {
    const sale = toInternalMarketSale(internalRow({ snapshotProvenance: 'sale_time' }))!
    expect(sale.snapshotProvenance).toBe('sale_time')
    expect(sale.marketVariantId).toBe('v1')
    expect(sale.condition).toBe('mint')
  })

  it('intake_declared is included by default with provenance preserved', () => {
    const sale = toInternalMarketSale(internalRow({ snapshotProvenance: 'intake_declared' }))!
    expect(sale.snapshotProvenance).toBe('intake_declared')
  })

  it('legacy_model_only is included at model level with null variant/condition', () => {
    const sale = toInternalMarketSale(internalRow({
      snapshotProvenance: 'legacy_model_only', marketVariantId: null, snapshotPackagingType: null, snapshotCondition: null,
    }))!
    expect(sale.snapshotProvenance).toBe('legacy_model_only')
    expect(sale.marketVariantId).toBeNull()
    expect(sale.packagingType).toBeNull()
    expect(sale.condition).toBeNull()
  })

  it('never derives packaging/condition from current ItemInstance — the input type has no such field', () => {
    const row = internalRow()
    expect(Object.keys(row)).not.toContain('item')
    expect(Object.keys(row)).not.toContain('cardedOrLoose')
  })

  it('an invalid/null snapshotProvenance is excluded entirely (not yet normalized, never guessed)', () => {
    expect(toInternalMarketSale(internalRow({ snapshotProvenance: null }))).toBeNull()
  })
})

// ── §57: external sale eligibility ──

describe('toExternalMarketSale — external sale eligibility (§57)', () => {
  it('matched sold USD + soldAt + price>0 -> included', () => {
    expect(toExternalMarketSale(externalRow())).not.toBeNull()
  })

  it('unmatched -> excluded', () => {
    expect(toExternalMarketSale(externalRow({ matchStatus: 'unmatched', catalogModelId: null }))).toBeNull()
  })

  it('rejected -> excluded', () => {
    expect(toExternalMarketSale(externalRow({ matchStatus: 'rejected' }))).toBeNull()
  })

  it('active_ask -> excluded from sale history', () => {
    expect(toExternalMarketSale(externalRow({ observationType: 'active_ask' }))).toBeNull()
  })

  it('sold without soldAt -> excluded', () => {
    expect(toExternalMarketSale(externalRow({ soldAt: null }))).toBeNull()
  })

  it('non-USD -> excluded', () => {
    expect(toExternalMarketSale(externalRow({ currency: 'GBP' }))).toBeNull()
  })

  it('price <= 0 -> excluded', () => {
    expect(toExternalMarketSale(externalRow({ price: new Prisma.Decimal('0') }))).toBeNull()
    expect(toExternalMarketSale(externalRow({ price: new Prisma.Decimal('-5') }))).toBeNull()
  })

  it('21D malformed cross-model identity (variant belongs to a different model) -> excluded', () => {
    const row = externalRow({
      catalogModelId: 'catA',
      marketVariantId: 'v1',
      marketVariant: { id: 'v1', catalogModelId: 'catB', packagingType: 'carded' },
    })
    expect(toExternalMarketSale(row)).toBeNull()
  })
})

// ── §58: shipping — the key apples-to-apples test ──

describe('shipping price is never included (§58)', () => {
  it('external price=10, shipping=5 (irrelevant, not even read) -> priceCents = 1000, not 1500', () => {
    const sale = toExternalMarketSale(externalRow({ price: new Prisma.Decimal('10.00') }))!
    expect(sale.priceCents).toBe(1000)
  })

  it('internal $10 comparable also normalizes to 1000 cents — apples to apples', () => {
    const sale = toInternalMarketSale(internalRow({ price: 10 }))!
    expect(sale.priceCents).toBe(1000)
  })

  it('the external row type has no totalPrice/shippingPrice field the mapper could read', () => {
    const row = externalRow()
    expect(Object.keys(row)).not.toContain('totalPrice')
    expect(Object.keys(row)).not.toContain('shippingPrice')
  })
})

// ── §60/§61/§62: model / variant / condition filter semantics (pure-mapper proof) ──

describe('model scope (§60) — unknown/known variant both included, cross-model excluded', () => {
  it('same catalogModelId included regardless of variant knowledge', () => {
    expect(toInternalMarketSale(internalRow({ marketVariantId: null, snapshotPackagingType: null }))?.catalogModelId).toBe('cat1')
    expect(toInternalMarketSale(internalRow({ marketVariantId: 'v1' }))?.catalogModelId).toBe('cat1')
  })
})

describe('variant scope (§61) — exact match only, never null==null', () => {
  it('Carded internal included when variant matches', () => {
    const sale = toInternalMarketSale(internalRow({ marketVariantId: 'carded-v', snapshotPackagingType: 'carded' }))!
    expect(sale.marketVariantId).toBe('carded-v')
    expect(sale.packagingType).toBe('carded')
  })
  it('Carded external included when variant matches', () => {
    const sale = toExternalMarketSale(externalRow({
      marketVariantId: 'carded-v', marketVariant: { id: 'carded-v', catalogModelId: 'cat1', packagingType: 'carded' },
    }))!
    expect(sale.packagingType).toBe('carded')
  })
  it('a null-variant internal sale never satisfies a variant filter (a caller filtering by marketVariantId will never see this row from the DB WHERE, and the mapper itself keeps it null, never coerced)', () => {
    const sale = toInternalMarketSale(internalRow({ marketVariantId: null, snapshotPackagingType: null }))!
    expect(sale.marketVariantId).toBeNull()
  })
  it('legacy_model_only never carries a variant', () => {
    const sale = toInternalMarketSale(internalRow({ snapshotProvenance: 'legacy_model_only', marketVariantId: null, snapshotPackagingType: null }))!
    expect(sale.marketVariantId).toBeNull()
  })
})

describe('condition scope (§62)', () => {
  it('internal near_mint included', () => {
    expect(toInternalMarketSale(internalRow({ snapshotCondition: 'near_mint' }))?.condition).toBe('near_mint')
  })
  it('internal condition null excluded from a condition-filtered read (mapper keeps it null; caller filters)', () => {
    expect(toInternalMarketSale(internalRow({ snapshotCondition: null }))?.condition).toBeNull()
  })
  it('external condition is ALWAYS null — raw condition text is never surfaced as a comparable grade', () => {
    const sale = toExternalMarketSale(externalRow())!
    expect(sale.condition).toBeNull()
  })
  it('external row type carries no raw "condition" field the mapper could read', () => {
    expect(Object.keys(externalRow())).not.toContain('condition')
  })
})

// ── §65: ordering ──

describe('compareMarketSaleObservations — deterministic sort (§65)', () => {
  function sale(overrides: Partial<MarketSaleObservation>): MarketSaleObservation {
    return {
      observationId: 'internal:x', sourceType: 'internal', sourceRecordId: 'x', catalogModelId: 'cat1',
      marketVariantId: null, packagingType: null, condition: null, snapshotProvenance: 'sale_time',
      priceCents: 1000, currency: 'USD', soldAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    } as MarketSaleObservation
  }

  it('sorts by soldAt descending', () => {
    const older = sale({ soldAt: new Date('2026-01-01T00:00:00Z'), sourceRecordId: 'a' })
    const newer = sale({ soldAt: new Date('2026-02-01T00:00:00Z'), sourceRecordId: 'b' })
    expect([older, newer].sort(compareMarketSaleObservations)).toEqual([newer, older])
  })

  it('same soldAt: sourceType tie-break, external before internal (plain ascending string compare)', () => {
    const t = new Date('2026-01-01T00:00:00Z')
    const internal = sale({ soldAt: t, sourceType: 'internal', sourceRecordId: 'z' })
    const external = { ...sale({ soldAt: t, sourceRecordId: 'a' }), sourceType: 'external' } as MarketSaleObservation
    expect([internal, external].sort(compareMarketSaleObservations)).toEqual([external, internal])
  })

  it('same soldAt and sourceType: sourceRecordId ascending tie-break', () => {
    const t = new Date('2026-01-01T00:00:00Z')
    const b = sale({ soldAt: t, sourceRecordId: 'b' })
    const a = sale({ soldAt: t, sourceRecordId: 'a' })
    expect([b, a].sort(compareMarketSaleObservations)).toEqual([a, b])
  })

  it('sort is stable/repeatable across repeated calls', () => {
    const t = new Date('2026-01-01T00:00:00Z')
    const rows = [sale({ soldAt: t, sourceRecordId: 'c' }), sale({ soldAt: t, sourceRecordId: 'a' }), sale({ soldAt: t, sourceRecordId: 'b' })]
    const first = [...rows].sort(compareMarketSaleObservations)
    const second = [...rows].sort(compareMarketSaleObservations)
    expect(first).toEqual(second)
    expect(first.map((r) => r.sourceRecordId)).toEqual(['a', 'b', 'c'])
  })
})

// ── Query-orchestration behavioral tests (mocked prisma) ──

beforeEach(() => vi.resetAllMocks())

describe('getMarketSaleHistory — bounding, interleaving, source filters (§64/§65/§66/§63)', () => {
  it('merges interleaved internal/external rows into one soldAt-desc sequence', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([
      internalRow({ id: 'oi-old', order: { status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-01-01T00:00:00Z') } }),
    ])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([
      externalRow({ id: 'obs-new', soldAt: new Date('2026-02-01T00:00:00Z') }),
    ])

    const { observations } = await getMarketSaleHistory({ catalogModelId: 'cat1' })
    expect(observations.map((o) => o.sourceRecordId)).toEqual(['obs-new', 'oi-old'])
  })

  it('enforces the hard max limit', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getMarketSaleHistory({ catalogModelId: 'cat1', limit: 999999 })
    const call = (prisma.orderItem.findMany as Mock).mock.calls[0][0]
    expect(call.take).toBeLessThanOrEqual(MAX_HISTORY_LIMIT + 1)
  })

  it('defaults to DEFAULT_HISTORY_LIMIT when no limit supplied', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getMarketSaleHistory({ catalogModelId: 'cat1' })
    expect((prisma.orderItem.findMany as Mock).mock.calls[0][0].take).toBe(DEFAULT_HISTORY_LIMIT + 1)
  })

  it('sources:["internal"] never queries external', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    await getMarketSaleHistory({ catalogModelId: 'cat1', sources: ['internal'] })
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
  })

  it('sources:["external"] never queries internal', async () => {
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getMarketSaleHistory({ catalogModelId: 'cat1', sources: ['external'] })
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
  })

  it('a condition filter skips the external query entirely (external can never satisfy it)', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    await getMarketSaleHistory({ catalogModelId: 'cat1', condition: 'mint' })
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
  })

  it('hasMore is true when more candidates exist than the requested limit', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => internalRow({ id: `oi${i}` }))
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue(rows)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    const result = await getMarketSaleHistory({ catalogModelId: 'cat1', limit: 2 })
    expect(result.observations).toHaveLength(2)
    expect(result.hasMore).toBe(true)
  })

  it('hasMore is false when exactly limit or fewer candidates exist', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([internalRow()])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    const result = await getMarketSaleHistory({ catalogModelId: 'cat1', limit: 5 })
    expect(result.hasMore).toBe(false)
  })
})

describe('date boundary semantics (§64) — inclusive start, exclusive end, soldAt/completedAt only', () => {
  it('internal WHERE uses order.completedAt gte startDate / lt endDate', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    const start = new Date('2026-01-01T00:00:00Z')
    const end = new Date('2026-02-01T00:00:00Z')
    await getMarketSaleHistory({ catalogModelId: 'cat1', startDate: start, endDate: end })
    const where = (prisma.orderItem.findMany as Mock).mock.calls[0][0].where
    expect(where.order.completedAt.gte).toEqual(start)
    expect(where.order.completedAt.lt).toEqual(end)
  })

  it('external WHERE uses soldAt gte/lt, never observedAt', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    const start = new Date('2026-01-01T00:00:00Z')
    const end = new Date('2026-02-01T00:00:00Z')
    await getMarketSaleHistory({ catalogModelId: 'cat1', startDate: start, endDate: end })
    const where = (prisma.externalMarketObservation.findMany as Mock).mock.calls[0][0].where
    expect(where.soldAt.gte).toEqual(start)
    expect(where.soldAt.lt).toEqual(end)
    expect(where).not.toHaveProperty('observedAt')
  })
})

describe('getLatestSale (§67)', () => {
  it('returns the newer internal sale when internal is newer', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([internalRow({ id: 'oi-new', order: { status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-06-01T00:00:00Z') } })])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([externalRow({ id: 'obs-old', soldAt: new Date('2026-01-01T00:00:00Z') })])
    const result = await getLatestSale({ catalogModelId: 'cat1' })
    expect(result?.sourceRecordId).toBe('oi-new')
  })

  it('returns the newer external sale when external is newer', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([internalRow({ id: 'oi-old', order: { status: 'complete', paymentStatus: 'paid', completedAt: new Date('2026-01-01T00:00:00Z') } })])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([externalRow({ id: 'obs-new', soldAt: new Date('2026-06-01T00:00:00Z') })])
    const result = await getLatestSale({ catalogModelId: 'cat1' })
    expect(result?.sourceRecordId).toBe('obs-new')
  })

  it('sources:["internal"] gives "Last CollectNTrades Sale" via the same canonical function', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([internalRow({ id: 'oi1' })])
    const result = await getLatestSale({ catalogModelId: 'cat1', sources: ['internal'] })
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
    expect(result?.sourceType).toBe('internal')
  })

  it('sources:["external"] isolates external', async () => {
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([externalRow()])
    const result = await getLatestSale({ catalogModelId: 'cat1', sources: ['external'] })
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
    expect(result?.sourceType).toBe('external')
  })

  it('returns null when no eligible sale exists', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    expect(await getLatestSale({ catalogModelId: 'cat1' })).toBeNull()
  })
})

describe('getSaleCount (§68)', () => {
  it('returns total/internal/external split', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(3)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([externalRow({ id: 'a' }), externalRow({ id: 'b' })])
    const result = await getSaleCount({ catalogModelId: 'cat1' })
    expect(result).toEqual({ total: 5, internal: 3, external: 2 })
  })

  it('model count uses catalogModelId only in internal WHERE (no variant/condition constraint)', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getSaleCount({ catalogModelId: 'cat1' })
    const where = (prisma.orderItem.count as Mock).mock.calls[0][0].where
    expect(where.catalogModelId).toBe('cat1')
    expect(where).not.toHaveProperty('marketVariantId')
    expect(where).not.toHaveProperty('snapshotCondition')
  })

  it('variant-exact count filters by marketVariantId', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    await getSaleCount({ catalogModelId: 'cat1', marketVariantId: 'v1', sources: ['internal'] })
    expect((prisma.orderItem.count as Mock).mock.calls[0][0].where.marketVariantId).toBe('v1')
  })

  it('condition-exact count filters by snapshotCondition and skips external', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    await getSaleCount({ catalogModelId: 'cat1', condition: 'mint' })
    expect((prisma.orderItem.count as Mock).mock.calls[0][0].where.snapshotCondition).toBe('mint')
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
  })

  it('date-window count applies to both sources', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    const start = new Date('2026-01-01T00:00:00Z')
    await getSaleCount({ catalogModelId: 'cat1', startDate: start })
    expect((prisma.orderItem.count as Mock).mock.calls[0][0].where.order.completedAt.gte).toEqual(start)
    expect((prisma.externalMarketObservation.findMany as Mock).mock.calls[0][0].where.soldAt.gte).toEqual(start)
  })

  it('non-USD external is excluded by the WHERE clause itself', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getSaleCount({ catalogModelId: 'cat1' })
    expect((prisma.externalMarketObservation.findMany as Mock).mock.calls[0][0].where.currency).toBe('USD')
  })

  it('internal count requires paymentStatus=paid — an unpaid-completed order is excluded', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    await getSaleCount({ catalogModelId: 'cat1', sources: ['internal'] })
    const where = (prisma.orderItem.count as Mock).mock.calls[0][0].where
    expect(where.order.paymentStatus).toBe('paid')
    expect(where.order.status).toBe('complete')
  })

  it('external count is bounded/batched via keyset pagination on id asc — not a single unbounded findMany', async () => {
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getSaleCount({ catalogModelId: 'cat1', sources: ['external'] })
    const call = (prisma.externalMarketObservation.findMany as Mock).mock.calls[0][0]
    expect(call.orderBy).toEqual({ id: 'asc' })
    expect(typeof call.take).toBe('number')
  })

  it('external count issues a second page only when the first page is full', async () => {
    const fullPage = Array.from({ length: 500 }, (_, i) => externalRow({ id: `o${i}` }))
    ;(prisma.externalMarketObservation.findMany as Mock)
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([externalRow({ id: 'last' })])
    const result = await getSaleCount({ catalogModelId: 'cat1', sources: ['external'] })
    expect(prisma.externalMarketObservation.findMany).toHaveBeenCalledTimes(2)
    expect(result.external).toBe(501)
    const secondCall = (prisma.externalMarketObservation.findMany as Mock).mock.calls[1][0]
    expect(secondCall.cursor).toEqual({ id: 'o499' })
    expect(secondCall.skip).toBe(1)
  })
})

// ── §4: 22B follow-up — getSaleCount / getMarketSaleHistory semantic parity ──

describe('getSaleCount / getMarketSaleHistory parity (22B follow-up §4)', () => {
  it('A. malformed cross-model external variant: excluded from BOTH history and count', async () => {
    const malformed = externalRow({
      id: 'bad', catalogModelId: 'catA', marketVariantId: 'v1',
      marketVariant: { id: 'v1', catalogModelId: 'catB', packagingType: 'carded' },
    })
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([malformed])

    const { observations } = await getMarketSaleHistory({ catalogModelId: 'catA', sources: ['external'] })
    expect(observations).toHaveLength(0)

    const count = await getSaleCount({ catalogModelId: 'catA', sources: ['external'] })
    expect(count.external).toBe(0)
  })

  it('B. an otherwise economically-valid external row rejected by 21D (missing joined MarketVariant): excluded from BOTH', async () => {
    const malformed = externalRow({ id: 'bad2', marketVariantId: 'v1', marketVariant: null })
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([malformed])

    const { observations } = await getMarketSaleHistory({ catalogModelId: 'cat1', sources: ['external'] })
    expect(observations).toHaveLength(0)

    const count = await getSaleCount({ catalogModelId: 'cat1', sources: ['external'] })
    expect(count.external).toBe(0)
  })

  it('C. unpaid complete internal: excluded from BOTH history and count', async () => {
    const row = internalRow({ order: { status: 'complete', paymentStatus: 'unpaid', completedAt: new Date() } })
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([row])
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0) // WHERE-level paymentStatus:'paid' excludes it in a real DB

    const { observations } = await getMarketSaleHistory({ catalogModelId: 'cat1', sources: ['internal'] })
    expect(observations).toHaveLength(0)

    const count = await getSaleCount({ catalogModelId: 'cat1', sources: ['internal'] })
    expect(count.internal).toBe(0)
  })

  it('D. internal row with null/invalid snapshotProvenance: WHERE now requires membership in the valid closed set for BOTH history and count (structural parity by construction — same buildInternalWhere)', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)

    await getMarketSaleHistory({ catalogModelId: 'cat1', sources: ['internal'] })
    const historyWhere = (prisma.orderItem.findMany as Mock).mock.calls[0][0].where

    await getSaleCount({ catalogModelId: 'cat1', sources: ['internal'] })
    const countWhere = (prisma.orderItem.count as Mock).mock.calls[0][0].where

    expect(historyWhere.snapshotProvenance).toEqual({ in: ['sale_time', 'intake_declared', 'legacy_model_only'] })
    expect(countWhere.snapshotProvenance).toEqual(historyWhere.snapshotProvenance)
  })

  it('E. total always equals internal + external', async () => {
    ;(prisma.orderItem.count as Mock).mockResolvedValue(7)
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([externalRow({ id: 'a' }), externalRow({ id: 'b' }), externalRow({ id: 'c' })])
    const result = await getSaleCount({ catalogModelId: 'cat1' })
    expect(result.total).toBe(result.internal + result.external)
    expect(result).toEqual({ total: 10, internal: 7, external: 3 })
  })

  it('F. representative filter case: count matches the number of eligible rows an unbounded history fetch would return for the same fixture', async () => {
    const fixture = [
      externalRow({ id: 'good1' }),
      externalRow({ id: 'good2', marketVariantId: 'v1', marketVariant: { id: 'v1', catalogModelId: 'cat1', packagingType: 'carded' } }),
      externalRow({ id: 'bad-cross-model', marketVariantId: 'v2', marketVariant: { id: 'v2', catalogModelId: 'OTHER', packagingType: 'carded' } }),
      externalRow({ id: 'bad-unmatched', matchStatus: 'unmatched', catalogModelId: null }),
      externalRow({ id: 'bad-nonusd', currency: 'EUR' }),
    ]
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue(fixture)
    const eligibleFromHistoryLogic = fixture.filter((r) => toExternalMarketSale(r) !== null).length
    expect(eligibleFromHistoryLogic).toBe(2) // good1, good2 only

    const count = await getSaleCount({ catalogModelId: 'cat1', sources: ['external'] })
    expect(count.external).toBe(eligibleFromHistoryLogic)
  })
})

// ── §72: no raw dependencies ──

describe('no raw dependencies (§72)', () => {
  it('the internal candidate row type has no rawSnapshot/title/current-item field', () => {
    expect(Object.keys(internalRow())).not.toContain('rawSnapshot')
    expect(Object.keys(internalRow())).not.toContain('title')
  })
  it('the external candidate row type has no rawSnapshot/sourceUrl/title field', () => {
    expect(Object.keys(externalRow())).not.toContain('rawSnapshot')
    expect(Object.keys(externalRow())).not.toContain('sourceUrl')
    expect(Object.keys(externalRow())).not.toContain('title')
  })
})

// ── §73: no valuation, structural ──

describe('no valuation logic in this module (§73)', () => {
  it('module source contains no confidence/IQR/weighted-estimate/forecast/fallback-broadening logic (excluding doc comments explaining their absence)', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/marketSaleQuery.ts'), 'utf-8')
    const code = src
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(code).not.toMatch(/confidence|IQR|iqr|weightedMedian|weightedAverage|forecast|outlier/i)
  })
})

// ── §74: query count / no N+1 ──

describe('query count / no N+1 (§74)', () => {
  it('getMarketSaleHistory issues exactly one query per active source, never per-row', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([internalRow(), internalRow({ id: 'oi2' }), internalRow({ id: 'oi3' })])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([externalRow(), externalRow({ id: 'obs2' })])
    await getMarketSaleHistory({ catalogModelId: 'cat1' })
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.externalMarketObservation.findMany).toHaveBeenCalledTimes(1)
  })

  it('external select reuses 21D EXTERNAL_COMPARABLE_SELECT shape (no separate per-observation MarketVariant query)', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValue([])
    await getMarketSaleHistory({ catalogModelId: 'cat1' })
    const select = (prisma.externalMarketObservation.findMany as Mock).mock.calls[0][0].select
    expect(select.marketVariant).toEqual({ select: { id: true, catalogModelId: true, packagingType: true } })
  })
})
