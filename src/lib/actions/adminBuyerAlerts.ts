'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { processPendingBuyerAlerts, retryFailedAlertEvent } from '@/lib/buyerAlertsDelivery'
import { processFanoutJobs } from '@/lib/buyerAlertsFanoutProcessor'

// Admin-only, explicit, bounded. Not a public endpoint — auth is independent of any
// route-level protection. Retries exactly one event, and only if it is 'failed'
// (enforced in retryFailedAlertEvent) — 'delivery_unknown' rows are never retryable
// through this action; no bulk resend-all. Reuses the same Resend idempotency key
// (derived from the event id, which never changes) and revalidates preferences/wanted-
// list/availability fresh on the next delivery attempt.
export async function retryBuyerAlertEventAction(eventId: string): Promise<void> {
  if (!await isAdminAuthenticated()) redirect('/admin/login')
  await retryFailedAlertEvent(eventId)
  revalidatePath('/admin/system/alerts')
}

// Manually runs one bounded batch of fan-out then delivery. Used when no cron has run
// yet, or for on-demand visibility — still bounded, same DB-conditional claiming as the
// scheduled cron, so it is safe to click concurrently with a live (or duplicated) cron run.
export async function runBuyerAlertProcessorAction(): Promise<void> {
  if (!await isAdminAuthenticated()) redirect('/admin/login')
  await processFanoutJobs()
  await processPendingBuyerAlerts()
  revalidatePath('/admin/system/alerts')
}
