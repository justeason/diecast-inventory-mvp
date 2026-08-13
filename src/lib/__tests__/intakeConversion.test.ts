// 15D-review section 1: behavioral coverage for the ONE authoritative
// IntakeDraft -> ItemInstance conversion primitive, called by both actions/intake.ts
// (convertDraft) and actions/intakeWorkbench.ts (confirmWorkbenchItem). Uses the same
// `tx` mock pattern as the callers' own test suites (no real transaction available).
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import { convertIntakeDraft } from '@/lib/intakeConversion'

type Mock = ReturnType<typeof vi.fn>

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

function makeDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft1', status: 'reviewed',
    brand: 'Hot Wheels', name: 'Porsche 911', year: 2024, series: null, color: null, scale: null,
    condition: 'mint', cardedOrLoose: 'carded', conditionNotes: null, listPrice: null, notes: null,
    frontPhotoUrl: null, backPhotoUrl: null,
    storageLocationId: null, catalogModelId: null,
    sellerSubmissionId: null, sellerInboundShipmentId: null, convertedItemId: null,
    ...overrides,
  }
}

function makeTx(draftRow: ReturnType<typeof makeDraftRow>, overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(undefined),
    intakeDraft: {
      findUnique: vi.fn().mockResolvedValue(draftRow),
      update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ ...draftRow, ...args.data })),
    },
    catalogModel: {
      findUnique: vi.fn().mockResolvedValue({ id: 'cat1', brand: 'Hot Wheels', name: 'Porsche 911' }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'cat-new', brand: 'Hot Wheels', name: 'Porsche 911' }),
    },
    storageLocation: { findUnique: vi.fn().mockResolvedValue({ id: 'loc1' }) },
    itemInstance: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'item1', ...args.data })),
    },
    sellerAgreement: { findMany: vi.fn().mockResolvedValue([]) },
    sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'prof1' }) },
    sellerPayoutLine: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'line1' }) },
    photo: { create: vi.fn().mockResolvedValue({}) },
    listing: { create: vi.fn().mockResolvedValue({ id: 'listing1', version: 1 }) },
    ...overrides,
  }
}

vi.mock('@/lib/buyerAlertsTrigger', () => ({ createAvailableFanoutJob: vi.fn().mockResolvedValue(undefined) }))

describe('convertIntakeDraft — draft-state gating', () => {
  it('rejects a draft that is not in "reviewed" status — never converts twice', async () => {
    const tx = makeTx(makeDraftRow({ status: 'converted', convertedItemId: 'item-old' }))
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(false)
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('a missing draft is a clean error, not a crash', async () => {
    const tx = makeTx(makeDraftRow(), { intakeDraft: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() } })
    const result = await convertIntakeDraft(tx as never, { draftId: 'nope', locationId: 'loc1' })
    expect(result.ok).toBe(false)
  })

  it('requires either an exact catalogModelId (draft or option) OR legacy brand/name — a workbench-style draft with neither is rejected, not silently guessed', async () => {
    const tx = makeTx(makeDraftRow({ brand: null, name: null, catalogModelId: null }))
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(false)
  })

  it('a draft resolved via catalogModelId (workbench path) converts even with brand/name null', async () => {
    const tx = makeTx(makeDraftRow({ brand: null, name: null, catalogModelId: 'cat1' }))
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
  })
})

describe('convertIntakeDraft — exactly one ItemInstance, exactly one link (section 1/7)', () => {
  it('on success, creates exactly one ItemInstance and marks the draft converted+linked in the same call', async () => {
    const tx = makeTx(makeDraftRow())
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1', sku: 'HW-9999' })
    expect(result.ok).toBe(true)
    expect(tx.itemInstance.create).toHaveBeenCalledTimes(1)
    expect(tx.intakeDraft.update).toHaveBeenCalledWith({ where: { id: 'draft1' }, data: { status: 'converted', convertedItemId: 'item1' } })
  })

  it('adding a new required-field check to the shared converter protects both callers automatically (proof: missing condition is rejected here, at the single source)', async () => {
    const tx = makeTx(makeDraftRow({ condition: null }))
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(false)
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })

  it('a failure partway through (e.g. storage deleted) never marks the draft converted — no ambiguous partial state', async () => {
    const tx = makeTx(makeDraftRow(), { storageLocation: { findUnique: vi.fn().mockResolvedValue(null) } })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(false)
    expect(tx.intakeDraft.update).not.toHaveBeenCalled()
    expect(tx.itemInstance.create).not.toHaveBeenCalled()
  })
})

describe('convertIntakeDraft — lineage: shipment/portfolio/agreement carried through identically for both callers', () => {
  it('copies sellerInboundShipmentId from the draft onto the ItemInstance verbatim (section 2)', async () => {
    const tx = makeTx(makeDraftRow({ sellerInboundShipmentId: 'ship1' }))
    await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.sellerInboundShipmentId).toBe('ship1')
  })

  it('a legacy (non-shipment) draft leaves sellerInboundShipmentId unset — never guessed', async () => {
    const tx = makeTx(makeDraftRow({ sellerInboundShipmentId: null }))
    await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.sellerInboundShipmentId).toBeUndefined()
  })

  it('sourceType/agreement/portfolio come from the freshly-resolved agreement, not any pre-transaction state', async () => {
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'agr1', type: 'consignment', status: 'accepted', agreedBuyoutAmount: null, sellerPortfolioId: 'port1' }]) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.sourceType).toBe('consignment')
    expect(call.data.sellerAgreementId).toBe('agr1')
    expect(call.data.sellerPortfolioId).toBe('port1')
  })
})

describe('convertIntakeDraft — buyout cost semantics (15D-review final approval pass, section 1)', () => {
  function buyoutAgreement(overrides: Record<string, unknown> = {}) {
    return { id: 'agr1', type: 'buyout', status: 'accepted', agreedBuyoutAmount: new Prisma.Decimal('500.00'), sellerPortfolioId: null, acceptedItemCount: null, ...overrides }
  }

  it('acceptedItemCount=1 -> the exact agreement amount is assigned as this item\'s purchasePrice (total and per-item cost are mathematically identical)', async () => {
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: 1 })]) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBe(500)
  })

  it('acceptedItemCount=null (unspecified) -> purchasePrice stays unallocated, never coerced to 0', async () => {
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: null })]) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBeUndefined()
    expect(call.data.purchasePrice).not.toBe(0)
  })

  it('acceptedItemCount=2 -> the FIRST converted unit remains unallocated (no arbitrary first-item allocation)', async () => {
    const tx = makeTx(makeDraftRow({ id: 'draft1', sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: 2 })]) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBeUndefined()
  })

  it('acceptedItemCount=2 -> the SECOND converted unit also remains unallocated', async () => {
    // A second, independent draft/conversion call under the SAME 2-item agreement —
    // this is what "second unit" means at the primitive level (the workbench/manual
    // caller runs convertIntakeDraft once per physical unit).
    const tx = makeTx(makeDraftRow({ id: 'draft2', sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: 2 })]) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft2', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBeUndefined()
  })

  it('conversion ORDER never affects cost treatment — the rule is a pure function of the agreement\'s signed acceptedItemCount, not of how many ItemInstances exist so far', async () => {
    // Simulate "third conversion attempt so far" by making itemInstance.count return a
    // nonzero value if the primitive ever queried it — it must not, since the field
    // was intentionally removed from this decision (see rule below).
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: 1 })]) },
      itemInstance: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(7), create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'item1', ...args.data })) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    // acceptedItemCount=1 still assigns the full amount, REGARDLESS of how many prior
    // items supposedly exist (count=7 is irrelevant/never consulted).
    expect(call.data.purchasePrice).toBe(500)
    expect(tx.itemInstance.count).not.toHaveBeenCalled()
  })

  it('a partial conversion (only one ItemInstance exists so far) under a 2-item agreement does NOT get mistaken for a single-unit deal', async () => {
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: 2 })]) },
      itemInstance: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0), create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'item1', ...args.data })) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBeUndefined()
  })

  it('awkward-cent one-item buyout preserves the exact amount (no JS Float accumulation)', async () => {
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: 1, agreedBuyoutAmount: new Prisma.Decimal('19.97') })]) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBe(19.97)
  })

  it('the agreement-level SellerPayoutLine always records the full authoritative amount regardless of acceptedItemCount — the payout obligation is never affected by item-level allocation', async () => {
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([buyoutAgreement({ acceptedItemCount: 2 })]) },
    })
    await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(tx.sellerPayoutLine.create).toHaveBeenCalledTimes(1)
    const payoutCall = (tx.sellerPayoutLine.create as Mock).mock.calls[0][0]
    expect(payoutCall.data.agreedBuyoutAmount.toString()).toBe('500')
  })

  it('consignment conversions are unaffected — no purchasePrice is ever set for consignment (unchanged, uses seller payout lines at sale time instead)', async () => {
    const tx = makeTx(makeDraftRow({ sellerSubmissionId: 'sub1' }), {
      sellerAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'agr1', type: 'consignment', status: 'accepted', agreedBuyoutAmount: null, sellerPortfolioId: 'port1', acceptedItemCount: 1 }]) },
    })
    const result = await convertIntakeDraft(tx as never, { draftId: 'draft1', locationId: 'loc1' })
    expect(result.ok).toBe(true)
    const call = (tx.itemInstance.create as Mock).mock.calls[0][0]
    expect(call.data.purchasePrice).toBeUndefined()
    expect(tx.sellerPayoutLine.create).not.toHaveBeenCalled()
  })
})

describe('convertIntakeDraft — equivalent input produces equivalent state regardless of caller', () => {
  it('a manual-style draft (brand/name, admin-typed sku, no shipment) and a workbench-style draft (catalogModelId, auto sku, shipment) both converge on the same ItemInstance shape/rules', async () => {
    const manualTx = makeTx(makeDraftRow({ brand: 'Hot Wheels', name: 'Porsche 911', catalogModelId: null, sellerInboundShipmentId: null }))
    const manualResult = await convertIntakeDraft(manualTx as never, { draftId: 'draft1', locationId: 'loc1', sku: 'HW-0100' })

    const workbenchTx = makeTx(makeDraftRow({ brand: null, name: null, catalogModelId: 'cat1', sellerInboundShipmentId: 'ship1' }))
    const workbenchResult = await convertIntakeDraft(workbenchTx as never, { draftId: 'draft1', locationId: 'loc1' })

    expect(manualResult.ok).toBe(true)
    expect(workbenchResult.ok).toBe(true)
    const manualCall = (manualTx.itemInstance.create as Mock).mock.calls[0][0]
    const workbenchCall = (workbenchTx.itemInstance.create as Mock).mock.calls[0][0]
    // Same status/condition/cardedOrLoose rules apply to both. Catalog resolution
    // legitimately differs by design: manual's fuzzy brand/name path finds no existing
    // match in this fixture and creates one ('cat-new'); workbench's exact
    // catalogModelId resolves the existing row ('cat1') directly — both are the SAME
    // shared resolution logic, just exercising its two different branches.
    expect(manualCall.data.status).toBe(workbenchCall.data.status)
    expect(manualCall.data.condition).toBe(workbenchCall.data.condition)
    expect(manualCall.data.catalogId).toBe('cat-new')
    expect(workbenchCall.data.catalogId).toBe('cat1')
  })
})

describe('manual/workbench converter relationship — structural', () => {
  it('actions/intake.ts convertDraft calls the shared convertIntakeDraft primitive', () => {
    const src = readSrc('src/lib/actions/intake.ts')
    expect(src).toMatch(/import \{ convertIntakeDraft \} from '@\/lib\/intakeConversion'/)
    expect(src).toMatch(/await convertIntakeDraft\(tx,/)
  })

  it('actions/intakeWorkbench.ts confirmWorkbenchItem calls the same shared primitive', () => {
    const src = readSrc('src/lib/actions/intakeWorkbench.ts')
    expect(src).toMatch(/import \{ convertIntakeDraft \} from '@\/lib\/intakeConversion'/)
    expect(src).toMatch(/await convertIntakeDraft\(tx,/)
  })

  it('neither caller re-creates an ItemInstance itself — itemInstance.create exists exactly once in the whole codebase, inside the shared primitive', () => {
    const intakeSrc = readSrc('src/lib/actions/intake.ts')
    const workbenchSrc = readSrc('src/lib/actions/intakeWorkbench.ts')
    const conversionSrc = readSrc('src/lib/intakeConversion.ts')
    expect(intakeSrc).not.toMatch(/\.itemInstance\.create\(/)
    expect(workbenchSrc).not.toMatch(/\.itemInstance\.create\(/)
    expect([...conversionSrc.matchAll(/\.itemInstance\.create\(/g)].length).toBe(1)
  })

  it('the workbench creates/persists its IntakeDraft (its own tx.intakeDraft.create call) BEFORE handing the draft id to convertIntakeDraft — never fused into one ItemInstance-then-draft write', () => {
    const src = readSrc('src/lib/actions/intakeWorkbench.ts')
    const createIdx = src.indexOf('tx.intakeDraft.create(')
    const convertIdx = src.indexOf('await convertIntakeDraft(tx,')
    expect(createIdx).toBeGreaterThan(-1)
    expect(convertIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeLessThan(convertIdx)
  })

  it('no converted IntakeDraft can exist without its ItemInstance: the shared primitive writes convertedItemId in the SAME call that creates the ItemInstance, never as a separate later step', () => {
    const src = readSrc('src/lib/intakeConversion.ts')
    const createIdx = src.indexOf('await tx.itemInstance.create(')
    const linkIdx = src.indexOf("status: 'converted', convertedItemId: item.id")
    expect(createIdx).toBeGreaterThan(-1)
    expect(linkIdx).toBeGreaterThan(createIdx)
  })
})
