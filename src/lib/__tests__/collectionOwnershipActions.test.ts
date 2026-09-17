// 26B §24/§52-55: customer-facing ownership actions — addAcquisitionLotAction
// ("Add Another") and markCollectionItemDisposedAction ("Mark Sold /
// Removed"). Both go through the ledger primitives exclusively; neither ever
// blindly bumps CollectionItem.quantity. Manual disposal idempotency is via a
// per-submission token embedded in the sourceKey.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => {
  const client: Record<string, unknown> = {
    collectionItem: { findFirst: vi.fn(), update: vi.fn() },
    acquisitionLot: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), updateMany: vi.fn() },
    collectionDisposal: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    collectionDisposalAllocation: { createMany: vi.fn() },
  }
  client.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(client))
  return { prisma: client }
})
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { addAcquisitionLotAction, markCollectionItemDisposedAction } from '@/lib/actions/collectionOwnership'

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.$transaction as Mock).mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma))
  ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue({ id: 'ci1' })
  ;(prisma.collectionItem.update as Mock).mockResolvedValue({ id: 'ci1' })
  ;(prisma.acquisitionLot.findUnique as Mock).mockResolvedValue(null)
  ;(prisma.acquisitionLot.create as Mock).mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'lot-new', ...args.data }))
  ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
  ;(prisma.collectionDisposal.findUnique as Mock).mockResolvedValue(null)
  ;(prisma.collectionDisposal.create as Mock).mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'disp-new', ...args.data }))
  ;(prisma.acquisitionLot.updateMany as Mock).mockResolvedValue({ count: 1 })
  // Default: plenty of owned quantity, so disposal tests exercise the happy
  // path unless a test explicitly overrides findMany for an overdraw case.
  ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
    { id: 'lot1', collectionItemId: 'ci1', remainingQuantity: 10, unitRecordedCostCents: null, acquiredAt: null, ledgerEffectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
  ])
  ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
})

describe('addAcquisitionLotAction — a new AcquisitionLot, never a mutation of an existing one', () => {
  it('creates a new lot with quantity/price/date from the form, source manual', async () => {
    await expect(
      addAcquisitionLotAction('ci1', null, fd({ quantity: '2', purchasePricePerItem: '15.00', purchaseDate: '2026-01-15' })),
    ).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1')
    const call = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(call.data.quantityAcquired).toBe(2)
    expect(call.data.unitRecordedCostCents).toBe(1500)
    expect(call.data.source).toBe('manual')
    expect(call.data.costKnowledge).toBe('known')
  })

  it('omitted quantity defaults to 1', async () => {
    await expect(addAcquisitionLotAction('ci1', null, fd({}))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(call.data.quantityAcquired).toBe(1)
  })

  it('no price -> unitRecordedCostCents null, costKnowledge unknown (never invents a cost)', async () => {
    await expect(addAcquisitionLotAction('ci1', null, fd({ quantity: '1' }))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.acquisitionLot.create as Mock).mock.calls[0][0]
    expect(call.data.unitRecordedCostCents).toBeNull()
    expect(call.data.costKnowledge).toBe('unknown')
  })

  it('never mutates an existing lot — only acquisitionLot.create is ever called, never acquisitionLot.update', async () => {
    await expect(addAcquisitionLotAction('ci1', null, fd({ quantity: '1' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(prisma.acquisitionLot.create).toHaveBeenCalledTimes(1)
    expect((prisma.acquisitionLot as unknown as Record<string, unknown>).update).toBeUndefined()
  })

  it('rejects an invalid (non-numeric) quantity with a field error, never reaching the ledger', async () => {
    const result = await addAcquisitionLotAction('ci1', null, fd({ quantity: 'abc' }))
    expect(result?.errors.quantity?.[0]).toBeTruthy()
    expect(prisma.acquisitionLot.create).not.toHaveBeenCalled()
  })

  it('an item not owned by this session (cross-customer) is rejected before touching the ledger', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    const result = await addAcquisitionLotAction('not-mine', null, fd({ quantity: '1' }))
    expect(result?.errors.form?.[0]).toBeTruthy()
    expect(prisma.acquisitionLot.create).not.toHaveBeenCalled()
  })

  it('no session -> friendly error, no ledger call', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    const result = await addAcquisitionLotAction('ci1', null, fd({ quantity: '1' }))
    expect(result?.errors.form?.[0]).toBeTruthy()
    expect(prisma.acquisitionLot.create).not.toHaveBeenCalled()
  })
})

describe('markCollectionItemDisposedAction — manual removal, idempotent via sourceKey token', () => {
  function markedFd(overrides: Record<string, string> = {}) {
    return fd({ disposalType: 'gift', quantity: '1', idempotencyToken: 'tok-abc', ...overrides })
  }

  it('creates a disposal with sourceKey manual:<token>', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd())).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1')
    const call = (prisma.collectionDisposal.create as Mock).mock.calls[0][0]
    expect(call.data.sourceKey).toBe('manual:tok-abc')
    expect(call.data.disposalType).toBe('gift')
  })

  it('retrying the SAME submission (identical token) is a no-op — sourceKey already exists', async () => {
    ;(prisma.collectionDisposal.findUnique as Mock).mockResolvedValue({ id: 'existing-disp', collectionItemId: 'ci1', quantity: 1 })
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd())).rejects.toThrow('NEXT_REDIRECT:/account/collection/ci1')
    expect(prisma.collectionDisposal.create).not.toHaveBeenCalled()
  })

  it('a fresh submission (new token, e.g. after page reload) is NOT deduplicated against a prior one', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ idempotencyToken: 'tok-1' }))).rejects.toThrow('NEXT_REDIRECT')
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ idempotencyToken: 'tok-2' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(prisma.collectionDisposal.create).toHaveBeenCalledTimes(2)
  })

  it('only external_sale collects proceeds — gift never sends netProceedsCents even if the field were somehow submitted', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ disposalType: 'gift', netProceeds: '50' }))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.collectionDisposal.create as Mock).mock.calls[0][0]
    expect(call.data.netProceedsCents).toBeNull()
  })

  it('trade never sends proceeds either — no barter accounting', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ disposalType: 'trade', netProceeds: '50' }))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.collectionDisposal.create as Mock).mock.calls[0][0]
    expect(call.data.netProceedsCents).toBeNull()
  })

  it('other_removal never sends proceeds', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ disposalType: 'other_removal' }))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.collectionDisposal.create as Mock).mock.calls[0][0]
    expect(call.data.netProceedsCents).toBeNull()
  })

  it('external_sale with a total proceeds figure passes it through as netProceedsCents', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ disposalType: 'external_sale', netProceeds: '45.50' }))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.collectionDisposal.create as Mock).mock.calls[0][0]
    expect(call.data.netProceedsCents).toBe(4550)
  })

  it('external_sale with no proceeds entered leaves netProceedsCents null (optional, not forced to $0)', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ disposalType: 'external_sale' }))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.collectionDisposal.create as Mock).mock.calls[0][0]
    expect(call.data.netProceedsCents).toBeNull()
  })

  it('grossProceedsCents is never set by the manual action (only consignment/buyout triggers set gross)', async () => {
    await expect(markCollectionItemDisposedAction('ci1', null, markedFd({ disposalType: 'external_sale', netProceeds: '10' }))).rejects.toThrow('NEXT_REDIRECT')
    const call = (prisma.collectionDisposal.create as Mock).mock.calls[0][0]
    expect(call.data.grossProceedsCents).toBeNull()
  })

  it('rejects an unrecognized disposalType (e.g. "platform_sale", "correction" — reserved for system-triggered/edit paths, not this picker)', async () => {
    const result = await markCollectionItemDisposedAction('ci1', null, markedFd({ disposalType: 'platform_sale' }))
    expect(result?.errors.disposalType?.[0]).toBeTruthy()
    expect(prisma.collectionDisposal.create).not.toHaveBeenCalled()
  })

  it('rejects a missing idempotency token — never proceeds without one', async () => {
    const f = fd({ disposalType: 'gift', quantity: '1' })
    const result = await markCollectionItemDisposedAction('ci1', null, f)
    expect(result?.errors.idempotencyToken?.[0]).toBeTruthy()
    expect(prisma.collectionDisposal.create).not.toHaveBeenCalled()
  })

  it('insufficient quantity surfaces a friendly field error, not a crash', async () => {
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      { id: 'lot1', collectionItemId: 'ci1', remainingQuantity: 1, unitRecordedCostCents: null, acquiredAt: null, ledgerEffectiveAt: new Date(), createdAt: new Date() },
    ])
    const result = await markCollectionItemDisposedAction('ci1', null, markedFd({ quantity: '5' }))
    expect(result?.errors.quantity?.[0]).toContain('You only own 1')
  })

  it('an item not owned by this session is rejected before touching the ledger', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    const result = await markCollectionItemDisposedAction('not-mine', null, markedFd())
    expect(result?.errors.form?.[0]).toBeTruthy()
    expect(prisma.collectionDisposal.create).not.toHaveBeenCalled()
  })
})
