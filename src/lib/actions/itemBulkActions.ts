'use server'

// 15I: narrow bulk item-action engine (Part I). Explicit action union only — no
// generic { fieldName, newValue } patcher. Every item is independently revalidated
// and mutated via itemMutations.ts; one bad row never blocks the rest (Part I
// section 23). Server enforces a hard batch-size ceiling and REJECTS the whole
// request over it — never silently truncates (section 22).

import crypto from 'crypto'
import { revalidatePath } from 'next/cache'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { setItemStorage, setItemCondition, setItemCatalog, type ItemMutationOutcome } from '@/lib/itemMutations'
import { MAX_BULK_ITEM_BATCH, type BulkItemActionInput, type BulkItemRowResult, type BulkItemActionResult } from '@/lib/itemBulkTypes'

export type { BulkItemActionInput, BulkItemRowResult, BulkItemActionResult }

export async function executeBulkItemAction(input: BulkItemActionInput): Promise<BulkItemActionResult> {
  if (!(await isAdminAuthenticated())) return { ok: false, error: 'Admin authentication required.' }

  // Dedupe (section 11) — the same physical item is never processed twice in one
  // batch even if the client submitted a duplicate id.
  const ids = [...new Set(input.itemIds)]
  if (ids.length === 0) return { ok: false, error: 'No items selected.' }
  if (ids.length > MAX_BULK_ITEM_BATCH) {
    return { ok: false, error: `Maximum ${MAX_BULK_ITEM_BATCH} items per bulk action — ${ids.length} were selected. Reduce your selection and retry.` }
  }

  const batchOperationId = crypto.randomUUID()

  // One independent mutation per item (Part I section 23) — no shared transaction,
  // so a failure on item #7 has zero effect on #1-6 or #8-N.
  const results: BulkItemRowResult[] = []
  for (const itemId of ids) {
    let outcome: ItemMutationOutcome
    try {
      if (input.action === 'set_storage') outcome = await setItemStorage(itemId, input.storageLocationId)
      else if (input.action === 'set_condition') outcome = await setItemCondition(itemId, input.condition)
      else outcome = await setItemCatalog(itemId, input.catalogId, 'admin')
    } catch {
      outcome = { outcome: 'validation_failed', reason: 'Unexpected error processing this item.' }
    }
    results.push({ itemId, ...outcome })
  }

  const succeeded = results.filter((r) => r.outcome === 'updated').length
  const unchanged = results.filter((r) => r.outcome === 'unchanged').length
  const approvalRequired = results.filter((r) => r.outcome === 'approval_required').length
  const failed = results.length - succeeded - unchanged - approvalRequired

  revalidatePath('/admin/items')

  return { ok: true, batchOperationId, total: results.length, succeeded, unchanged, approvalRequired, failed, results }
}
