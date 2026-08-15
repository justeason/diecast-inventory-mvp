// 15E: behavioral coverage for resolveIntakeException / bulkResolveIntakeExceptions via
// the established $transaction(async tx => cb(tx)) mock pattern, with a STATEFUL
// intakeDraft/itemInstance store so the resolve-then-convertIntakeDraft sequence (which
// re-fetches the draft it just updated) behaves like a real transaction.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: vi.fn(), intakeDraft: { findUnique: vi.fn() } } }))
vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/actions/sellerLifecycle', () => ({ ensureSellerLifecycleEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import { resolveIntakeException, bulkResolveIntakeExceptions } from '@/lib/actions/intakeExceptions'

function baseDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft1', status: 'draft', convertedItemId: null,
    workbenchExceptionCode: 'unknown_model', workbenchExceptionNote: 'No model resolved.',
    initialExceptionCode: 'unknown_model', initialExceptionNote: 'No model resolved.',
    catalogModelId: null, storageLocationId: 'loc1', condition: 'mint', cardedOrLoose: 'carded',
    sellerInboundShipmentId: 'ship1', sellerSubmissionId: 'sub1', brand: null, name: null,
    ...overrides,
  }
}

function makeTx(initial: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const draftStore = new Map<string, Record<string, unknown>>([[initial.id as string, { ...initial }]])
  const itemStore = new Map<string, Record<string, unknown>>()
  let itemSeq = 0

  const intakeDraftFindUnique = vi.fn().mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(draftStore.get(args.where.id) ?? null))
  const intakeDraftUpdate = vi.fn().mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = draftStore.get(args.where.id)
    if (row) Object.assign(row, args.data)
    return Promise.resolve(row ?? null)
  })

  const itemInstanceCreate = vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
    const id = `item-${itemSeq++}`
    const row = { id, sku: args.data.sku, catalog: { brand: 'Hot Wheels', name: 'Porsche 911' }, location: { label: 'B-14-03' } }
    itemStore.set(id, row)
    return Promise.resolve(row)
  })
  const itemInstanceFindUnique = vi.fn().mockImplementation((args: { where: { id?: string; sku?: string } }) => {
    if (args.where.id) return Promise.resolve(itemStore.get(args.where.id) ?? null)
    return Promise.resolve(null)
  })

  return {
    $queryRaw: vi.fn().mockResolvedValue(undefined),
    intakeDraft: {
      findUnique: intakeDraftFindUnique,
      update: intakeDraftUpdate,
      count: vi.fn().mockResolvedValue(0),
    },
    catalogModel: {
      findUnique: vi.fn().mockResolvedValue({ id: 'cat1', brand: 'Hot Wheels', name: 'Porsche 911' }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'cat-new', brand: 'Hot Wheels', name: 'Porsche 911' }),
    },
    storageLocation: { findUnique: vi.fn().mockResolvedValue({ id: 'loc1', label: 'B-14-03' }) },
    sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ receivedQuantity: null }) },
    sellerAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'agr1', type: 'consignment', status: 'accepted', agreedBuyoutAmount: null, sellerPortfolioId: 'port1', acceptedItemCount: 5 }]) },
    sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'prof1' }) },
    sellerPayoutLine: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'line1' }) },
    itemInstance: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: itemInstanceFindUnique,
      create: itemInstanceCreate,
    },
    photo: { create: vi.fn().mockResolvedValue({}) },
    listing: { create: vi.fn().mockResolvedValue({ id: 'listing1', version: 1 }) },
    ...overrides,
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function defaultAdminAuth() {
  ;(isAdminAuthenticated as Mock).mockResolvedValue(true)
}

// 15E-review section 3: the pre-transaction lock-order hint read (prisma.intakeDraft,
// NOT tx.intakeDraft) — matches baseDraft()'s default sellerInboundShipmentId so
// existing tests continue to exercise the shipment-linked lock path by default.
function defaultLockOrderHint(sellerInboundShipmentId: string | null = 'ship1') {
  ;(prisma.intakeDraft.findUnique as Mock).mockResolvedValue({ sellerInboundShipmentId })
}

describe('resolveIntakeException — individual resolution flows (section 10/11/12/16)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth(); defaultLockOrderHint() })

  it('unknown_model: selecting a catalog model resolves and converts via the shared primitive', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.alreadyResolved).toBe(false)
    expect(result.sku).toBeTruthy()
    expect(tx.itemInstance.create).toHaveBeenCalledTimes(1)
  })

  it('invalid_storage: choosing a valid storage location resolves and converts', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: 'invalid_storage', catalogModelId: 'cat1', storageLocationId: null }))
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', storageLocationId: 'loc1' })
    expect(result.ok).toBe(true)
  })

  it('missing_condition: setting condition/cardedOrLoose resolves and converts', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: 'missing_condition', catalogModelId: 'cat1', condition: null, cardedOrLoose: null }))
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', condition: 'good', cardedOrLoose: 'loose' })
    expect(result.ok).toBe(true)
  })

  it('conversion_failed: retry (no field corrections) re-validates and converts once the underlying issue is gone', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: 'conversion_failed', catalogModelId: 'cat1' }))
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1' })
    expect(result.ok).toBe(true)
  })

  it('the resulting ItemInstance carries the same lineage a normal 15D conversion would (shipment/portfolio/agreement)', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.sellerAgreementId).toBe('agr1')
    expect(call.data.sellerPortfolioId).toBe('port1')
  })

  it('a still-unresolved SECOND issue (storage still invalid after fixing the model) keeps the draft open with the NEW code — never silently converts anyway', async () => {
    const tx = makeTx(baseDraft({ storageLocationId: null }), {
      storageLocation: { findUnique: vi.fn().mockResolvedValue(null) },
    })
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.stillOpen).toBe(true)
    if (!result.stillOpen) throw new Error('unreachable')
    expect(result.code).toBe('invalid_storage')
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('one exception may reveal more than one issue in sequence — fixing model+storage but still missing condition reports missing_condition', async () => {
    const tx = makeTx(baseDraft({ storageLocationId: null, condition: null, cardedOrLoose: null }))
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1', storageLocationId: 'loc1' })
    expect(result.ok).toBe(false)
    if (result.ok || !result.stillOpen) throw new Error('unreachable')
    expect(result.code).toBe('missing_condition')
  })

  it('a draft that is not an open exception (workbenchExceptionCode null) is rejected — this action only touches exceptions', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: null }))
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(result.ok).toBe(false)
  })

  it('admin authentication is required', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    const result = await resolveIntakeException({ draftId: 'draft1' })
    expect(result.ok).toBe(false)
  })
})

describe('resolveIntakeException — shared converter integration (section 16, structural)', () => {
  const src = readSrc('src/lib/actions/intakeExceptions.ts')

  it('imports and calls the shared convertIntakeDraft primitive — never itemInstance.create directly', () => {
    expect(src).toMatch(/import \{ convertIntakeDraft \} from '@\/lib\/intakeConversion'/)
    expect(src).toMatch(/await convertIntakeDraft\(tx,/)
    expect(src).not.toMatch(/\.itemInstance\.create\(/)
  })

  it('itemInstance.create exists exactly once in the whole codebase — inside the shared primitive, not duplicated here', () => {
    const conversionSrc = readSrc('src/lib/intakeConversion.ts')
    expect([...conversionSrc.matchAll(/\.itemInstance\.create\(/g)].length).toBe(1)
  })
})

describe('resolveIntakeException — commercial blocker semantics (section 14, unexpected_overage)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth(); defaultLockOrderHint() })

  it('overage stays open when still over — no "accept anyway" bypass exists', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: 'unexpected_overage', catalogModelId: 'cat1' }), {
      sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ receivedQuantity: 5 }) },
      itemInstance: { count: vi.fn().mockResolvedValue(5), findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn(), create: vi.fn() },
      intakeDraft: {
        findUnique: vi.fn().mockResolvedValue(baseDraft({ workbenchExceptionCode: 'unexpected_overage', catalogModelId: 'cat1' })),
        update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve(args.data)),
        count: vi.fn().mockResolvedValue(5), // this draft + 4 others already accounted for
      },
    })
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1' })
    expect(result.ok).toBe(false)
    if (result.ok || !result.stillOpen) throw new Error('unreachable')
    expect(result.code).toBe('unexpected_overage')
  })

  it('retry succeeds once the underlying counts no longer exceed the recorded received quantity', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: 'unexpected_overage', catalogModelId: 'cat1' }), {
      sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ receivedQuantity: 10 }) },
    })
    // itemInstance.count (processed) + intakeDraft.count (exceptions, includes self) well within 10.
    ;(tx.itemInstance.count as Mock).mockResolvedValue(2)
    ;(tx.intakeDraft.count as Mock).mockResolvedValue(3)
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1' })
    expect(result.ok).toBe(true)
  })

  it('15E-review section 5/6 worked example: received=100, processed=99, exceptions=1 (this draft) — resolving it must succeed, never evaluate as if it were unit #101', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: 'unexpected_overage', catalogModelId: 'cat1' }), {
      sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ receivedQuantity: 100 }) },
    })
    ;(tx.itemInstance.count as Mock).mockResolvedValue(99)
    ;(tx.intakeDraft.count as Mock).mockResolvedValue(1)
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1' })
    expect(result.ok).toBe(true)
  })

  it('15E-review section 5/6 worked example: received=100, processed=99, exceptions=2 — a genuine second exception unit remains a commercial blocker', async () => {
    const tx = makeTx(baseDraft({ workbenchExceptionCode: 'unexpected_overage', catalogModelId: 'cat1' }), {
      sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ receivedQuantity: 100 }) },
    })
    ;(tx.itemInstance.count as Mock).mockResolvedValue(99)
    ;(tx.intakeDraft.count as Mock).mockResolvedValue(2)
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1' })
    expect(result.ok).toBe(false)
    if (result.ok || !result.stillOpen) throw new Error('unreachable')
    expect(result.code).toBe('unexpected_overage')
  })

  it('overage resolution never mutates SellerAgreement (structural — no acceptedItemCount bump, no commission mutation)', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    expect(src).not.toMatch(/sellerAgreement\.(update|create)\(/)
  })

  it('overage resolution never reassigns seller/portfolio/shipment (structural — no tx.intakeDraft.update call ever writes those fields)', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    // Every `tx.intakeDraft.update({ ... data: { ... } })` block in this file — none
    // may write sellerPortfolioId/sellerInboundShipmentId/sellerSubmissionId (those
    // are batch identity, never a per-exception "casual" field per section 14).
    const updateCalls = [...src.matchAll(/tx\.intakeDraft\.update\(\{[\s\S]*?\}\)/g)]
    expect(updateCalls.length).toBeGreaterThan(0)
    for (const m of updateCalls) {
      expect(m[0]).not.toMatch(/sellerPortfolioId:|sellerInboundShipmentId:|sellerSubmissionId:/)
    }
  })

  it('no generic "accept anyway" bypass exists anywhere in the file', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    expect(src.toLowerCase()).not.toMatch(/accept anyway|force convert|override/)
  })
})

describe('resolveIntakeException — concurrency/idempotency (section 18/19)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth(); defaultLockOrderHint() })

  it('an already-converted draft returns the existing ItemInstance — never a second one', async () => {
    const tx = makeTx(baseDraft({ status: 'converted', convertedItemId: 'item-existing' }), {
      itemInstance: {
        count: vi.fn(), findFirst: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: 'item-existing', sku: 'HW-0099' }),
        create: vi.fn(),
      },
    })
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.alreadyResolved).toBe(true)
    expect(result.itemId).toBe('item-existing')
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('retrying after a successful resolution returns the existing result (no duplicate ItemInstance)', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    const first = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(first.ok).toBe(true)

    // Second call: same tx object now has convertedItemId set from the first call.
    mockTransaction(tx)
    const second = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.alreadyResolved).toBe(true)
    expect(tx.itemInstance.create).toHaveBeenCalledTimes(1)
  })

  it('the shipment row + this draft are locked, but the 15D workbench LEASE table is never consulted (section 4)', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    expect(src).not.toMatch(/intakeWorkbenchSession/)
    expect(src).not.toMatch(/assertLeaseOwnership/)
  })

  it('locks the draft row before re-checking its state (FOR UPDATE ordering)', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    const fnStart = src.indexOf('export async function resolveIntakeException')
    const fnSrc = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    const lockIdx = fnSrc.indexOf('FOR UPDATE')
    const findIdx = fnSrc.indexOf('tx.intakeDraft.findUnique(')
    expect(lockIdx).toBeGreaterThan(-1)
    expect(findIdx).toBeGreaterThan(lockIdx)
  })

  it('15E-review section 3: locks SellerInboundShipment BEFORE IntakeDraft, matching confirmWorkbenchItem\'s lock order', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    const queryRawCalls = (tx.$queryRaw as Mock).mock.calls
    const shipmentLockCallIdx = queryRawCalls.findIndex((args) => args[0].some((s: string) => s.includes('SellerInboundShipment')))
    const draftLockCallIdx = queryRawCalls.findIndex((args) => args[0].some((s: string) => s.includes('IntakeDraft')))
    expect(shipmentLockCallIdx).toBeGreaterThan(-1)
    expect(draftLockCallIdx).toBeGreaterThan(-1)
    expect(shipmentLockCallIdx).toBeLessThan(draftLockCallIdx)
    // the shipment lock targets the draft's OWN shipment id, from the lock-order hint
    expect(queryRawCalls[shipmentLockCallIdx]).toContain('ship1')
  })

  it('15E-review section 3/4: a manual/legacy draft with no linked shipment never attempts a shipment lock at all', async () => {
    defaultLockOrderHint(null)
    const tx = makeTx(baseDraft({ sellerInboundShipmentId: null }))
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    const queryRawCalls = (tx.$queryRaw as Mock).mock.calls
    expect(queryRawCalls.some((args) => args[0].some((s: string) => s.includes('SellerInboundShipment')))).toBe(false)
    expect(queryRawCalls.some((args) => args[0].some((s: string) => s.includes('IntakeDraft')))).toBe(true)
  })

  it('15E-review section 3/6: two exception resolutions on the SAME shipment (separate drafts, separate transactions) both lock that shipment and resolve safely in serial', async () => {
    const tx1 = makeTx(baseDraft({ id: 'draftA' }))
    const tx2 = makeTx(baseDraft({ id: 'draftB' }))
    mockTransaction(tx1)
    const r1 = await resolveIntakeException({ draftId: 'draftA', catalogModelId: 'cat1' })
    mockTransaction(tx2)
    const r2 = await resolveIntakeException({ draftId: 'draftB', catalogModelId: 'cat1' })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    const shipmentLock1 = (tx1.$queryRaw as Mock).mock.calls.find((args) => args[0].some((s: string) => s.includes('SellerInboundShipment')))
    const shipmentLock2 = (tx2.$queryRaw as Mock).mock.calls.find((args) => args[0].some((s: string) => s.includes('SellerInboundShipment')))
    expect(shipmentLock1).toContain('ship1')
    expect(shipmentLock2).toContain('ship1')
    expect(tx1.itemInstance.create).toHaveBeenCalledTimes(1)
    expect(tx2.itemInstance.create).toHaveBeenCalledTimes(1)
  })

  it('15E-review section 3: two different shipments never share a lock target — each resolves against its own shipment id', async () => {
    ;(prisma.intakeDraft.findUnique as Mock)
      .mockResolvedValueOnce({ sellerInboundShipmentId: 'ship-A' })
      .mockResolvedValueOnce({ sellerInboundShipmentId: 'ship-B' })
    const txA = makeTx(baseDraft({ id: 'draftA', sellerInboundShipmentId: 'ship-A' }))
    const txB = makeTx(baseDraft({ id: 'draftB', sellerInboundShipmentId: 'ship-B' }))
    mockTransaction(txA)
    await resolveIntakeException({ draftId: 'draftA', catalogModelId: 'cat1' })
    mockTransaction(txB)
    await resolveIntakeException({ draftId: 'draftB', catalogModelId: 'cat1' })
    const shipmentLockArgsA = (txA.$queryRaw as Mock).mock.calls.find((args) => args[0].some((s: string) => s.includes('SellerInboundShipment')))
    const shipmentLockArgsB = (txB.$queryRaw as Mock).mock.calls.find((args) => args[0].some((s: string) => s.includes('SellerInboundShipment')))
    expect(shipmentLockArgsA).toContain('ship-A')
    expect(shipmentLockArgsB).toContain('ship-B')
  })
})

describe('bulkResolveIntakeExceptions — batch actions and partial success (section 20/21/22)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth(); defaultLockOrderHint() })

  it('resolves multiple drafts independently, one transaction per draft', async () => {
    const tx1 = makeTx(baseDraft({ id: 'd1' }))
    const tx2 = makeTx(baseDraft({ id: 'd2' }))
    ;(prisma.$transaction as Mock)
      .mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
      .mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx2))

    const result = await bulkResolveIntakeExceptions({ draftIds: ['d1', 'd2'], catalogModelId: 'cat1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.convertedCount).toBe(2)
    expect(result.stillOpenCount).toBe(0)
  })

  it('partial success: one failing row does not block or roll back the others', async () => {
    const tx1 = makeTx(baseDraft({ id: 'd1' }))
    const tx2 = makeTx(baseDraft({ id: 'd2', storageLocationId: null }), { storageLocation: { findUnique: vi.fn().mockResolvedValue(null) } })
    const tx3 = makeTx(baseDraft({ id: 'd3' }))
    ;(prisma.$transaction as Mock)
      .mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
      .mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx2))
      .mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx3))

    const result = await bulkResolveIntakeExceptions({ draftIds: ['d1', 'd2', 'd3'], catalogModelId: 'cat1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.convertedCount).toBe(2)
    expect(result.stillOpenCount).toBe(1)
    expect(result.results.find((r) => r.draftId === 'd2')).toMatchObject({ outcome: 'still_open', code: 'invalid_storage' })
    expect(tx1.itemInstance.create).toHaveBeenCalledTimes(1)
    expect(tx3.itemInstance.create).toHaveBeenCalledTimes(1)
  })

  it('reports per-row reasons for failures — never silently skips a row', async () => {
    const tx1 = makeTx(baseDraft({ id: 'd1', storageLocationId: null }), { storageLocation: { findUnique: vi.fn().mockResolvedValue(null) } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
    const result = await bulkResolveIntakeExceptions({ draftIds: ['d1'], catalogModelId: 'cat1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ draftId: 'd1', outcome: 'still_open' })
  })

  it('each selected id is processed exactly once, no duplicates', async () => {
    const tx1 = makeTx(baseDraft({ id: 'd1' }))
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
    const result = await bulkResolveIntakeExceptions({ draftIds: ['d1', 'd1', 'd1'], catalogModelId: 'cat1' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.results).toHaveLength(1)
  })

  it('bulk batch size is bounded — server never trusts an unbounded selection', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    expect(src).toMatch(/MAX_BULK_BATCH\s*=\s*\d+/)
    expect(src).toMatch(/\.slice\(0, MAX_BULK_BATCH\)/)
  })

  it('no browser-provided exception code is authoritative — bulk input has no "code" field, only corrections', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    const typeStart = src.indexOf('export type BulkResolveIntakeExceptionsInput')
    const typeSrc = src.slice(typeStart, src.indexOf('}', typeStart))
    expect(typeSrc).not.toMatch(/\bcode\b/)
  })

  it('admin authentication is required', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    const result = await bulkResolveIntakeExceptions({ draftIds: ['d1'] })
    expect(result.ok).toBe(false)
  })

  it('an empty selection is rejected rather than silently doing nothing', async () => {
    const result = await bulkResolveIntakeExceptions({ draftIds: [] })
    expect(result.ok).toBe(false)
  })
})

describe('resolveIntakeException — audit and privacy (section 3/31/32)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth(); defaultLockOrderHint() })

  it('writes a resolution audit event with actor from server auth context, never client-forged', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(ensureSellerLifecycleEvent).toHaveBeenCalledTimes(1)
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(call.eventType).toBe('intake_exception_resolved')
    expect(call.metadata.actor).toBe('admin')
  })

  it('resolveIntakeException accepts no actor/adminId parameter — cannot be client-forged', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    const typeStart = src.indexOf('export type ResolveIntakeExceptionInput')
    const typeSrc = src.slice(typeStart, src.indexOf('}', typeStart))
    expect(typeSrc).not.toMatch(/actor|adminId|adminUser/i)
  })

  it('original exception evidence is retained on success — workbenchExceptionCode/Note are never cleared', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    const updateCalls = (tx.intakeDraft.update as Mock).mock.calls
    for (const [args] of updateCalls) {
      expect(args.data).not.toHaveProperty('workbenchExceptionCode', null)
    }
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    expect(src).not.toMatch(/workbenchExceptionCode:\s*null/)
  })

  it('no buyer PII in the audit event', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(JSON.stringify(call)).not.toMatch(/buyerName|buyerEmail|buyerPhone/i)
  })

  it('15E-review section 1: no tx.intakeDraft.update call in this file ever writes initialException* — they are immutable, written only at first occurrence in the workbench', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    const updateCalls = [...src.matchAll(/tx\.intakeDraft\.update\(\{[\s\S]*?\}\)/g)]
    expect(updateCalls.length).toBeGreaterThan(0)
    for (const m of updateCalls) {
      expect(m[0]).not.toMatch(/initialExceptionCode:|initialExceptionNote:|initialExceptionAt:/)
    }
  })

  it('15E-review section 1: initialExceptionCode/Note are never touched by an update, even when resolution reveals a NEW blocking issue', async () => {
    // unknown_model draft; storage is ALSO invalid, so fixing the model reveals a
    // different current blocker (invalid_storage) — the original evidence must stay put.
    const tx = makeTx(baseDraft({ storageLocationId: null }), {
      storageLocation: { findUnique: vi.fn().mockResolvedValue(null) },
    })
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    expect(result.ok).toBe(false)
    if (result.ok || !result.stillOpen) throw new Error('unreachable')
    expect(result.code).toBe('invalid_storage')
    // Live/current field evolved...
    expect((tx.intakeDraft.findUnique as Mock).mock.results).toBeTruthy()
    const finalRow = await tx.intakeDraft.findUnique({ where: { id: 'draft1' } })
    expect(finalRow.workbenchExceptionCode).toBe('invalid_storage')
    // ...but the immutable original is untouched.
    expect(finalRow.initialExceptionCode).toBe('unknown_model')
    expect(finalRow.initialExceptionNote).toBe('No model resolved.')
  })

  it('15E-review section 2: audit metadata carries original vs final exception codes, and the description explains the evolution when they differ', async () => {
    const tx = makeTx(baseDraft({ storageLocationId: null }), {
      storageLocation: { findUnique: vi.fn().mockResolvedValue(null) },
    })
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(call.metadata.initialExceptionCode).toBe('unknown_model')
    expect(call.metadata.finalExceptionCode).toBe('invalid_storage')
    expect(call.adminDescription).toMatch(/unknown_model/)
    expect(call.adminDescription).toMatch(/invalid_storage/)
  })

  it('15E-review section 2: a successful resolution audit event names the original issue and the resulting item — original cause stays permanently recoverable', async () => {
    const tx = makeTx(baseDraft())
    mockTransaction(tx)
    const result = await resolveIntakeException({ draftId: 'draft1', catalogModelId: 'cat1' })
    if (!result.ok) throw new Error('unreachable')
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(call.metadata.initialExceptionCode).toBe('unknown_model')
    expect(call.adminDescription).toMatch(/unknown_model/)
    expect(call.adminDescription).toMatch(new RegExp(result.itemId))
  })

  it('15E-review section 2: repeated identical outcomes (e.g. two still-open retries with the SAME code) use the same eventKey — never a noisy duplicate event', async () => {
    const tx = makeTx(baseDraft({ storageLocationId: null }), {
      storageLocation: { findUnique: vi.fn().mockResolvedValue(null) },
    })
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1' })
    mockTransaction(tx)
    await resolveIntakeException({ draftId: 'draft1' })
    const calls = (ensureSellerLifecycleEvent as Mock).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0].eventKey).toBe(calls[1][0].eventKey)
  })
})

describe('resolveIntakeException — safety (section 15/33, structural)', () => {
  const src = readSrc('src/lib/actions/intakeExceptions.ts')

  it('no generic "Dismiss" action exists', () => {
    expect(src.toLowerCase()).not.toMatch(/dismiss/)
  })

  it('never creates a Listing (no automatic listing activation)', () => {
    expect(src).not.toMatch(/\.listing\.create\(/)
  })

  it('never updates SellerAgreement (no automatic agreement acceptance)', () => {
    expect(src).not.toMatch(/sellerAgreement\.update\(/)
  })

  it('never writes SellerPayoutLine directly — that stays exactly once, inside the shared conversion primitive', () => {
    expect(src).not.toMatch(/sellerPayoutLine\.(create|update)\(/)
  })

  it('read-only query module never mutates — reads (viewing/filtering/searching) cannot trigger a fix/conversion', () => {
    const querySrc = readSrc('src/lib/intakeExceptionQueueQuery.ts')
    expect(querySrc).not.toMatch(/convertIntakeDraft|resolveIntakeException/)
  })
})
