'use server'

// 15K: the only two admin-triggered entry points into auto-listing execution. Both
// require authentication; neither runs on a schedule or from any other trigger.
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { revalidatePath } from 'next/cache'
import {
  runAutoListingBatch, previewAutoListingCandidates,
  type AutoListingRunResult, type AutoListPreviewRow,
} from '@/lib/autoListingExecution'

export type RunAutoListingResult = { ok: true; result: AutoListingRunResult } | { ok: false; error: string }

// Part H/19: explicit execution only — an authenticated admin clicking "Run Auto-
// Listing" is the ONLY way this function is ever invoked.
export async function runAutoListingBatchAction(cursor: string | null): Promise<RunAutoListingResult> {
  if (!(await isAdminAuthenticated())) return { ok: false, error: 'Unauthorized' }
  try {
    const result = await runAutoListingBatch('admin', cursor)
    revalidatePath('/admin/auto-listing')
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Auto-listing run failed.' }
  }
}

export type PreviewAutoListingResult = { ok: true; items: AutoListPreviewRow[]; nextCursor: string | null } | { ok: false; error: string }

export async function previewAutoListingCandidatesAction(cursor: string | null): Promise<PreviewAutoListingResult> {
  if (!(await isAdminAuthenticated())) return { ok: false, error: 'Unauthorized' }
  const { items, nextCursor } = await previewAutoListingCandidates(cursor)
  return { ok: true, items, nextCursor }
}
