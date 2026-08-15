// 15I: cross-cutting structural safety checks for the bulk item-action engine —
// Part O (no commercial/financial bulk editing), Part P (no automation creep),
// Part Q (no 14C valuation query outside catalog reassignment), physical-identity
// invariants (Part R section 48/49). Behavioral correctness for each action is
// covered in itemMutations.test.ts / itemBulkActions.test.ts; this file only proves
// the SOURCE never contains the prohibited surface area.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const itemMutationsSrc = readSrc('src/lib/itemMutations.ts')
const itemBulkActionsSrc = readSrc('src/lib/actions/itemBulkActions.ts')
const itemBulkTableSrc = readSrc('src/components/admin/ItemBulkTable.tsx')
const itemsActionsSrc = readSrc('src/lib/actions/items.ts')
const intakeOperationsSrc = readSrc('src/lib/actions/intakeOperations.ts')

// ── Part O: no commercial/financial/identity field is ever bulk-editable ─────────
describe('Part O — prohibited commercial/financial/identity bulk fields', () => {
  const prohibited = [
    'purchasePrice', 'listPrice', 'commission', 'payoutAmount', 'payoutStatus',
    'sellerAgreementId', 'sellerPortfolioId', 'sellerInboundShipmentId', 'sourceType',
    'minimumFee', 'sku:',
  ]
  for (const field of prohibited) {
    it(`itemMutations.ts never sets "${field}"`, () => {
      expect(itemMutationsSrc).not.toContain(field)
    })
  }

  it('the only ItemInstance fields ever written are locationId, condition, and catalogId', () => {
    // Matches both `data: { locationId }` (shorthand) and `data: { field: value }`.
    const dataObjects = [...itemMutationsSrc.matchAll(/data:\s*\{\s*([a-zA-Z]+)\s*[,:}]/g)].map((m) => m[1])
    expect(dataObjects.length).toBeGreaterThan(0)
    expect(new Set(dataObjects)).toEqual(new Set(['locationId', 'condition', 'catalogId']))
  })
})

// ── Part P: no automation creep — no listing/agreement/payout mutation anywhere ──
describe('Part P — no automation creep', () => {
  it('no listing creation, agreement acceptance, or payout mutation in the bulk engine', () => {
    for (const src of [itemMutationsSrc, itemBulkActionsSrc]) {
      expect(src).not.toContain('listing.create')
      expect(src).not.toContain('listing.update')
      expect(src).not.toContain('Agreement.update')
      expect(src).not.toContain('sellerPayout')
    }
  })

  it('no client-supplied RiskDecision is ever accepted — the only decision source is checkRiskGate', () => {
    expect(itemMutationsSrc).not.toMatch(/decision:\s*['"](allow|deny|pending)/)
  })
})

// ── Physical identity (Part R section 48) ─────────────────────────────────────────
describe('physical identity invariants', () => {
  it('the bulk engine never creates, merges, or deletes an ItemInstance', () => {
    for (const src of [itemMutationsSrc, itemBulkActionsSrc]) {
      expect(src).not.toContain('itemInstance.create')
      expect(src).not.toContain('itemInstance.delete')
      expect(src).not.toContain('itemInstance.upsert')
    }
  })

  it('SKU is never referenced as a writable field', () => {
    expect(itemMutationsSrc).not.toMatch(/\bsku\s*:/)
  })

  it('order history (OrderItem) is never mutated', () => {
    for (const src of [itemMutationsSrc, itemBulkActionsSrc]) {
      expect(src).not.toContain('orderItem.update')
      expect(src).not.toContain('order.update')
    }
  })
})

// ── Part Q: no 14C valuation for storage/condition; only catalog reassignment ────
describe('Part Q — valuation query scope', () => {
  it('getPricingIntelligence is imported once and used only inside setItemCatalog', () => {
    const importCount = (itemMutationsSrc.match(/getPricingIntelligence/g) ?? []).length
    // One import + one call site = 2 occurrences total.
    expect(importCount).toBe(2)
    const catalogFnStart = itemMutationsSrc.indexOf('export async function setItemCatalog')
    const callIdx = itemMutationsSrc.indexOf('getPricingIntelligence(', catalogFnStart)
    expect(callIdx).toBeGreaterThan(catalogFnStart)
  })

  it('setItemStorage and setItemCondition never reference getPricingIntelligence', () => {
    const storageFn = itemMutationsSrc.slice(
      itemMutationsSrc.indexOf('export async function setItemStorage'),
      itemMutationsSrc.indexOf('export async function setItemCondition'),
    )
    const conditionFn = itemMutationsSrc.slice(
      itemMutationsSrc.indexOf('export async function setItemCondition'),
      itemMutationsSrc.indexOf('export async function setItemCatalog'),
    )
    expect(storageFn).not.toContain('getPricingIntelligence')
    expect(conditionFn).not.toContain('getPricingIntelligence')
  })
})

// ── Part R section 49 — no JS float financial accumulation ───────────────────────
describe('no JS float financial accumulation', () => {
  it('the only arithmetic in itemMutations.ts is Math.round(...*100) — identical to the single-item form (no new summation)', () => {
    const mathCalls = [...itemMutationsSrc.matchAll(/Math\.\w+/g)].map((m) => m[0])
    for (const call of mathCalls) expect(call).toBe('Math.round')
  })
})

// ── Selection UX (Part C/M) — explicit ids only, no invisible "select all matching" ──
describe('Part C section 9 / Part M — selection scope', () => {
  it('the bulk table only ever operates on explicitly selected row ids (Set<string>), never a filter-derived server snapshot token', () => {
    expect(itemBulkTableSrc).not.toContain('selectAllMatching')
    expect(itemBulkTableSrc).toContain('useState<Set<string>>')
  })

  it('"select all" only selects the current page’s rendered items array, not a separate unbounded query', () => {
    const toggleAllFn = itemBulkTableSrc.slice(
      itemBulkTableSrc.indexOf('function toggleAll'),
      itemBulkTableSrc.indexOf('function toggleOne'),
    )
    expect(toggleAllFn).toContain('items.map')
  })
})

// ── Batch size (Part I section 22) is a real ceiling, not a default that can be bypassed ──
describe('batch size ceiling is enforced before any mutation helper runs', () => {
  it('MAX_BULK_ITEM_BATCH check happens before the per-item loop', () => {
    const maxCheckIdx = itemBulkActionsSrc.indexOf('ids.length > MAX_BULK_ITEM_BATCH')
    const loopIdx = itemBulkActionsSrc.indexOf('for (const itemId of ids)')
    expect(maxCheckIdx).toBeGreaterThan(-1)
    expect(loopIdx).toBeGreaterThan(maxCheckIdx)
  })

  it('never truncates with .slice(0, MAX', () => {
    expect(itemBulkActionsSrc).not.toMatch(/\.slice\(0,\s*MAX_BULK_ITEM_BATCH\)/)
  })
})

// ── 15E untouched (Part R section 47) ─────────────────────────────────────────────
describe('15E exception bulk actions are untouched by 15I', () => {
  it('intakeExceptions.ts still operates on IntakeDraft, not ItemInstance, and was not modified to call itemMutations', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    expect(src).not.toContain('itemMutations')
    expect(src).not.toContain('executeBulkItemAction')
  })

  it('mutation-consistency pass: moveInventoryItem now delegates to the shared itemMutations.ts primitive instead of duplicating IMMOVABLE_STATUSES/RETURN_PENDING_CASE_TYPES, and the dead all-or-nothing bulkMoveInventoryItems was removed', () => {
    const src = readSrc('src/lib/actions/intakeOperations.ts')
    expect(src).not.toMatch(/const IMMOVABLE_STATUSES\s*=/)
    expect(src).not.toMatch(/const RETURN_PENDING_CASE_TYPES\s*=/)
    expect(src).not.toContain("'sold', 'reserved', 'not_for_sale'")
    expect(src).toContain('export async function moveInventoryItem')
    expect(src).toContain('setItemStorageInTx')
    expect(src).not.toContain('export async function bulkMoveInventoryItems')
  })
})

// ── Focused-review Part 1-3/9: exactly one authoritative storage-mutation rule,
// and every real runtime caller delegates to it. ─────────────────────────────────
describe('one authoritative storage-mutation rule — every real caller delegates', () => {
  it('IMMOVABLE_STATUSES / RETURN_PENDING_CASE_TYPES are declared exactly once, in itemMutations.ts', () => {
    expect(itemMutationsSrc).toMatch(/export const IMMOVABLE_STATUSES\s*=/)
    expect(itemMutationsSrc).toMatch(/export const RETURN_PENDING_CASE_TYPES\s*=/)
    for (const src of [itemsActionsSrc, intakeOperationsSrc, itemBulkActionsSrc]) {
      expect(src).not.toMatch(/const IMMOVABLE_STATUSES\s*=/)
      expect(src).not.toMatch(/const RETURN_PENDING_CASE_TYPES\s*=/)
    }
  })

  it('updateItemInstance (single-item full-form edit) imports and calls validateItemStorageMove from itemMutations.ts', () => {
    expect(itemsActionsSrc).toMatch(/import\s*\{[^}]*validateItemStorageMove[^}]*\}\s*from\s*'@\/lib\/itemMutations'/)
    expect(itemsActionsSrc).toContain('validateItemStorageMove(tx,')
  })

  it('moveInventoryItem (single-item dedicated move) imports and calls setItemStorageInTx from itemMutations.ts', () => {
    expect(intakeOperationsSrc).toMatch(/import\s*\{[^}]*setItemStorageInTx[^}]*\}\s*from\s*'@\/lib\/itemMutations'/)
    expect(intakeOperationsSrc).toContain('setItemStorageInTx(tx,')
  })

  it('the bulk item-action engine reaches storage mutation only via itemMutations.ts#setItemStorage', () => {
    expect(itemBulkActionsSrc).toMatch(/import\s*\{[^}]*setItemStorage[^}]*\}\s*from\s*'@\/lib\/itemMutations'/)
    expect(itemBulkActionsSrc).not.toContain('itemInstance.update')
  })

  it('intakeOperations.ts and itemBulkActions.ts never write ItemInstance directly — no bypass of the shared primitive is even possible from those files', () => {
    expect(intakeOperationsSrc).not.toContain('itemInstance.update')
    expect(itemBulkActionsSrc).not.toContain('itemInstance.update')
  })

  it('items.ts writes locationId in exactly one place: toMutableDbData, called from exactly one itemInstance.update site (only reachable after validateItemStorageMove passes)', () => {
    const updateCalls = [...itemsActionsSrc.matchAll(/tx\.itemInstance\.update\(/g)].length
    expect(updateCalls).toBe(1)
    expect(itemsActionsSrc).toContain('data: toMutableDbData(result.data)')
  })

  it('condition enum is shared: items.ts imports ITEM_CONDITIONS from itemMutations.ts rather than re-declaring the list', () => {
    expect(itemsActionsSrc).toMatch(/import\s*\{[^}]*ITEM_CONDITIONS[^}]*\}\s*from\s*'@\/lib\/itemMutations'/)
    expect(itemsActionsSrc).not.toMatch(/z\.enum\(\['mint'/)
  })

  it('catalog reassignment risk context is built by the one shared function in both callers', () => {
    expect(itemsActionsSrc).toMatch(/import\s*\{[^}]*buildItemCatalogReassignmentContext[^}]*\}\s*from\s*'@\/lib\/itemMutations'/)
    expect(itemsActionsSrc).toContain('buildItemCatalogReassignmentContext(')
    expect(itemMutationsSrc).toContain('export function buildItemCatalogReassignmentContext')
    // setItemCatalog (bulk) uses the same builder, not a second inline copy.
    const setItemCatalogSrc = itemMutationsSrc.slice(itemMutationsSrc.indexOf('export async function setItemCatalog'))
    expect(setItemCatalogSrc).toContain('buildItemCatalogReassignmentContext(')
    expect(setItemCatalogSrc).not.toContain('hasCompletedSale:')
  })
})
