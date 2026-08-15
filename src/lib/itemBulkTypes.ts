// 15I: shared types/constants for the bulk item-action engine. Kept out of
// itemBulkActions.ts because a 'use server' file may only export async functions —
// a plain `export const`/non-function type here would break the server-action
// module boundary (Next.js build constraint), not because of a layering concern.
import type { ItemMutationOutcome } from '@/lib/itemMutations'

export const MAX_BULK_ITEM_BATCH = 100

export type BulkItemActionInput =
  | { action: 'set_storage'; itemIds: string[]; storageLocationId: string }
  | { action: 'set_condition'; itemIds: string[]; condition: string }
  | { action: 'assign_catalog'; itemIds: string[]; catalogId: string }

export type BulkItemRowResult = { itemId: string } & ItemMutationOutcome

export type BulkItemActionResult =
  | {
      ok: true
      batchOperationId: string
      total: number
      succeeded: number
      unchanged: number
      approvalRequired: number
      failed: number
      results: BulkItemRowResult[]
    }
  | { ok: false; error: string }
