// 15D: behavioral coverage for confirmWorkbenchItem via the established
// $transaction(async tx => cb(tx)) mock pattern (see
// sellerAgreementsPortfolioConcurrency.test.ts) plus structural (readSrc) checks for
// invariants that a mocked transaction can't exercise directly (no full-table loads,
// no in-memory-only idempotency, no buyer PII, no listing/agreement/payout mutation
// outside the one guarded buyout-line path).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'

type Mock = ReturnType<typeof vi.fn>

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(),
    intakeWorkbenchSession: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  },
}))
vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/actions/sellerLifecycle', () => ({ ensureSellerLifecycleEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({ getPricingIntelligence: vi.fn().mockResolvedValue(null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import {
  confirmWorkbenchItem,
  getWorkbenchPricingAdvisory,
  claimWorkbenchLease,
  renewWorkbenchLease,
  releaseWorkbenchLease,
  reconcileWorkbenchShipment,
  type ConfirmWorkbenchItemInput,
} from '@/lib/actions/intakeWorkbench'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'

function baseInput(overrides: Partial<ConfirmWorkbenchItemInput> = {}): ConfirmWorkbenchItemInput {
  return {
    shipmentId: 'ship1', claimToken: 'session-a', clientToken: 'token-abc', quantity: 1,
    catalogModelId: 'cat1', condition: 'mint', cardedOrLoose: 'carded',
    conditionNotes: null, storageLocationId: 'loc1', notes: null,
    ...overrides,
  }
}

// Builds a `tx` mock covering the full happy-path call surface, including the
// shared convertIntakeDraft primitive's own calls (findUnique-then-update on
// IntakeDraft, its own catalogModel/storageLocation/itemInstance reads). intakeDraft
// and itemInstance are STATEFUL (an in-memory Map keyed by id) so the
// create-draft-then-convertIntakeDraft(draftId) sequence — which re-fetches the row
// it just created — behaves like a real transaction's read-your-writes. Individual
// tests override just the methods relevant to what they're exercising.
function makeTx(overrides: Record<string, unknown> = {}) {
  const draftStore = new Map<string, Record<string, unknown>>()
  const itemStore = new Map<string, Record<string, unknown>>()
  let draftSeq = 0
  let itemSeq = 0

  const intakeDraftCreate = vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
    const id = `draft-${draftSeq++}`
    const row: Record<string, unknown> = {
      id, status: 'draft', frontPhotoUrl: null, backPhotoUrl: null,
      brand: null, name: null, year: null, series: null, color: null, scale: null,
      condition: null, cardedOrLoose: null, conditionNotes: null, listPrice: null, notes: null,
      storageLocationId: null, catalogModelId: null, sellerSubmissionId: null, sellerInboundShipmentId: null,
      convertedItemId: null, workbenchClientToken: null, workbenchExceptionCode: null, workbenchExceptionNote: null,
      ...args.data,
    }
    draftStore.set(id, row)
    return Promise.resolve(row)
  })
  const intakeDraftFindUnique = vi.fn().mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(draftStore.get(args.where.id) ?? null))
  const intakeDraftUpdate = vi.fn().mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = draftStore.get(args.where.id)
    if (row) Object.assign(row, args.data)
    return Promise.resolve(row ?? null)
  })

  const itemInstanceCreate = vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
    const id = `item-${itemSeq++}`
    const row = {
      id, sku: args.data.sku, sellerAgreementId: args.data.sellerAgreementId ?? null,
      catalog: { brand: 'Hot Wheels', name: 'Porsche 911' }, location: { label: 'B-14-03' },
    }
    itemStore.set(id, row)
    return Promise.resolve(row)
  })
  const itemInstanceFindUnique = vi.fn().mockImplementation((args: { where: { id?: string; sku?: string } }) => {
    if (args.where.id) return Promise.resolve(itemStore.get(args.where.id) ?? null)
    if (args.where.sku) {
      for (const row of itemStore.values()) if (row.sku === args.where.sku) return Promise.resolve(row)
    }
    return Promise.resolve(null)
  })

  const base = {
    $queryRaw: vi.fn().mockResolvedValue(undefined),
    sellerInboundShipment: {
      findUnique: vi.fn().mockResolvedValue({ id: 'ship1', status: 'received', receivedQuantity: 120, sellerSubmissionId: 'sub1', sellerPortfolioId: 'port1' }),
    },
    intakeWorkbenchSession: {
      findUnique: vi.fn().mockResolvedValue(null), // no existing lease -> any claimToken can claim
      upsert: vi.fn().mockResolvedValue({}),
    },
    intakeDraft: {
      findMany: vi.fn().mockResolvedValue([]), // no existing drafts for these tokens -> not idempotent replay
      count: vi.fn().mockResolvedValue(0),
      create: intakeDraftCreate,
      findUnique: intakeDraftFindUnique,
      update: intakeDraftUpdate,
    },
    sellerAgreement: {
      findMany: vi.fn().mockResolvedValue([{ id: 'agr1', type: 'consignment', status: 'accepted', agreedBuyoutAmount: null, sellerPortfolioId: 'port1' }]),
    },
    catalogModel: {
      findUnique: vi.fn().mockResolvedValue({ id: 'cat1', brand: 'Hot Wheels', name: 'Porsche 911' }),
    },
    storageLocation: {
      findUnique: vi.fn().mockResolvedValue({ id: 'loc1', label: 'B-14-03' }),
    },
    itemInstance: {
      count: vi.fn().mockResolvedValue(0),
      // Stateful: scans itemStore for the highest existing HW- sku, matching
      // generateNextIntakeSku's real orderBy-desc-take-1 query — so a quantity>1 batch
      // (each unit's create visible to the next unit's lookup within the same tx)
      // produces genuinely sequential, distinct SKUs without per-test overrides.
      findFirst: vi.fn().mockImplementation(() => {
        let max: string | null = null
        for (const row of itemStore.values()) {
          const sku = row.sku as string
          if (sku?.startsWith('HW-') && (!max || sku > max)) max = sku
        }
        return Promise.resolve(max ? { sku: max } : null)
      }),
      findUnique: itemInstanceFindUnique,
      create: itemInstanceCreate,
    },
    sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'prof1' }) },
    sellerPayoutLine: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'line1' }) },
    photo: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
  return base
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

// vi.resetAllMocks() (called in every describe block's beforeEach below) wipes the
// module-mock factory's default `.mockResolvedValue(true)` too — re-apply it so admin
// auth passes by default in every test unless a test explicitly overrides it.
function defaultAdminAuth() {
  ;(isAdminAuthenticated as Mock).mockResolvedValue(true)
}

describe('confirmWorkbenchItem — normal flow (section 11)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('converts one physical unit: creates exactly one ItemInstance with an auto-generated SKU', async () => {
    const tx = makeTx()
    mockTransaction(tx)

    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units).toHaveLength(1)
    expect(result.units[0]).toMatchObject({ outcome: 'converted', sku: 'HW-0001' })
    expect(tx.itemInstance.create).toHaveBeenCalledTimes(1)
  })

  it('the created ItemInstance carries explicit shipment lineage (sellerInboundShipmentId) — never inferred', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await confirmWorkbenchItem(baseInput())
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.sellerInboundShipmentId).toBe('ship1')
  })

  it('batch identity (sourceType, agreement, portfolio) is inherited from the resolved agreement, never from client input', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await confirmWorkbenchItem(baseInput())
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.sourceType).toBe('consignment')
    expect(call.data.sellerAgreementId).toBe('agr1')
    expect(call.data.sellerPortfolioId).toBe('port1')
  })

  it.each([1, 2, 20])('quantity=%i expands into exactly that many distinct ItemInstances/SKUs/drafts — never one item with quantity=N, never N±1 (section 4)', async (quantity) => {
    const tx = makeTx()
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ quantity }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units).toHaveLength(quantity)
    expect(result.units.every((u) => u.outcome === 'converted')).toBe(true)
    expect(tx.itemInstance.create).toHaveBeenCalledTimes(quantity)
    expect(tx.intakeDraft.create).toHaveBeenCalledTimes(quantity)
    // Every physical unit gets its own immutable, distinct SKU — no aggregate quantity field.
    const skus = result.units.map((u) => (u as { sku: string }).sku)
    expect(new Set(skus).size).toBe(quantity)
    // Every unit preserves shipment/portfolio/agreement lineage identically.
    for (const call of (tx.itemInstance.create as Mock).mock.calls) {
      expect(call[0].data.sellerInboundShipmentId).toBe('ship1')
      expect(call[0].data.sellerAgreementId).toBe('agr1')
      expect(call[0].data.sellerPortfolioId).toBe('port1')
    }
  })

  it('retrying an already-completed quantity=20 confirm (same clientToken) replays all 20 results and creates nothing new', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    const first = await confirmWorkbenchItem(baseInput({ quantity: 20 }))
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('unreachable')
    expect(first.units).toHaveLength(20)

    // Second call: same clientToken -> same 20 unit tokens -> full idempotent-replay match.
    const replayTx = makeTx({
      intakeDraft: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 20 }, (_, i) => ({
            id: `draft-${i}`, workbenchClientToken: `token-abc:${i}`, status: 'converted',
            convertedItemId: `item-${i}`, workbenchExceptionCode: null, workbenchExceptionNote: null,
          })),
        ),
        count: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn(),
      },
      itemInstance: {
        count: vi.fn(), findFirst: vi.fn(),
        findUnique: vi.fn().mockImplementation((args: { where: { id: string } }) =>
          Promise.resolve({ id: args.where.id, sku: `HW-${args.where.id}`, catalog: { brand: 'Hot Wheels', name: 'Porsche 911' }, location: { label: 'B-14-03' } })),
        create: vi.fn(),
      },
    })
    mockTransaction(replayTx)
    const second = await confirmWorkbenchItem(baseInput({ quantity: 20 }))
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.units).toHaveLength(20)
    expect(replayTx.itemInstance.create).not.toHaveBeenCalled()
    expect(replayTx.intakeDraft.create).not.toHaveBeenCalled()
  })

  it('SKU is never accepted from client input — ConfirmWorkbenchItemInput has no sku field', () => {
    const src = readSrc('src/lib/actions/intakeWorkbench.ts')
    const typeStart = src.indexOf('export type ConfirmWorkbenchItemInput')
    const typeSrc = src.slice(typeStart, src.indexOf('}', typeStart))
    expect(typeSrc).not.toMatch(/\bsku\b/)
  })

  it('admin authentication is required', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(false)
  })

  it('shipment not yet received blocks the whole confirm with a clear error, not a silent partial conversion', async () => {
    const tx = makeTx({ sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ id: 'ship1', status: 'shipped', receivedQuantity: null, sellerSubmissionId: 'sub1', sellerPortfolioId: 'port1' }) } })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(false)
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })
})

describe('confirmWorkbenchItem — exception-in-place (section 16/17), whole shipment never stops', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('unknown model: no catalogModelId -> exception draft created, no ItemInstance, no thrown error', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ catalogModelId: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'exception', code: 'unknown_model' })
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
    expect(tx.intakeDraft.create).toHaveBeenCalledTimes(1)
  })

  it('15E-review section 1: an exception draft is created with immutable initial evidence equal to its live evidence — its first (and so far only) occurrence', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await confirmWorkbenchItem(baseInput({ catalogModelId: null }))
    const created = (tx.intakeDraft.create as Mock).mock.calls[0][0].data
    expect(created.initialExceptionCode).toBe('unknown_model')
    expect(created.initialExceptionNote).toBe(created.workbenchExceptionNote)
    expect(created.initialExceptionAt).toBeInstanceOf(Date)
  })

  it('a catalogModelId that no longer resolves (deleted concurrently) becomes an exception, not a hard failure', async () => {
    const tx = makeTx({ catalogModel: { findUnique: vi.fn().mockResolvedValue(null) } })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'exception', code: 'unknown_model' })
  })

  it('invalid storage: unresolved storageLocationId -> exception, browser-supplied id is re-validated server-side', async () => {
    const tx = makeTx({ storageLocation: { findUnique: vi.fn().mockResolvedValue(null) } })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ storageLocationId: 'does-not-exist' }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'exception', code: 'invalid_storage' })
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('missing storageLocationId altogether is also an exception, not a crash', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ storageLocationId: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'exception', code: 'invalid_storage' })
  })

  it('unexpected overage: confirming beyond the received total is flagged, not silently accepted', async () => {
    const tx = makeTx({
      sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ id: 'ship1', status: 'received', receivedQuantity: 5, sellerSubmissionId: 'sub1', sellerPortfolioId: 'port1' }) },
      itemInstance: {
        count: vi.fn().mockResolvedValue(5), // already fully accounted for
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      intakeDraft: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'd1', ...args.data })),
      },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'exception', code: 'unexpected_overage' })
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('overage is never checked against expectedQuantity — only against the admin-confirmed receivedQuantity', async () => {
    // received is null (not yet confirmed) -> overage can never fire regardless of expected.
    const tx = makeTx({
      sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ id: 'ship1', status: 'issue', receivedQuantity: null, sellerSubmissionId: 'sub1', sellerPortfolioId: 'port1' }) },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0].outcome).toBe('converted')
  })

  it('missing condition/cardedOrLoose becomes an exception rather than a thrown validation error', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ condition: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'exception', code: 'missing_condition' })
  })

  it('a quantity=5 batch routed to exception creates 5 IntakeDraft rows — physical-unit accounting, not one row per action (section 5)', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ quantity: 5, catalogModelId: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units).toHaveLength(5)
    expect(result.units.every((u) => u.outcome === 'exception')).toBe(true)
    expect(tx.intakeDraft.create).toHaveBeenCalledTimes(5)
    // Each exception draft has its own distinct workbenchClientToken (its own physical identity).
    const tokens = (tx.intakeDraft.create as Mock).mock.calls.map((c) => c[0].data.workbenchClientToken)
    expect(new Set(tokens).size).toBe(5)
  })

  it('15E-review section 1: the conversion_failed rescue (rare race on the normal path) also writes initial evidence — the draft had none until this, its first transition', async () => {
    const tx = makeTx({
      storageLocation: { findUnique: vi.fn().mockResolvedValueOnce({ id: 'loc1', label: 'B-14-03' }).mockResolvedValue(null) },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'exception', code: 'conversion_failed' })
    const updateCalls = (tx.intakeDraft.update as Mock).mock.calls
    const rescueCall = updateCalls.find(([args]) => args.data.workbenchExceptionCode === 'conversion_failed')
    expect(rescueCall).toBeTruthy()
    expect(rescueCall![0].data.initialExceptionCode).toBe('conversion_failed')
    expect(rescueCall![0].data.initialExceptionAt).toBeInstanceOf(Date)
  })

  it('an eligibility failure (e.g. no accepted agreement) is a form-level error, not per-unit — nothing is created', async () => {
    const tx = makeTx({ sellerAgreement: { findMany: vi.fn().mockResolvedValue([]) } })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(false)
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
    expect(tx.intakeDraft.create).not.toHaveBeenCalled()
  })
})

describe('confirmWorkbenchItem — idempotency (section 12/21)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('an exact retry (same clientToken, full match found) replays the prior result and creates nothing new', async () => {
    const tx = makeTx({
      intakeDraft: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'draft1', workbenchClientToken: 'token-abc:0', status: 'converted', convertedItemId: 'item1', workbenchExceptionCode: null, workbenchExceptionNote: null },
        ]),
        count: vi.fn(), create: vi.fn(),
      },
      itemInstance: {
        count: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: 'item1', sku: 'HW-0001', catalog: { brand: 'Hot Wheels', name: 'Porsche 911' }, location: { label: 'B-14-03' } }),
        create: vi.fn(),
      },
    })
    mockTransaction(tx)

    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.units[0]).toMatchObject({ outcome: 'converted', sku: 'HW-0001' })
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
    expect(tx.intakeDraft.create).not.toHaveBeenCalled()
  })

  it('a partial match (some but not all unit tokens already exist) is treated as a conflict, never silently creates the missing half', async () => {
    const tx = makeTx({
      intakeDraft: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'draft1', workbenchClientToken: 'token-abc:0', status: 'converted', convertedItemId: 'item1', workbenchExceptionCode: null, workbenchExceptionNote: null },
        ]),
        count: vi.fn(), create: vi.fn(),
      },
    })
    mockTransaction(tx)

    const result = await confirmWorkbenchItem(baseInput({ quantity: 2 }))
    expect(result.ok).toBe(false)
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('a concurrent duplicate that slips past the pre-check and hits the unique constraint (P2002) fails cleanly, not with a duplicate item', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' })
    })
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(false)
  })

  it('idempotency is enforced via the DB unique constraint (schema) — this file has no module-scope cache variable used across requests', () => {
    const src = readSrc('src/lib/actions/intakeWorkbench.ts')
    // No `const cache = new Map()` / `new Set()` declared at module top level (outside
    // any function) — the only `new Map(` usage is a local, per-call lookup built fresh
    // from a fresh DB read inside confirmWorkbenchItem, not a persistent in-memory store.
    const moduleLevel = src.slice(0, src.indexOf('export async function confirmWorkbenchItem'))
    expect(moduleLevel).not.toMatch(/new (Set|Map)\(/)
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toMatch(/@@unique\(\[sellerInboundShipmentId, workbenchClientToken\]\)/)
  })

  it('unit tokens are deterministic from the single client token, so a retried confirm regenerates the exact same lookup key', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    await confirmWorkbenchItem(baseInput({ quantity: 2 }))
    const call = (tx.intakeDraft.findMany as Mock).mock.calls[0][0]
    expect(call.where.workbenchClientToken.in).toEqual(['token-abc:0', 'token-abc:1'])
  })
})

describe('confirmWorkbenchItem — lease enforcement, the actual multi-admin write guard (15D-review section 2)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('same claimToken retried (e.g. a heartbeat renewal landing mid-confirm) is always allowed — a session never blocks itself', async () => {
    const tx = makeTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-a', expiresAt: new Date(Date.now() + 60_000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ claimToken: 'session-a' }))
    expect(result.ok).toBe(true)
  })

  it('different clientTokens under the SAME valid claimToken are legitimate separate physical actions, not blocked by the lease', async () => {
    const tx = makeTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-a', expiresAt: new Date(Date.now() + 60_000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    mockTransaction(tx)
    const r1 = await confirmWorkbenchItem(baseInput({ claimToken: 'session-a', clientToken: 'item-1' }))
    const r2 = await confirmWorkbenchItem(baseInput({ claimToken: 'session-a', clientToken: 'item-2' }))
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  it('a second session cannot confirm while the first session\'s lease is still active — this is what actually stops two admins independently processing the same shipment (clientToken alone would not)', async () => {
    const tx = makeTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-a', expiresAt: new Date(Date.now() + 60_000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ claimToken: 'session-b' }))
    expect(result.ok).toBe(false)
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
    expect(tx.intakeDraft.create).not.toHaveBeenCalled()
  })

  it('an EXPIRED lease can be taken over implicitly by any session — a stale claim never permanently blocks work', async () => {
    const tx = makeTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-a', expiresAt: new Date(Date.now() - 1000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ claimToken: 'session-b' }))
    expect(result.ok).toBe(true)
    expect(tx.intakeWorkbenchSession.upsert).toHaveBeenCalledTimes(1)
    const upsertArgs = (tx.intakeWorkbenchSession.upsert as Mock).mock.calls[0][0]
    expect(upsertArgs.update.claimToken).toBe('session-b')
  })

  it('after an explicit takeover updates the lease row to a new claimToken, the stale former holder\'s next confirm is rejected', async () => {
    // Simulates: admin A held the lease, admin B explicitly took over (claimWorkbenchLease
    // with takeover=true), which already updated the DB row to claimToken='session-b'.
    // Admin A's browser, unaware, tries to confirm again with its old token.
    const tx = makeTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-b', expiresAt: new Date(Date.now() + 60_000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ claimToken: 'session-a' }))
    expect(result.ok).toBe(false)
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('a pure idempotent replay (all unit tokens already exist) succeeds regardless of which session currently holds the lease — replay never contends for the lease', async () => {
    const tx = makeTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-b', expiresAt: new Date(Date.now() + 60_000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      intakeDraft: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'draft1', workbenchClientToken: 'token-abc:0', status: 'converted', convertedItemId: 'item1', workbenchExceptionCode: null, workbenchExceptionNote: null },
        ]),
        count: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn(),
      },
      itemInstance: {
        count: vi.fn(), findFirst: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: 'item1', sku: 'HW-0001', catalog: { brand: 'Hot Wheels', name: 'Porsche 911' }, location: { label: 'B-14-03' } }),
        create: vi.fn(),
      },
    })
    mockTransaction(tx)
    // A DIFFERENT, stale claimToken from the session that originally created these drafts.
    const result = await confirmWorkbenchItem(baseInput({ claimToken: 'session-a-now-stale' }))
    expect(result.ok).toBe(true)
    expect(tx.intakeWorkbenchSession.findUnique).not.toHaveBeenCalled()
  })

  it('an active lease on a DIFFERENT shipment never blocks this one — the lease is scoped per shipment', async () => {
    const tx = makeTx()
    mockTransaction(tx)
    // tx.intakeWorkbenchSession.findUnique is called with a where clause scoped to
    // THIS shipment; the mock's default (no existing row) proves an unrelated
    // shipment's lease was never consulted for this confirm.
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    const call = (tx.intakeWorkbenchSession.findUnique as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ sellerInboundShipmentId: 'ship1' })
  })

  it('confirm requires a claimToken at all — a request with none is rejected before touching the database', async () => {
    const result = await confirmWorkbenchItem(baseInput({ claimToken: '' }))
    expect(result.ok).toBe(false)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('confirmWorkbenchItem — buyout payout dedup (existing 15A/15C semantics preserved)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('creates the agreement-level buyout payout line exactly once even across multiple units in one confirm', async () => {
    const tx = makeTx({
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'agr1', type: 'buyout', status: 'accepted', agreedBuyoutAmount: new Prisma.Decimal('500.00'), sellerPortfolioId: 'port1' }]) },
    })
    mockTransaction(tx)
    // First call: no existing line. Second+ calls (2nd unit in the same confirm): already exists.
    ;(tx.sellerPayoutLine.findUnique as Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'line1' })

    const result = await confirmWorkbenchItem(baseInput({ quantity: 2 }))
    expect(result.ok).toBe(true)
    expect(tx.sellerPayoutLine.create).toHaveBeenCalledTimes(1)
  })

  it('15D-review (financial pass) section 1: a SOLE buyout item still leaves purchasePrice unallocated — agreedBuyoutAmount is documented as the total for the whole agreement, never a per-item price (Case B, no per-item allocation rule exists)', async () => {
    const tx = makeTx({
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'agr1', type: 'buyout', status: 'accepted', agreedBuyoutAmount: new Prisma.Decimal('500.00'), sellerPortfolioId: 'port1' }]) },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput())
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBeUndefined()
  })

  it('every unit in a multi-unit buyout batch leaves purchasePrice unallocated — never assigns the total to one arbitrary first item', async () => {
    const tx = makeTx({
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'agr1', type: 'buyout', status: 'accepted', agreedBuyoutAmount: new Prisma.Decimal('500.00'), sellerPortfolioId: 'port1' }]) },
    })
    mockTransaction(tx)
    const result = await confirmWorkbenchItem(baseInput({ quantity: 3 }))
    expect(result.ok).toBe(true)
    const calls = (tx.itemInstance.create as Mock).mock.calls
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call[0].data.purchasePrice).toBeUndefined()
    }
    // The agreement-level SellerPayoutLine (recorded once, see the dedup test above)
    // remains the authoritative buyout financial record — unaffected by unit count.
  })
})

describe('getWorkbenchPricingAdvisory (14C reuse, section 18/19)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('returns null when 14C has no intelligence for the model (never fabricated)', async () => {
    ;(getPricingIntelligence as Mock).mockResolvedValueOnce(null)
    expect(await getWorkbenchPricingAdvisory('cat1')).toBeNull()
  })

  it('passes through isAskOnly and confidence verbatim from 14C', async () => {
    ;(getPricingIntelligence as Mock).mockResolvedValueOnce({
      estimatedValueCents: 1850, isAskOnly: true,
      recommendedListing: { lowCents: 1700, targetCents: 1900, highCents: 2100 },
      confidence: { level: 'medium', score: 60, reasons: [] },
    })
    const advisory = await getWorkbenchPricingAdvisory('cat1', 'strong')
    expect(advisory).toMatchObject({ estimatedValueCents: 1850, isAskOnly: true, confidence: 'medium' })
  })

  it('admin authentication is required', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    expect(await getWorkbenchPricingAdvisory('cat1')).toBeNull()
  })
})

describe('lease actions (section 21)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('claiming an unclaimed shipment succeeds and marks the caller as the holder', async () => {
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce(null)
    ;(prisma.intakeWorkbenchSession.upsert as Mock).mockResolvedValueOnce({ expiresAt: new Date(Date.now() + 300_000) })
    const result = await claimWorkbenchLease('ship1', 'tab-a')
    expect(result).toMatchObject({ held: true, heldByMe: true })
  })

  it('claiming a shipment actively held by another session (no takeover) reports held-by-other, does not overwrite it', async () => {
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce({ claimToken: 'tab-b', expiresAt: new Date(Date.now() + 300_000) })
    const result = await claimWorkbenchLease('ship1', 'tab-a')
    expect(result).toMatchObject({ held: true, heldByMe: false })
    expect(prisma.intakeWorkbenchSession.upsert).not.toHaveBeenCalled()
  })

  it('an expired lease can be claimed without an explicit takeover flag', async () => {
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce({ claimToken: 'tab-b', expiresAt: new Date(Date.now() - 1000) })
    ;(prisma.intakeWorkbenchSession.upsert as Mock).mockResolvedValueOnce({ expiresAt: new Date(Date.now() + 300_000) })
    const result = await claimWorkbenchLease('ship1', 'tab-a')
    expect(result.heldByMe).toBe(true)
  })

  it('explicit takeover overwrites an actively-held lease', async () => {
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce({ claimToken: 'tab-b', expiresAt: new Date(Date.now() + 300_000) })
    ;(prisma.intakeWorkbenchSession.upsert as Mock).mockResolvedValueOnce({ expiresAt: new Date(Date.now() + 300_000) })
    const result = await claimWorkbenchLease('ship1', 'tab-a', true)
    expect(result.heldByMe).toBe(true)
    expect(prisma.intakeWorkbenchSession.upsert).toHaveBeenCalledTimes(1)
  })

  it('renew only succeeds for the current holder\'s own claim token', async () => {
    ;(prisma.intakeWorkbenchSession.updateMany as Mock).mockResolvedValueOnce({ count: 0 })
    ;(prisma.intakeWorkbenchSession.findUnique as Mock).mockResolvedValueOnce(null)
    const result = await renewWorkbenchLease('ship1', 'stale-token')
    expect(result.heldByMe).toBe(false)
  })

  it('release only removes the caller\'s own claim', async () => {
    await releaseWorkbenchLease('ship1', 'tab-a')
    expect(prisma.intakeWorkbenchSession.deleteMany).toHaveBeenCalledWith({ where: { sellerInboundShipmentId: 'ship1', claimToken: 'tab-a' } })
  })
})

describe('confirmWorkbenchItem — safety boundaries (section 24/29, structural)', () => {
  const src = readSrc('src/lib/actions/intakeWorkbench.ts')

  it('never creates a Listing (no automatic listing activation)', () => {
    expect(src).not.toMatch(/\.listing\.create\(/)
  })

  it('never updates SellerAgreement (no automatic agreement acceptance, no signed commission mutation)', () => {
    expect(src).not.toMatch(/sellerAgreement\.update\(/)
  })

  it('this file writes no SellerPayoutLine directly — that behavior lives exactly once in the shared conversion primitive (no consignment payout auto-creation, no duplicated buyout logic)', () => {
    expect(src).not.toMatch(/sellerPayoutLine\.(create|update)\(/)
    const conversionSrc = readSrc('src/lib/intakeConversion.ts')
    const occurrences = [...conversionSrc.matchAll(/sellerPayoutLine\.create\(/g)]
    expect(occurrences.length).toBe(1)
  })

  it('never writes SellerInboundShipment.receivedQuantity — consumes it, never increments it (section 14)', () => {
    expect(src).not.toMatch(/sellerInboundShipment\.update\(/)
  })

  it('reads no buyer PII field (buyerEmail/buyerName/buyerPhone) anywhere in this file', () => {
    expect(src).not.toMatch(/buyerName|buyerEmail|buyerPhone/i)
  })

  it('every mutating step happens inside the single $transaction call — no writes issued outside it before the post-commit lifecycle events', () => {
    const fnStart = src.indexOf('export async function confirmWorkbenchItem')
    const fnEnd = src.indexOf('\nexport async function', fnStart + 1)
    const fnSrc = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
    const txStart = fnSrc.indexOf('await prisma.$transaction(')
    const txEnd = fnSrc.indexOf('}, { timeout: 20_000 })', txStart)
    const afterTx = fnSrc.slice(txEnd)
    // Only lifecycle events (idempotent, non-blocking) and revalidatePath calls after the tx.
    expect(afterTx).not.toMatch(/tx\.|prisma\.(itemInstance|intakeDraft|sellerAgreement|sellerPayoutLine)\.(create|update|delete)/)
  })

  it('detectItemContradictions is never called from here — multiple-completed-sales / exception detection for SOLD items stays 15C\'s job, not intake\'s', () => {
    expect(src).not.toMatch(/detectItemContradictions/)
  })
})

describe('IntakeWorkbench.tsx — catalog identification reuse (section 7, structural)', () => {
  const src = readSrc('src/components/admin/IntakeWorkbench.tsx')

  it('reuses the existing 12E-A CatalogModelCombobox — no fourth catalog matcher is built', () => {
    expect(src).toMatch(/import \{ CatalogModelCombobox \} from '@\/components\/admin\/CatalogModelCombobox'/)
    expect(src).toMatch(/<CatalogModelCombobox/)
  })

  it('reuses the existing 12G-C admin image-match action rather than a new matcher', () => {
    expect(src).toMatch(/import \{ adminSearchCatalogByImage \} from '@\/lib\/actions\/catalogImageMatching'/)
  })

  it('a picked image-match candidate only sets the pending selection — it never calls handleConfirm/auto-submits', () => {
    const fnStart = src.indexOf('function pickImageCandidate')
    const fnSrc = src.slice(fnStart, src.indexOf('\n  }', fnStart))
    expect(fnSrc).not.toMatch(/handleConfirm/)
  })

  it('a combobox text-search selection only sets the pending selection — it never auto-submits either', () => {
    const fnStart = src.indexOf('function onModelSelect')
    const fnSrc = src.slice(fnStart, src.indexOf('\n  }', fnStart))
    expect(fnSrc).not.toMatch(/handleConfirm/)
  })

  it('Confirm & Next is disabled until a model AND a resolved storage location are both selected — a low-confidence suggestion alone can never convert', () => {
    expect(src).toMatch(/canConfirm = !!catalog && !!storageResolved/)
  })
})

describe('confirmWorkbenchItem — duplicate CatalogModel is not mistaken for a physical duplicate (section 15)', () => {
  const src = readSrc('src/lib/actions/intakeWorkbench.ts')

  it('there is no exception code or check for "same catalog model appears more than once" — only the technical (clientToken) and overage checks exist', () => {
    expect(src).not.toMatch(/duplicate_catalog|repeated_model|same_model/)
  })

  it('the only pre-classification exception codes are the documented ones — no probabilistic physical-duplicate guess', async () => {
    const codes = [...src.matchAll(/exceptionCode = '([a-z_]+)'/g)].map((m) => m[1])
    expect(new Set(codes)).toEqual(new Set(['unknown_model', 'invalid_storage', 'missing_condition', 'unexpected_overage']))
  })

  it('the only OTHER exception code is conversion_failed — the rare-race fallback when the shared converter itself rejects an already-classified-normal unit (section 7)', () => {
    expect(src).toMatch(/workbenchExceptionCode: 'conversion_failed'/)
  })
})

// ─── Reconciliation ("Finish intake") — 15D-review reconciliation pass ─────────────

function makeReconcileTx(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(undefined),
    sellerInboundShipment: {
      findUnique: vi.fn().mockResolvedValue({ id: 'ship1', status: 'received', receivedQuantity: 200, sellerSubmissionId: 'sub1' }),
    },
    intakeWorkbenchSession: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    itemInstance: { count: vi.fn().mockResolvedValue(197) },
    intakeDraft: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
    ...overrides,
  }
}

describe('reconcileWorkbenchShipment — counts and variance (section 2/3)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('exact match: observedPhysical === recordedReceived -> variance 0', async () => {
    const tx = makeReconcileTx({ itemInstance: { count: vi.fn().mockResolvedValue(200) }, intakeDraft: { count: vi.fn().mockResolvedValue(0), create: vi.fn() } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    const result = await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(result).toMatchObject({ ok: true, recordedReceived: 200, observedPhysical: 200, variance: 0, hasUnresolvedExceptions: false })
  })

  it('shortage: fewer physical units observed than recorded received -> negative variance, explicitly surfaced (never silently absorbed)', async () => {
    const tx = makeReconcileTx({ itemInstance: { count: vi.fn().mockResolvedValue(194) }, intakeDraft: { count: vi.fn().mockResolvedValue(3), create: vi.fn() } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    const result = await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(result).toMatchObject({ ok: true, recordedReceived: 200, observedPhysical: 197, variance: -3, hasUnresolvedExceptions: true })
  })

  it('overage: more physical units observed than recorded received -> positive variance', async () => {
    const tx = makeReconcileTx({ itemInstance: { count: vi.fn().mockResolvedValue(203) }, intakeDraft: { count: vi.fn().mockResolvedValue(0), create: vi.fn() } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    const result = await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(result).toMatchObject({ ok: true, observedPhysical: 203, variance: 3 })
  })

  it('observedPhysical = processed + exceptions exactly — unresolved exception units are counted as observed, never dropped', async () => {
    const tx = makeReconcileTx({ itemInstance: { count: vi.fn().mockResolvedValue(194) }, intakeDraft: { count: vi.fn().mockResolvedValue(3), create: vi.fn() } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    const result = await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(result).toMatchObject({ ok: true, observedPhysical: 197, hasUnresolvedExceptions: true })
  })

  it('cannot reconcile a shipment with no recorded received quantity — nothing to reconcile against', async () => {
    const tx = makeReconcileTx({ sellerInboundShipment: { findUnique: vi.fn().mockResolvedValue({ id: 'ship1', status: 'received', receivedQuantity: null, sellerSubmissionId: 'sub1' }) } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    const result = await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(result.ok).toBe(false)
  })

  it('persists reconciliation evidence via the existing lifecycle-event infrastructure with who/when/recordedReceived/observedPhysical/variance/hadUnresolvedExceptions (section 4)', async () => {
    const tx = makeReconcileTx({ itemInstance: { count: vi.fn().mockResolvedValue(194) }, intakeDraft: { count: vi.fn().mockResolvedValue(3), create: vi.fn() } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(ensureSellerLifecycleEvent).toHaveBeenCalledTimes(1)
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(call).toMatchObject({
      eventType: 'shipment_intake_reconciled',
      sourceEntityType: 'SellerInboundShipment', sourceEntityId: 'ship1',
      sellerVisible: false,
      metadata: { recordedReceived: 200, observedPhysical: 197, variance: -3, hasUnresolvedExceptions: true, actor: 'admin' },
    })
    expect(call.occurredAt).toBeInstanceOf(Date)
  })

  it('no buyer PII in the persisted evidence — only counts and admin attribution', async () => {
    const tx = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    await reconcileWorkbenchShipment('ship1', 'session-a')
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(JSON.stringify(call)).not.toMatch(/buyerName|buyerEmail|buyerPhone/i)
  })
})

describe('reconcileWorkbenchShipment — actor attribution (15D-review final approval pass, section 2)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('records the authenticated admin actor ("admin" — this codebase\'s actual, already-established convention; no per-admin identity infrastructure exists, confirmed by inspection: no AdminUser model, one shared ADMIN_PASSWORD)', async () => {
    const tx = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    await reconcileWorkbenchShipment('ship1', 'session-a')
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(call.metadata.actor).toBe('admin')
  })

  it('actor cannot be supplied or forged from client input — reconcileWorkbenchShipment has no actor/adminId parameter at all', () => {
    const src = readSrc('src/lib/actions/intakeWorkbench.ts')
    const sigMatch = src.match(/export async function reconcileWorkbenchShipment\(([^)]*)\)/)
    expect(sigMatch).not.toBeNull()
    expect(sigMatch![1]).not.toMatch(/actor|adminId|adminUser/i)
  })

  it('the actor value is a fixed literal, never derived from claimToken (a client-generated, non-authenticated session/tab token, not an identity)', async () => {
    const tx = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    await reconcileWorkbenchShipment('ship1', 'attacker-supplied-claim-token-as-fake-identity')
    const call = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0]
    expect(call.metadata.actor).toBe('admin')
    expect(call.metadata.actor).not.toContain('attacker-supplied-claim-token-as-fake-identity')
  })

  it('two DIFFERENT sessions reconciling the SAME true physical state both correctly attribute to "admin" (this system genuinely cannot distinguish admins — attribution is honest, not fabricated as falsely distinct)', async () => {
    const tx1 = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
    await reconcileWorkbenchShipment('ship1', 'session-a')

    const tx2 = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx2))
    await reconcileWorkbenchShipment('ship1', 'session-b')

    const actor1 = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0].metadata.actor
    const actor2 = (ensureSellerLifecycleEvent as Mock).mock.calls[1][0].metadata.actor
    expect(actor1).toBe('admin')
    expect(actor2).toBe('admin')
  })

  it('a genuinely CHANGED physical state after a takeover produces a fresh snapshot that still retains actor attribution, keyed independently of who reconciled', async () => {
    // First reconciliation (pre-takeover state: 197 observed).
    const tx1 = makeReconcileTx({ itemInstance: { count: vi.fn().mockResolvedValue(194) }, intakeDraft: { count: vi.fn().mockResolvedValue(3), create: vi.fn() } })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
    await reconcileWorkbenchShipment('ship1', 'session-a')

    // Takeover admin continues processing; state changes (200 observed now), then reconciles again.
    const tx2 = makeReconcileTx({
      itemInstance: { count: vi.fn().mockResolvedValue(200) },
      intakeDraft: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      intakeWorkbenchSession: { findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-b', expiresAt: new Date(Date.now() + 60_000) }), upsert: vi.fn().mockResolvedValue({}) },
    })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx2))
    const second = await reconcileWorkbenchShipment('ship1', 'session-b')

    expect(second.ok).toBe(true)
    expect(ensureSellerLifecycleEvent).toHaveBeenCalledTimes(2)
    const key1 = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0].eventKey
    const key2 = (ensureSellerLifecycleEvent as Mock).mock.calls[1][0].eventKey
    expect(key1).not.toBe(key2) // genuinely different observed state -> a distinct, superseding snapshot
    expect((ensureSellerLifecycleEvent as Mock).mock.calls[1][0].metadata.actor).toBe('admin')
  })

  it('idempotency is keyed by physical STATE (shipment/recordedReceived/observedPhysical), never by actor — an accidental double-click cannot create a duplicate snapshot', async () => {
    const tx1 = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
    await reconcileWorkbenchShipment('ship1', 'session-a')

    const tx2 = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx2))
    await reconcileWorkbenchShipment('ship1', 'session-a')

    const key1 = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0].eventKey
    const key2 = (ensureSellerLifecycleEvent as Mock).mock.calls[1][0].eventKey
    expect(key1).toBe(key2)
    expect(key1).not.toMatch(/admin/) // actor is not part of the idempotency key
  })
})

describe('reconcileWorkbenchShipment — never fabricates or mutates commercial state (section 2/3)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('creates no IntakeDraft rows — never fabricates missing physical items to make counts match', async () => {
    const tx = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(tx.intakeDraft.create).not.toHaveBeenCalled()
  })

  it('this action never writes SellerAgreement, SellerPortfolio, or SellerInboundShipment.receivedQuantity — structural', () => {
    const src = readSrc('src/lib/actions/intakeWorkbench.ts')
    const fnStart = src.indexOf('export async function reconcileWorkbenchShipment')
    const fnSrc = src.slice(fnStart)
    expect(fnSrc).not.toMatch(/sellerAgreement\.(update|create)\(/)
    expect(fnSrc).not.toMatch(/sellerPortfolio\.(update|create)\(/)
    expect(fnSrc).not.toMatch(/sellerInboundShipment\.update\(/)
  })

  it('retrying with unchanged state is safe — ensureSellerLifecycleEvent is called (its own idempotent eventKey dedup applies), not a second distinct write path', async () => {
    const tx1 = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx1))
    const first = await reconcileWorkbenchShipment('ship1', 'session-a')

    const tx2 = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx2))
    const second = await reconcileWorkbenchShipment('ship1', 'session-a')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(first.observedPhysical).toBe(second.observedPhysical)
    expect(first.variance).toBe(second.variance)
    // Same eventKey both times (same shipment/received/observed) — the same idempotent key.
    const key1 = (ensureSellerLifecycleEvent as Mock).mock.calls[0][0].eventKey
    const key2 = (ensureSellerLifecycleEvent as Mock).mock.calls[1][0].eventKey
    expect(key1).toBe(key2)
  })
})

describe('reconcileWorkbenchShipment — lease/concurrency (section 5)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('a stale session (lease actively held by a different, newer claimToken) cannot reconcile', async () => {
    const tx = makeReconcileTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-b', expiresAt: new Date(Date.now() + 60_000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    const result = await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(result.ok).toBe(false)
    expect(ensureSellerLifecycleEvent).not.toHaveBeenCalled()
  })

  it('an expired lease can still be reconciled by any session (never permanently blocks)', async () => {
    const tx = makeReconcileTx({
      intakeWorkbenchSession: {
        findUnique: vi.fn().mockResolvedValue({ claimToken: 'session-b', expiresAt: new Date(Date.now() - 1000) }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    const result = await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(result.ok).toBe(true)
  })

  it('reconciliation uses the same shipment-row serialization boundary (FOR UPDATE lock) as confirmWorkbenchItem', async () => {
    const tx = makeReconcileTx()
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
    await reconcileWorkbenchShipment('ship1', 'session-a')
    expect(tx.$queryRaw).toHaveBeenCalled()
  })

  it('requires a claimToken — a request with none is rejected before touching the database', async () => {
    const result = await reconcileWorkbenchShipment('ship1', '')
    expect(result.ok).toBe(false)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
