// 15I: behavioral tests for the bulk item-action engine — dedupe, hard batch-size
// ceiling (reject, never truncate), per-item independence/partial success, and
// idempotency pass-through from itemMutations.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/itemMutations', () => ({
  setItemStorage: vi.fn(),
  setItemCondition: vi.fn(),
  setItemCatalog: vi.fn(),
}))

import { isAdminAuthenticated } from '@/lib/adminAuth'
import { setItemStorage, setItemCondition, setItemCatalog } from '@/lib/itemMutations'
import { executeBulkItemAction } from '@/lib/actions/itemBulkActions'
import { MAX_BULK_ITEM_BATCH } from '@/lib/itemBulkTypes'

beforeEach(() => {
  vi.resetAllMocks()
  ;(isAdminAuthenticated as Mock).mockResolvedValue(true)
})

describe('executeBulkItemAction — auth', () => {
  it('rejects when not authenticated as admin, without calling any mutation helper', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValue(false)
    const result = await executeBulkItemAction({ action: 'set_storage', itemIds: ['a'], storageLocationId: 'loc1' })
    expect(result).toEqual({ ok: false, error: 'Admin authentication required.' })
    expect(setItemStorage).not.toHaveBeenCalled()
  })
})

describe('executeBulkItemAction — batch size (section 22)', () => {
  it('rejects the ENTIRE request over the max — never truncates to the first N', async () => {
    const ids = Array.from({ length: MAX_BULK_ITEM_BATCH + 1 }, (_, i) => `item-${i}`)
    const result = await executeBulkItemAction({ action: 'set_condition', itemIds: ids, condition: 'mint' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(`Maximum ${MAX_BULK_ITEM_BATCH}`)
    expect(setItemCondition).not.toHaveBeenCalled()
  })

  it('accepts exactly the max', async () => {
    ;(setItemCondition as Mock).mockResolvedValue({ outcome: 'updated' })
    const ids = Array.from({ length: MAX_BULK_ITEM_BATCH }, (_, i) => `item-${i}`)
    const result = await executeBulkItemAction({ action: 'set_condition', itemIds: ids, condition: 'mint' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.total).toBe(MAX_BULK_ITEM_BATCH)
  })

  it('rejects an empty selection', async () => {
    const result = await executeBulkItemAction({ action: 'set_condition', itemIds: [], condition: 'mint' })
    expect(result).toEqual({ ok: false, error: 'No items selected.' })
  })

  it('dedupes repeated ids before processing (section 11)', async () => {
    ;(setItemStorage as Mock).mockResolvedValue({ outcome: 'updated' })
    const result = await executeBulkItemAction({ action: 'set_storage', itemIds: ['a', 'a', 'a'], storageLocationId: 'loc1' })
    expect(setItemStorage).toHaveBeenCalledTimes(1)
    if (result.ok) expect(result.total).toBe(1)
  })
})

describe('executeBulkItemAction — partial success (section 24)', () => {
  it('one failing item does not block or roll back the others; every id gets its own result', async () => {
    ;(setItemStorage as Mock).mockImplementation((itemId: string) => {
      if (itemId === 'bad') return Promise.resolve({ outcome: 'validation_failed', reason: 'nope' })
      return Promise.resolve({ outcome: 'updated' })
    })
    const result = await executeBulkItemAction({ action: 'set_storage', itemIds: ['good1', 'bad', 'good2'], storageLocationId: 'loc1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(setItemStorage).toHaveBeenCalledTimes(3)
    expect(result.results).toEqual([
      { itemId: 'good1', outcome: 'updated' },
      { itemId: 'bad', outcome: 'validation_failed', reason: 'nope' },
      { itemId: 'good2', outcome: 'updated' },
    ])
  })

  it('classifies mixed outcomes into the correct summary buckets', async () => {
    const outcomes = [
      { outcome: 'updated' as const },
      { outcome: 'unchanged' as const },
      { outcome: 'approval_required' as const, approvalRequestId: 'req-1' },
      { outcome: 'denied' as const, reason: 'blocked' },
      { outcome: 'not_found' as const },
    ]
    let i = 0
    ;(setItemCatalog as Mock).mockImplementation(() => Promise.resolve(outcomes[i++]))
    const result = await executeBulkItemAction({ action: 'assign_catalog', itemIds: ['1', '2', '3', '4', '5'], catalogId: 'cat1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(1)
    expect(result.unchanged).toBe(1)
    expect(result.approvalRequired).toBe(1)
    expect(result.failed).toBe(2) // denied + not_found
  })

  it('an unexpected thrown error for one item becomes a validation_failed row, not a thrown exception for the whole batch', async () => {
    ;(setItemCondition as Mock).mockImplementation((itemId: string) => {
      if (itemId === 'boom') throw new Error('kaboom')
      return Promise.resolve({ outcome: 'updated' })
    })
    const result = await executeBulkItemAction({ action: 'set_condition', itemIds: ['ok', 'boom'], condition: 'mint' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results.find((r) => r.itemId === 'boom')?.outcome).toBe('validation_failed')
    expect(result.results.find((r) => r.itemId === 'ok')?.outcome).toBe('updated')
  })

  it('every selected id appears in results exactly once — nothing silently skipped', async () => {
    ;(setItemStorage as Mock).mockResolvedValue({ outcome: 'updated' })
    const ids = ['a', 'b', 'c', 'd']
    const result = await executeBulkItemAction({ action: 'set_storage', itemIds: ids, storageLocationId: 'loc1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results.map((r) => r.itemId)).toEqual(ids)
  })
})

describe('executeBulkItemAction — action routing', () => {
  it('routes set_storage to setItemStorage with the exact locationId', async () => {
    ;(setItemStorage as Mock).mockResolvedValue({ outcome: 'updated' })
    await executeBulkItemAction({ action: 'set_storage', itemIds: ['a'], storageLocationId: 'loc-xyz' })
    expect(setItemStorage).toHaveBeenCalledWith('a', 'loc-xyz')
  })

  it('routes set_condition to setItemCondition with the exact condition', async () => {
    ;(setItemCondition as Mock).mockResolvedValue({ outcome: 'updated' })
    await executeBulkItemAction({ action: 'set_condition', itemIds: ['a'], condition: 'near_mint' })
    expect(setItemCondition).toHaveBeenCalledWith('a', 'near_mint')
  })

  it('routes assign_catalog to setItemCatalog with requestedBy honestly "admin"', async () => {
    ;(setItemCatalog as Mock).mockResolvedValue({ outcome: 'updated' })
    await executeBulkItemAction({ action: 'assign_catalog', itemIds: ['a'], catalogId: 'cat1' })
    expect(setItemCatalog).toHaveBeenCalledWith('a', 'cat1', 'admin')
  })
})

describe('executeBulkItemAction — batchOperationId', () => {
  it('returns a batchOperationId correlating the whole batch', async () => {
    ;(setItemStorage as Mock).mockResolvedValue({ outcome: 'updated' })
    const result = await executeBulkItemAction({ action: 'set_storage', itemIds: ['a'], storageLocationId: 'loc1' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(typeof result.batchOperationId).toBe('string')
    if (result.ok) expect(result.batchOperationId.length).toBeGreaterThan(0)
  })
})
