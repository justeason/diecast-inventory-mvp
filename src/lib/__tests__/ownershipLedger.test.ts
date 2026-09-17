// 26B: core ownership-ledger primitives — FIFO ordering, legacy cost
// resolution, acquisition, disposal (+ overdraw/concurrency), reversal, and
// Recorded Realized Gain/Loss. FIFO is load-bearing (allocation order depends
// ONLY on ownership chronology, never cost knowledge) — this file exercises
// that invariant directly. No real DB; all mutating functions take a mocked
// Prisma.TransactionClient, mirroring this codebase's established pattern
// (see sellerPayoutCalculation.test.ts / collectionItemConcurrency.test.ts).
import { describe, it, expect, vi } from 'vitest'
import {
  compareLotsForFifo,
  resolveLegacyCostKnowledge,
  resolveLedgerEffectiveAt,
  createAcquisitionLot,
  createDisposal,
  reverseDisposal,
  computeRealizedGain,
  SALE_DISPOSAL_TYPES,
} from '@/lib/ownershipLedger'

type Mock = ReturnType<typeof vi.fn>

function makeLot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lot1',
    collectionItemId: 'ci1',
    quantityAcquired: 1,
    remainingQuantity: 1,
    unitRecordedCostCents: null,
    legacyRecordedPriceCents: null,
    costKnowledge: 'unknown',
    acquiredAt: null,
    ledgerEffectiveAt: new Date('2026-01-01'),
    source: 'manual',
    sourceKey: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    acquisitionLot: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'lot-new', ...args.data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    collectionDisposal: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'disposal-new', ...args.data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    collectionDisposalAllocation: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    collectionItem: {
      update: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  }
}

// ── FIFO ordering ────────────────────────────────────────────────────────────

describe('compareLotsForFifo — ownership chronology, NEVER cost knowledge', () => {
  it('orders strictly by acquiredAt when both lots have it', () => {
    const older = { id: 'a', acquiredAt: new Date('2025-01-01'), ledgerEffectiveAt: new Date('2025-06-01'), createdAt: new Date('2025-06-01') }
    const newer = { id: 'b', acquiredAt: new Date('2025-03-01'), ledgerEffectiveAt: new Date('2025-06-01'), createdAt: new Date('2025-06-01') }
    expect(compareLotsForFifo(older, newer)).toBeLessThan(0)
    expect(compareLotsForFifo(newer, older)).toBeGreaterThan(0)
  })

  it('falls back to ledgerEffectiveAt when acquiredAt is null', () => {
    const a = { id: 'a', acquiredAt: null, ledgerEffectiveAt: new Date('2025-01-01'), createdAt: new Date('2025-01-01') }
    const b = { id: 'b', acquiredAt: null, ledgerEffectiveAt: new Date('2025-06-01'), createdAt: new Date('2025-06-01') }
    expect(compareLotsForFifo(a, b)).toBeLessThan(0)
  })

  it('a null-acquiredAt lot with an early ledgerEffectiveAt can sort BEFORE a known-acquiredAt lot with a later date — chronology, never null-first/last bias', () => {
    const legacyUnknownDate = { id: 'legacy', acquiredAt: null, ledgerEffectiveAt: new Date('2020-01-01'), createdAt: new Date('2020-01-01') }
    const newKnownDate = { id: 'new', acquiredAt: new Date('2026-01-01'), ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') }
    expect(compareLotsForFifo(legacyUnknownDate, newKnownDate)).toBeLessThan(0)
  })

  it('same effective timestamp -> tie-breaks on createdAt', () => {
    const first = { id: 'a', acquiredAt: null, ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01T10:00:00Z') }
    const second = { id: 'b', acquiredAt: null, ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01T11:00:00Z') }
    expect(compareLotsForFifo(first, second)).toBeLessThan(0)
  })

  it('same effective timestamp AND same createdAt -> tie-breaks on id (deterministic, never random/unstable)', () => {
    const a = { id: 'aaa', acquiredAt: null, ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') }
    const b = { id: 'bbb', acquiredAt: null, ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') }
    expect(compareLotsForFifo(a, b)).toBeLessThan(0)
    expect(compareLotsForFifo(b, a)).toBeGreaterThan(0)
  })

  it('cost knowledge (known vs unknown) never appears in the comparator at all — the function does not even accept a cost field', () => {
    // Structural proof: FifoLot's shape (acquiredAt/ledgerEffectiveAt/createdAt/id)
    // has no cost-related field, so it is impossible for the comparator to branch
    // on cost knowledge even by accident.
    const cheapButNewer = { id: 'cheap', acquiredAt: new Date('2026-03-01'), ledgerEffectiveAt: new Date('2026-03-01'), createdAt: new Date('2026-03-01') }
    const unknownButOlder = { id: 'unknown', acquiredAt: new Date('2026-01-01'), ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') }
    // Regardless of which one is "cost known" in the caller's domain, the older
    // one sorts first — ordering is purely chronological.
    expect(compareLotsForFifo(unknownButOlder, cheapButNewer)).toBeLessThan(0)
  })
})

// ── Legacy cost resolution ──────────────────────────────────────────────────

describe('resolveLegacyCostKnowledge', () => {
  it('quantity=1 + valid price -> known, unit cost in cents, no legacy raw price stored', () => {
    const r = resolveLegacyCostKnowledge(1, 20)
    expect(r.costKnowledge).toBe('known')
    expect(r.unitRecordedCostCents).toBe(2000)
    expect(r.legacyRecordedPriceCents).toBeNull()
  })

  it('quantity=1 + price=0 -> known zero, never conflated with unknown', () => {
    const r = resolveLegacyCostKnowledge(1, 0)
    expect(r.costKnowledge).toBe('known')
    expect(r.unitRecordedCostCents).toBe(0)
  })

  it('quantity>1 + valid price -> ambiguous_legacy, raw price preserved verbatim, unit cost null', () => {
    const r = resolveLegacyCostKnowledge(3, 30)
    expect(r.costKnowledge).toBe('ambiguous_legacy')
    expect(r.unitRecordedCostCents).toBeNull()
    expect(r.legacyRecordedPriceCents).toBe(3000)
  })

  it('quantity>1 + price never divided/multiplied — raw cents equal the input price exactly, not price/quantity or price*quantity', () => {
    const r = resolveLegacyCostKnowledge(4, 19.99)
    expect(r.legacyRecordedPriceCents).toBe(1999)
  })

  it('null price -> unknown, regardless of quantity', () => {
    expect(resolveLegacyCostKnowledge(1, null).costKnowledge).toBe('unknown')
    expect(resolveLegacyCostKnowledge(5, null).costKnowledge).toBe('unknown')
  })

  it('negative price -> unknown, never a negative cost', () => {
    const r = resolveLegacyCostKnowledge(1, -5)
    expect(r.costKnowledge).toBe('unknown')
    expect(r.unitRecordedCostCents).toBeNull()
  })

  it('non-finite price (NaN/Infinity) -> unknown, never crashes', () => {
    expect(resolveLegacyCostKnowledge(1, NaN).costKnowledge).toBe('unknown')
    expect(resolveLegacyCostKnowledge(1, Infinity).costKnowledge).toBe('unknown')
  })
})

describe('resolveLedgerEffectiveAt — backfill cutover vs. per-item createdAt (26B Pre-Commit Invariant)', () => {
  const CUTOVER = new Date('2026-09-15T06:23:11.960Z')

  it('a legacy row created well before the cutover shares the cutover', () => {
    const createdAt = new Date('2024-01-01')
    expect(resolveLedgerEffectiveAt(CUTOVER, createdAt)).toEqual(CUTOVER)
  })

  it('a row created exactly at the cutover shares the cutover (boundary: not strictly after)', () => {
    expect(resolveLedgerEffectiveAt(CUTOVER, new Date(CUTOVER.getTime()))).toEqual(CUTOVER)
  })

  it('a row created AFTER the cutover (the backfill-gap case) uses its own later createdAt, never the earlier cutover', () => {
    const createdAt = new Date('2026-09-20T00:00:00Z') // after CUTOVER
    expect(resolveLedgerEffectiveAt(CUTOVER, createdAt)).toEqual(createdAt)
  })

  it('never projects ownership before the CollectionItem existed: the result is always >= both inputs', () => {
    const preCutover = resolveLedgerEffectiveAt(CUTOVER, new Date('2020-01-01'))
    expect(preCutover.getTime()).toBeGreaterThanOrEqual(new Date('2020-01-01').getTime())
    const postCutover = new Date('2026-10-01')
    const result = resolveLedgerEffectiveAt(CUTOVER, postCutover)
    expect(result.getTime()).toBeGreaterThanOrEqual(postCutover.getTime())
    expect(result.getTime()).toBeGreaterThanOrEqual(CUTOVER.getTime())
  })

  it('multiple pre-cutover rows all resolve to the exact SAME cutover instant (one shared cutover per run)', () => {
    const a = resolveLedgerEffectiveAt(CUTOVER, new Date('2023-01-01'))
    const b = resolveLedgerEffectiveAt(CUTOVER, new Date('2024-06-15'))
    expect(a).toEqual(CUTOVER)
    expect(b).toEqual(CUTOVER)
    expect(a).toEqual(b)
  })
})

// ── Acquisition ──────────────────────────────────────────────────────────────

describe('createAcquisitionLot', () => {
  it('creates a lot with remainingQuantity seeded to quantityAcquired', async () => {
    const tx = makeTx()
    const result = await createAcquisitionLot(tx as never, {
      collectionItemId: 'ci1', quantityAcquired: 5, costKnowledge: 'unknown', ledgerEffectiveAt: new Date(), source: 'manual',
    })
    expect(result.created).toBe(true)
    const call = (tx.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(call.data.quantityAcquired).toBe(5)
    expect(call.data.remainingQuantity).toBe(5)
  })

  it('by default increments CollectionItem.quantity by quantityAcquired', async () => {
    const tx = makeTx()
    await createAcquisitionLot(tx as never, {
      collectionItemId: 'ci1', quantityAcquired: 3, costKnowledge: 'unknown', ledgerEffectiveAt: new Date(), source: 'manual',
    })
    expect(tx.collectionItem.update).toHaveBeenCalledWith({ where: { id: 'ci1' }, data: { quantity: { increment: 3 } } })
  })

  it('syncCollectionItemQuantity: false (legacy backfill) never touches CollectionItem.quantity', async () => {
    const tx = makeTx()
    await createAcquisitionLot(tx as never, {
      collectionItemId: 'ci1', quantityAcquired: 3, costKnowledge: 'unknown', ledgerEffectiveAt: new Date(), source: 'legacy_backfill', syncCollectionItemQuantity: false,
    })
    expect(tx.collectionItem.update).not.toHaveBeenCalled()
  })

  it('idempotent via sourceKey — a pre-existing lot for the same sourceKey short-circuits with created:false and never creates a duplicate or double-increments', async () => {
    const existing = makeLot({ id: 'existing', sourceKey: 'legacy-backfill:ci1' })
    const tx = makeTx({ acquisitionLot: { findUnique: vi.fn().mockResolvedValue(existing), create: vi.fn(), updateMany: vi.fn(), update: vi.fn() } })
    const result = await createAcquisitionLot(tx as never, {
      collectionItemId: 'ci1', quantityAcquired: 1, costKnowledge: 'unknown', ledgerEffectiveAt: new Date(), source: 'legacy_backfill', sourceKey: 'legacy-backfill:ci1',
    })
    expect(result.created).toBe(false)
    expect(result.lot).toBe(existing)
    expect(tx.acquisitionLot.create).not.toHaveBeenCalled()
    expect(tx.collectionItem.update).not.toHaveBeenCalled()
  })

  it('rejects a non-positive/non-integer quantityAcquired', async () => {
    const tx = makeTx()
    await expect(
      createAcquisitionLot(tx as never, { collectionItemId: 'ci1', quantityAcquired: 0, costKnowledge: 'unknown', ledgerEffectiveAt: new Date(), source: 'manual' }),
    ).rejects.toThrow(/INVALID_QUANTITY/)
    await expect(
      createAcquisitionLot(tx as never, { collectionItemId: 'ci1', quantityAcquired: 1.5, costKnowledge: 'unknown', ledgerEffectiveAt: new Date(), source: 'manual' }),
    ).rejects.toThrow(/INVALID_QUANTITY/)
  })

  it('rejects a negative unitRecordedCostCents', async () => {
    const tx = makeTx()
    await expect(
      createAcquisitionLot(tx as never, { collectionItemId: 'ci1', quantityAcquired: 1, unitRecordedCostCents: -100, costKnowledge: 'known', ledgerEffectiveAt: new Date(), source: 'manual' }),
    ).rejects.toThrow(/INVALID_CENTS/)
  })

  it('a null unitRecordedCostCents is valid (unknown-cost acquisition) — never rejected', async () => {
    const tx = makeTx()
    await expect(
      createAcquisitionLot(tx as never, { collectionItemId: 'ci1', quantityAcquired: 1, unitRecordedCostCents: null, costKnowledge: 'unknown', ledgerEffectiveAt: new Date(), source: 'quick_capture' }),
    ).resolves.toMatchObject({ created: true })
  })

  it('acquiredAt and ledgerEffectiveAt are stored as two distinct fields — acquiredAt defaults to null when omitted, never defaulted to ledgerEffectiveAt at write time', async () => {
    const tx = makeTx()
    const ledgerEffectiveAt = new Date('2026-05-01')
    await createAcquisitionLot(tx as never, { collectionItemId: 'ci1', quantityAcquired: 1, costKnowledge: 'unknown', ledgerEffectiveAt, source: 'manual' })
    const call = (tx.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(call.data.acquiredAt).toBeNull()
    expect(call.data.ledgerEffectiveAt).toBe(ledgerEffectiveAt)
  })
})

// ── Disposal — FIFO allocation, multiple lots, partial/multiple disposals ──

describe('createDisposal — FIFO allocation', () => {
  it('single lot, full disposal: one allocation, lot fully decremented', async () => {
    const lot = makeLot({ id: 'lot1', remainingQuantity: 5 })
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([lot]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    const result = await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 5, disposalType: 'external_sale', disposedAt: new Date() })
    expect(result.status).toBe('created')
    expect(tx.collectionDisposalAllocation.createMany).toHaveBeenCalledTimes(1)
    const allocCall = (tx.collectionDisposalAllocation.createMany as Mock).mock.calls[0][0]
    expect(allocCall.data).toHaveLength(1)
    expect(allocCall.data[0].quantity).toBe(5)
  })

  it('allocates the OLDEST lot first regardless of which lot has known cost (FIFO by chronology only)', async () => {
    const oldUnknownCost = makeLot({ id: 'old-unknown', remainingQuantity: 2, unitRecordedCostCents: null, acquiredAt: new Date('2025-01-01'), createdAt: new Date('2025-01-01') })
    const newKnownCost = makeLot({ id: 'new-known', remainingQuantity: 2, unitRecordedCostCents: 500, acquiredAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') })
    // findMany returns them out of chronological order — createDisposal must sort itself.
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([newKnownCost, oldUnknownCost]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 1, disposalType: 'external_sale', disposedAt: new Date() })
    const allocCall = (tx.collectionDisposalAllocation.createMany as Mock).mock.calls[0][0]
    expect(allocCall.data[0].acquisitionLotId).toBe('old-unknown')
    expect(allocCall.data[0].allocatedRecordedCostCents).toBeNull() // unknown cost allocated anyway — never zero-assumed
  })

  it('multiple acquisitions: a disposal spanning two lots allocates oldest-first, splitting the quantity across both', async () => {
    const first = makeLot({ id: 'lot-a', remainingQuantity: 2, unitRecordedCostCents: 100, acquiredAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') })
    const second = makeLot({ id: 'lot-b', remainingQuantity: 3, unitRecordedCostCents: 200, acquiredAt: new Date('2026-02-01'), createdAt: new Date('2026-02-01') })
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([first, second]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 4, disposalType: 'external_sale', disposedAt: new Date() })
    const allocCall = (tx.collectionDisposalAllocation.createMany as Mock).mock.calls[0][0]
    expect(allocCall.data).toHaveLength(2)
    expect(allocCall.data[0]).toMatchObject({ acquisitionLotId: 'lot-a', quantity: 2, allocatedRecordedCostCents: 200 })
    expect(allocCall.data[1]).toMatchObject({ acquisitionLotId: 'lot-b', quantity: 2, allocatedRecordedCostCents: 400 })
  })

  it('partial disposal: only part of a lot is consumed, remainingQuantity decremented by exactly that amount', async () => {
    const lot = makeLot({ id: 'lot1', remainingQuantity: 10 })
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([lot]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 3, disposalType: 'gift', disposedAt: new Date() })
    const updateCall = (tx.acquisitionLot.updateMany as Mock).mock.calls[0][0]
    expect(updateCall.where).toMatchObject({ id: 'lot1', remainingQuantity: { gte: 3 } })
    expect(updateCall.data).toEqual({ remainingQuantity: { decrement: 3 } })
  })

  it('multiple disposals against the same item: a second disposal correctly continues from wherever the first left off (each call re-reads remaining lots fresh)', async () => {
    const lot = makeLot({ id: 'lot1', remainingQuantity: 4 })
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([lot]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 1, disposalType: 'gift', disposedAt: new Date() })
    await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 1, disposalType: 'gift', disposedAt: new Date() })
    expect(tx.acquisitionLot.findMany).toHaveBeenCalledTimes(2) // fresh read each time, no stale in-memory state
  })

  it('CollectionItem.quantity cache is decremented by the disposal quantity', async () => {
    const lot = makeLot({ id: 'lot1', remainingQuantity: 5 })
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([lot]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 2, disposalType: 'gift', disposedAt: new Date() })
    expect(tx.collectionItem.update).toHaveBeenCalledWith({ where: { id: 'ci1' }, data: { quantity: { decrement: 2 } } })
  })

  it('only lots with remainingQuantity > 0 are ever queried as candidates', async () => {
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 1, disposalType: 'gift', disposedAt: new Date() })
    const call = (tx.acquisitionLot.findMany as Mock).mock.calls[0][0]
    expect(call.where.remainingQuantity).toEqual({ gt: 0 })
  })
})

describe('createDisposal — overdraw and concurrency protection', () => {
  it('insufficient total quantity across all lots -> status insufficient_quantity, NO writes at all (atomic all-or-nothing)', async () => {
    const lot = makeLot({ id: 'lot1', remainingQuantity: 2 })
    const tx = makeTx({ acquisitionLot: { findMany: vi.fn().mockResolvedValue([lot]), updateMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } })
    const result = await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 5, disposalType: 'gift', disposedAt: new Date() })
    expect(result).toMatchObject({ status: 'insufficient_quantity', available: 2, requested: 5 })
    expect(tx.acquisitionLot.updateMany).not.toHaveBeenCalled()
    expect(tx.collectionDisposal.create).not.toHaveBeenCalled()
    expect(tx.collectionItem.update).not.toHaveBeenCalled()
  })

  it('a concurrent overdraw (another transaction already decremented the lot between read and write) throws, never silently under-allocates', async () => {
    const lot = makeLot({ id: 'lot1', remainingQuantity: 5 })
    const tx = makeTx({
      acquisitionLot: {
        findMany: vi.fn().mockResolvedValue([lot]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // the conditional claim lost the race
        findUnique: vi.fn(), create: vi.fn(), update: vi.fn(),
      },
    })
    await expect(
      createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 5, disposalType: 'gift', disposedAt: new Date() }),
    ).rejects.toThrow(/CONCURRENT_OVERDRAW/)
    expect(tx.collectionDisposal.create).not.toHaveBeenCalled()
  })

  it('a concurrent overdraw on the SECOND of two allocated lots still throws (partial success is never accepted)', async () => {
    const first = makeLot({ id: 'lot-a', remainingQuantity: 2, acquiredAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') })
    const second = makeLot({ id: 'lot-b', remainingQuantity: 3, acquiredAt: new Date('2026-02-01'), createdAt: new Date('2026-02-01') })
    let call = 0
    const tx = makeTx({
      acquisitionLot: {
        findMany: vi.fn().mockResolvedValue([first, second]),
        updateMany: vi.fn().mockImplementation(() => {
          call++
          return Promise.resolve({ count: call === 1 ? 1 : 0 }) // first lot claim succeeds, second loses the race
        }),
        findUnique: vi.fn(), create: vi.fn(), update: vi.fn(),
      },
    })
    await expect(
      createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 4, disposalType: 'gift', disposedAt: new Date() }),
    ).rejects.toThrow(/CONCURRENT_OVERDRAW/)
    // The disposal row itself is never created once any allocation fails.
    expect(tx.collectionDisposal.create).not.toHaveBeenCalled()
  })

  it('rejects a non-positive disposal quantity', async () => {
    const tx = makeTx()
    await expect(
      createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 0, disposalType: 'gift', disposedAt: new Date() }),
    ).rejects.toThrow(/INVALID_QUANTITY/)
  })

  it('rejects negative proceeds', async () => {
    const tx = makeTx()
    await expect(
      createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 1, disposalType: 'external_sale', disposedAt: new Date(), netProceedsCents: -1 }),
    ).rejects.toThrow(/INVALID_CENTS/)
  })
})

describe('createDisposal — sourceKey idempotency', () => {
  it('a pre-existing disposal for the same sourceKey short-circuits with status already_exists, no new writes', async () => {
    const existing = { id: 'existing-disposal', collectionItemId: 'ci1', quantity: 1 }
    const tx = makeTx({ collectionDisposal: { findUnique: vi.fn().mockResolvedValue(existing), create: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() } })
    const result = await createDisposal(tx as never, { collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(), sourceKey: 'orderitem:oi1' })
    expect(result).toEqual({ status: 'already_exists', disposal: existing })
    expect(tx.acquisitionLot.findMany).not.toHaveBeenCalled()
    expect(tx.collectionItem.update).not.toHaveBeenCalled()
  })
})

// ── Reversal ─────────────────────────────────────────────────────────────────

describe('reverseDisposal', () => {
  it('restores remainingQuantity on every allocated lot and increments CollectionItem.quantity by the disposal total', async () => {
    const disposal = { id: 'disp1', collectionItemId: 'ci1', quantity: 3, reversedAt: null }
    const allocations = [{ acquisitionLotId: 'lot-a', quantity: 1 }, { acquisitionLotId: 'lot-b', quantity: 2 }]
    const tx = makeTx({
      collectionDisposal: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(disposal),
        findUnique: vi.fn(), create: vi.fn(),
      },
      collectionDisposalAllocation: { findMany: vi.fn().mockResolvedValue(allocations), createMany: vi.fn() },
    })
    const result = await reverseDisposal(tx as never, 'disp1', 'buyer requested return')
    expect(result.status).toBe('reversed')
    expect(tx.acquisitionLot.update).toHaveBeenCalledWith({ where: { id: 'lot-a' }, data: { remainingQuantity: { increment: 1 } } })
    expect(tx.acquisitionLot.update).toHaveBeenCalledWith({ where: { id: 'lot-b' }, data: { remainingQuantity: { increment: 2 } } })
    expect(tx.collectionItem.update).toHaveBeenCalledWith({ where: { id: 'ci1' }, data: { quantity: { increment: 3 } } })
  })

  it('reversal never deletes the disposal or its allocations — it sets reversedAt/reversalReason only', async () => {
    const disposal = { id: 'disp1', collectionItemId: 'ci1', quantity: 1, reversedAt: null }
    const tx = makeTx({
      collectionDisposal: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(disposal),
        findUnique: vi.fn(), create: vi.fn(),
      },
      collectionDisposalAllocation: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() },
    })
    await reverseDisposal(tx as never, 'disp1', 'mistake')
    const claimCall = (tx.collectionDisposal.updateMany as Mock).mock.calls[0][0]
    expect(claimCall.where).toEqual({ id: 'disp1', reversedAt: null })
    expect(claimCall.data.reversalReason).toBe('mistake')
    expect(claimCall.data.reversedAt).toBeInstanceOf(Date)
  })

  it('idempotent: retrying an already-reversed disposal claims zero rows and never restores quantity a second time', async () => {
    const alreadyReversed = { id: 'disp1', collectionItemId: 'ci1', quantity: 3, reversedAt: new Date() }
    const tx = makeTx({
      collectionDisposal: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // conditional claim finds nothing (already reversed)
        findUnique: vi.fn().mockResolvedValue(alreadyReversed),
        findUniqueOrThrow: vi.fn(), create: vi.fn(),
      },
    })
    const result = await reverseDisposal(tx as never, 'disp1', 'retry')
    expect(result).toEqual({ status: 'already_reversed', disposal: alreadyReversed })
    expect(tx.acquisitionLot.update).not.toHaveBeenCalled()
    expect(tx.collectionItem.update).not.toHaveBeenCalled()
  })

  it('a non-existent disposal id returns not_found, never throws', async () => {
    const tx = makeTx({
      collectionDisposal: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn(), create: vi.fn(),
      },
    })
    const result = await reverseDisposal(tx as never, 'nope', 'reason')
    expect(result).toEqual({ status: 'not_found' })
  })
})

// ── Recorded Realized Gain/Loss ─────────────────────────────────────────────

describe('computeRealizedGain', () => {
  it('positive gain: proceeds exceed allocated cost', () => {
    const r = computeRealizedGain(1500, [{ allocatedRecordedCostCents: 1000 }])
    expect(r).toEqual({ status: 'calculable', recordedRealizedGainLossCents: 500, recordedRealizedGainLossPercent: 0.5 })
  })

  it('negative gain (loss): proceeds below allocated cost, no clamping to zero', () => {
    const r = computeRealizedGain(300, [{ allocatedRecordedCostCents: 1000 }])
    expect(r).toEqual({ status: 'calculable', recordedRealizedGainLossCents: -700, recordedRealizedGainLossPercent: -0.7 })
  })

  it('zero gain', () => {
    const r = computeRealizedGain(1000, [{ allocatedRecordedCostCents: 1000 }])
    expect(r.status).toBe('calculable')
    if (r.status === 'calculable') expect(r.recordedRealizedGainLossCents).toBe(0)
  })

  it('sums allocated cost across multiple allocations (a disposal spanning multiple lots)', () => {
    const r = computeRealizedGain(3000, [{ allocatedRecordedCostCents: 1000 }, { allocatedRecordedCostCents: 500 }])
    expect(r.status).toBe('calculable')
    if (r.status === 'calculable') expect(r.recordedRealizedGainLossCents).toBe(1500)
  })

  it('unknown net proceeds -> unavailable, never treated as $0 proceeds', () => {
    expect(computeRealizedGain(null, [{ allocatedRecordedCostCents: 1000 }])).toEqual({ status: 'unavailable' })
  })

  it('any single allocation with unknown cost -> the whole disposal is unavailable, never partial/zero-assumed', () => {
    const r = computeRealizedGain(1000, [{ allocatedRecordedCostCents: 500 }, { allocatedRecordedCostCents: null }])
    expect(r).toEqual({ status: 'unavailable' })
  })

  it('zero allocations (should not happen in practice, but never divides by nothing / crashes) -> unavailable', () => {
    expect(computeRealizedGain(1000, [])).toEqual({ status: 'unavailable' })
  })

  it('zero-cost denominator -> percent is null, never Infinity or NaN', () => {
    const r = computeRealizedGain(500, [{ allocatedRecordedCostCents: 0 }])
    expect(r.status).toBe('calculable')
    if (r.status === 'calculable') {
      expect(r.recordedRealizedGainLossCents).toBe(500)
      expect(r.recordedRealizedGainLossPercent).toBeNull()
    }
  })
})

describe('SALE_DISPOSAL_TYPES — realized-gain eligibility scope', () => {
  it('is exactly platform_sale and external_sale — gift/trade/other_removal/correction are never realized-gain eligible', () => {
    expect([...SALE_DISPOSAL_TYPES].sort()).toEqual(['external_sale', 'platform_sale'])
  })
})

// ── Proceeds enrichment for the consignment async-payout race (26B Final Gate §1) ──
// Simulates a persistent store (a plain object) across sequential createDisposal
// calls on the SAME tx mock, mirroring the real scenario: reconciliation runs
// once at order completion (payout line not yet created), then again later
// once the payout line exists (e.g. via the admin "generate missing payout
// lines" tool) — both calls share the same sourceKey.

function makeEnrichmentTx(lotRow: ReturnType<typeof makeLot>) {
  let storedDisposal: Record<string, unknown> | null = null
  const tx = {
    acquisitionLot: {
      findMany: vi.fn().mockResolvedValue([lotRow]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(), create: vi.fn(), update: vi.fn(),
    },
    collectionDisposal: {
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(storedDisposal)),
      findUniqueOrThrow: vi.fn().mockImplementation(() => Promise.resolve(storedDisposal)),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        storedDisposal = { id: 'disp1', ...args.data }
        return Promise.resolve(storedDisposal)
      }),
      updateMany: vi.fn().mockImplementation((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!storedDisposal) return Promise.resolve({ count: 0 })
        for (const [key, val] of Object.entries(args.where)) {
          if (key !== 'id' && storedDisposal[key] !== val) return Promise.resolve({ count: 0 })
        }
        Object.assign(storedDisposal, args.data)
        return Promise.resolve({ count: 1 })
      }),
    },
    collectionDisposalAllocation: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    collectionItem: { update: vi.fn().mockResolvedValue({}) },
  }
  return { tx, getStored: () => storedDisposal }
}

describe('createDisposal — proceeds enrichment closes the consignment async-payout race', () => {
  it('scenario A: created with netProceedsCents null (payout line not yet known); a later call with the SAME sourceKey enriches netProceedsCents only, never re-decrementing quantity/lots or re-creating allocations', async () => {
    const { tx, getStored } = makeEnrichmentTx(makeLot({ id: 'lot1', remainingQuantity: 5 }))

    const first = await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date('2026-06-01'),
      grossProceedsCents: 2500, netProceedsCents: null, sourceKey: 'orderitem:oi1',
    })
    expect(first.status).toBe('created')
    expect(tx.collectionItem.update).toHaveBeenCalledTimes(1)
    expect(tx.acquisitionLot.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.collectionDisposalAllocation.createMany).toHaveBeenCalledTimes(1)
    // Realized gain unavailable while proceeds are unknown.
    expect(computeRealizedGain(getStored()!.netProceedsCents as number | null, [{ allocatedRecordedCostCents: 100 }])).toEqual({ status: 'unavailable' })

    const second = await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date('2026-06-01'),
      grossProceedsCents: 2500, netProceedsCents: 2000, sourceKey: 'orderitem:oi1',
    })
    expect(second.status).toBe('already_exists')
    if (second.status === 'already_exists') expect(second.disposal.netProceedsCents).toBe(2000)

    // No re-decrement, no re-allocation, no disposedAt/cost mutation.
    expect(tx.collectionItem.update).toHaveBeenCalledTimes(1)
    expect(tx.acquisitionLot.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.collectionDisposalAllocation.createMany).toHaveBeenCalledTimes(1)
    expect(getStored()!.disposedAt).toEqual(new Date('2026-06-01'))
    expect(getStored()!.grossProceedsCents).toBe(2500)

    // Realized gain becomes calculable now that proceeds are known and cost is covered.
    expect(computeRealizedGain(getStored()!.netProceedsCents as number | null, [{ allocatedRecordedCostCents: 500 }])).toEqual({
      status: 'calculable', recordedRealizedGainLossCents: 1500, recordedRealizedGainLossPercent: 3,
    })
  })

  it('scenario B: a THIRD reconciliation call with the same already-populated value is a pure no-op', async () => {
    const { tx, getStored } = makeEnrichmentTx(makeLot({ id: 'lot1', remainingQuantity: 5 }))
    await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
      grossProceedsCents: 2500, netProceedsCents: null, sourceKey: 'orderitem:oi1',
    })
    await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
      grossProceedsCents: 2500, netProceedsCents: 2000, sourceKey: 'orderitem:oi1',
    })
    const updateCallsBefore = (tx.collectionDisposal.updateMany as Mock).mock.calls.length

    const third = await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
      grossProceedsCents: 2500, netProceedsCents: 2000, sourceKey: 'orderitem:oi1',
    })
    expect(third.status).toBe('already_exists')
    if (third.status === 'already_exists') expect(third.disposal.netProceedsCents).toBe(2000)
    // No new write attempted — the patch was empty (nothing left to enrich).
    expect((tx.collectionDisposal.updateMany as Mock).mock.calls.length).toBe(updateCallsBefore)
    expect(getStored()!.netProceedsCents).toBe(2000)
  })

  it('scenario C: a conflicting proceeds value on a populated field throws rather than silently rewriting the historical fact', async () => {
    const { tx, getStored } = makeEnrichmentTx(makeLot({ id: 'lot1', remainingQuantity: 5 }))
    await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
      grossProceedsCents: 2500, netProceedsCents: null, sourceKey: 'orderitem:oi1',
    })
    await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
      grossProceedsCents: 2500, netProceedsCents: 2000, sourceKey: 'orderitem:oi1',
    })

    await expect(
      createDisposal(tx as never, {
        collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
        grossProceedsCents: 2500, netProceedsCents: 999, sourceKey: 'orderitem:oi1',
      }),
    ).rejects.toThrow(/PROCEEDS_CONFLICT/)

    // The stored value is untouched by the failed/conflicting attempt.
    expect(getStored()!.netProceedsCents).toBe(2000)
  })

  it('a conflicting grossProceedsCents is also refused, independent of netProceedsCents', async () => {
    const { tx, getStored } = makeEnrichmentTx(makeLot({ id: 'lot1', remainingQuantity: 5 }))
    await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
      grossProceedsCents: 2500, netProceedsCents: null, sourceKey: 'orderitem:oi1',
    })
    await expect(
      createDisposal(tx as never, {
        collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date(),
        grossProceedsCents: 9999, netProceedsCents: null, sourceKey: 'orderitem:oi1',
      }),
    ).rejects.toThrow(/PROCEEDS_CONFLICT/)
    expect(getStored()!.grossProceedsCents).toBe(2500)
  })

  it('enrichment never touches quantity/disposalType/disposedAt fields even when they differ in the (malformed) retry input', async () => {
    const { tx, getStored } = makeEnrichmentTx(makeLot({ id: 'lot1', remainingQuantity: 5 }))
    await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 1, disposalType: 'platform_sale', disposedAt: new Date('2026-01-01'),
      grossProceedsCents: 2500, netProceedsCents: null, sourceKey: 'orderitem:oi1',
    })
    await createDisposal(tx as never, {
      collectionItemId: 'ci1', quantity: 5, disposalType: 'platform_sale', disposedAt: new Date('2027-01-01'),
      grossProceedsCents: 2500, netProceedsCents: 2000, sourceKey: 'orderitem:oi1',
    })
    expect(getStored()!.quantity).toBe(1)
    expect(getStored()!.disposedAt).toEqual(new Date('2026-01-01'))
  })
})
