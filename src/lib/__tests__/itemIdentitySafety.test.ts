// 15C: structural checks for "one physical item = one permanent ItemInstance"
// (section 3/18/26). Behavioral coverage for these transactions already exists
// elsewhere (intake conversion locking, order cancellation flows); these checks pin
// down the SPECIFIC identity-continuity invariants — action files with heavy
// prisma.$transaction usage aren't unit-tested directly in this codebase (see 15A/15B
// precedent), so duplication-safety is verified structurally instead.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    // 15F: updateItemInstance now also reads the item's CURRENT catalogId to decide
    // whether a catalog-reassignment risk gate applies — same catalogId as the
    // update input ('cat1') so this test's sku-immutability behavior is unaffected
    // (no gate triggered, straight through to itemInstance.update).
    itemInstance: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue({ catalogId: 'cat1', status: 'available', listing: null, orderItems: [], sellerAgreement: null }) },
    catalogModel: { findUnique: vi.fn().mockResolvedValue({ id: 'cat1' }) },
    storageLocation: { findUnique: vi.fn() },
  },
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`) }),
}))

// 15D-review section 1: conversion (draft lock, status gate, ItemInstance creation,
// converted+link write) is no longer implemented in intake.ts — it was extracted into
// the single shared src/lib/intakeConversion.ts primitive (also used by the bulk
// intake workbench). intake.ts now only owns its own canonical-ordering lock
// (SellerSubmission) and hands off; the deeper invariants below are asserted against
// the shared primitive, once, in intakeConversion.test.ts — see that file for
// "exactly one itemInstance.create call site", the lock→status-check→create ordering,
// and the create→converted-link ordering.
describe('intake.ts: one physical intake converts to exactly one ItemInstance (section 3)', () => {
  const src = readSrc('src/lib/actions/intake.ts')

  it('convertDraft no longer creates an ItemInstance itself — it delegates to the shared conversion primitive', () => {
    expect(src).not.toMatch(/tx\.itemInstance\.create\(|prisma\.itemInstance\.create\(/)
    expect(src).toMatch(/import \{ convertIntakeDraft \} from '@\/lib\/intakeConversion'/)
    expect(src).toMatch(/await convertIntakeDraft\(tx,/)
  })

  it('acquires the SellerSubmission lock (its own canonical-ordering responsibility) before handing off to the shared converter', () => {
    const fnStart = src.indexOf('export async function convertDraft')
    const fnSrc = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    const lockIdx = fnSrc.indexOf('SELECT id FROM "SellerSubmission"')
    const convertIdx = fnSrc.indexOf('await convertIntakeDraft(tx,')
    expect(lockIdx).toBeGreaterThan(-1)
    expect(convertIdx).toBeGreaterThan(-1)
    expect(lockIdx).toBeLessThan(convertIdx)
  })

  it('rejects re-conversion of an already-converted draft (repeated conversion attempts cannot create a duplicate ItemInstance) — pre-flight check preserved, authoritative gate now inside the shared primitive', () => {
    expect(src).toMatch(/status === 'converted'/)
    expect(src).toMatch(/already been converted/)
    // Authoritative (transaction-level) gate: see intakeConversion.test.ts's
    // 'draft-state gating' describe block for behavioral coverage of the actual reject.
  })
})

describe('listings.ts: relisting/status changes never create a second Listing or ItemInstance (section 3/10/18)', () => {
  const src = readSrc('src/lib/actions/listings.ts')

  it('there is exactly one listing.create call site — createListing — and it refuses an item that already has a listing', () => {
    const occurrences = src.match(/tx\.listing\.create\(|prisma\.listing\.create\(/g) ?? []
    expect(occurrences.length).toBe(1)
    const fnStart = src.indexOf('export async function createListing')
    const fnSrc = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    expect(fnSrc).toMatch(/if \(item\.listing\) return/)
  })

  it('updateListing (relisting, price changes, archiving) only ever calls listing.update — never creates a new Listing row', () => {
    const fnStart = src.indexOf('export async function updateListing')
    const fnSrc = src.slice(fnStart)
    expect(fnSrc).not.toMatch(/\.listing\.create\(/)
    expect(fnSrc).toMatch(/tx\.listing\.update\(/)
  })

  it('no code path in this file creates a new ItemInstance', () => {
    expect(src).not.toMatch(/itemInstance\.create\(/)
  })
})

describe('orders.ts: order cancellation returns the item to sellable state without cloning it (section 3/18)', () => {
  const src = readSrc('src/lib/actions/orders.ts')

  it('cancellation only updates existing ItemInstance rows by exact id — never creates a new one', () => {
    const cancelIdx = src.indexOf("status === 'cancelled'")
    const fnEnd = src.indexOf("} else if (status === 'complete')", cancelIdx)
    const cancelBlock = src.slice(cancelIdx, fnEnd)
    expect(cancelBlock).toMatch(/itemInstance\.updateMany\(/)
    expect(cancelBlock).not.toMatch(/itemInstance\.create\(/)
    expect(cancelBlock).toMatch(/status:\s*'available'/)
  })

  it('no code path in this file creates a new ItemInstance or Listing', () => {
    expect(src).not.toMatch(/itemInstance\.create\(/)
    expect(src).not.toMatch(/listing\.create\(/)
  })
})

describe('items.ts: manual company-owned creation is a genuinely distinct new item, guarded by unique SKU (not a re-conversion path)', () => {
  const src = readSrc('src/lib/actions/items.ts')

  it('checks for an existing SKU before creating, and also relies on the DB unique constraint as a second line of defense', () => {
    const fnStart = src.indexOf('export async function createItemInstance')
    const fnSrc = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    expect(fnSrc).toMatch(/existingItem/)
    expect(fnSrc).toMatch(/P2002/)
  })
})

// 15C-review section 1: sku is the permanent operator-facing item identity —
// assigned once at creation, never mutable afterward.
describe('items.ts: SKU immutability (15C-review section 1)', () => {
  const src = readSrc('src/lib/actions/items.ts')

  it('UpdateItemSchema has no sku field at all — a browser-submitted sku cannot even parse into the update payload', () => {
    const schemaStart = src.indexOf('const UpdateItemSchema')
    const schemaSrc = src.slice(schemaStart, schemaStart + 200)
    expect(schemaSrc).not.toMatch(/sku:/)
  })

  it('toMutableDbData never includes sku in its returned object', () => {
    const fnStart = src.indexOf('function toMutableDbData')
    const fnSrc = src.slice(fnStart, src.indexOf('\n}', fnStart))
    expect(fnSrc).not.toMatch(/sku:/)
  })

  it('updateItemInstance never writes sku to the database', () => {
    const fnStart = src.indexOf('export async function updateItemInstance')
    const fnSrc = src.slice(fnStart)
    const updateCallIdx = fnSrc.indexOf('itemInstance.update(')
    const updateCallSrc = fnSrc.slice(updateCallIdx, fnSrc.indexOf('})', updateCallIdx))
    expect(updateCallSrc).not.toMatch(/sku/)
  })

  it('sku is written exactly once — only inside createItemInstance', () => {
    const occurrences = [...src.matchAll(/\bsku:\s/g)]
    // CreateItemSchema field declaration + the create() call's `sku,` shorthand.
    const createStart = src.indexOf('const CreateItemSchema')
    const createEnd = src.indexOf('\nexport async function updateItemInstance')
    const outsideCreatePath = occurrences.filter(m => (m.index ?? 0) < createStart || (m.index ?? 0) > createEnd)
    expect(outsideCreatePath.length).toBe(0)
  })
})

describe('ItemInstanceForm.tsx: SKU is not editable in update mode (15C-review section 1)', () => {
  const src = readSrc('src/components/admin/ItemInstanceForm.tsx')

  it('renders no sku input element when editing an existing item (only in create mode)', () => {
    const editModeStart = src.indexOf(') : (')
    const editModeSrc = src
      .slice(editModeStart, src.indexOf(')}', editModeStart))
      .split('\n')
      .filter(line => !line.trim().startsWith('//')) // exclude explanatory comments
      .join('\n')
    expect(editModeSrc).not.toMatch(/<Input[\s\S]*?name="sku"/)
    expect(editModeSrc).not.toMatch(/^\s*name="sku"/m)
  })

  it('displays the existing SKU as read-only text with an explanatory "permanent" note', () => {
    expect(src).toMatch(/Permanent — assigned once at creation, cannot be changed\./)
  })
})

describe('updateItemInstance — behavioral: a malicious/browser-submitted sku field is ignored (15C-review section 1)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('never passes sku through to prisma.itemInstance.update, even when formData carries one', async () => {
    const { prisma } = await import('@/lib/prisma')
    const { updateItemInstance } = await import('@/lib/actions/items')
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValueOnce({ id: 'cat1' })

    const fd = new FormData()
    fd.set('sku', 'HACKED-SKU-999') // an update form should never send this, but simulate a tampered request
    fd.set('catalogId', 'cat1')
    fd.set('cardedOrLoose', 'carded')
    fd.set('condition', 'mint')
    fd.set('status', 'available')

    await expect(updateItemInstance('item1', null, fd)).rejects.toThrow('REDIRECT:')

    expect(prisma.itemInstance.update).toHaveBeenCalledTimes(1)
    const call = (prisma.itemInstance.update as Mock).mock.calls[0][0]
    expect(call.data).not.toHaveProperty('sku')
  })
})
