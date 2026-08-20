'use server'

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { revalidatePath } from 'next/cache'
import { checkRateLimit } from '@/lib/rateLimit'

const UPDATE_MAX    = 20
const UPDATE_WINDOW = 10 * 60 * 1000

export type BuyerAlertActionState = { errors: Record<string, string[]> } | null

// ─── updateAlertPreferences ────────────────────────────────────────────────────
// Identity is derived exclusively from the buyer session — customerProfileId is
// never accepted from the browser.

export async function updateAlertPreferences(
  _prev: BuyerAlertActionState,
  formData: FormData,
): Promise<BuyerAlertActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { _form: ['You must be signed in.'] } }

  const { allowed, resetMs } = checkRateLimit(
    `update_alert_prefs:${session.profileId}`,
    UPDATE_MAX,
    UPDATE_WINDOW,
  )
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return { errors: { _form: [`Too many updates. Please wait ${secs} seconds.`] } }
  }

  const wantedAvailableAlerts   = formData.get('wantedAvailableAlerts') === 'on'
  const wantedPriceChangeAlerts = formData.get('wantedPriceChangeAlerts') === 'on'
  const emailAlertsEnabled      = formData.get('emailAlertsEnabled') === 'on'

  const thresholdRaw = formData.get('priceChangeThresholdPct')?.toString().trim() ?? ''
  let priceChangeThresholdPct: number | null = null
  if (thresholdRaw) {
    const n = Number(thresholdRaw)
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return { errors: { priceChangeThresholdPct: ['Must be a whole number between 1 and 100.'] } }
    }
    priceChangeThresholdPct = n
  }

  await prisma.buyerAlertPreference.upsert({
    where: { customerProfileId: session.profileId },
    create: {
      customerProfileId: session.profileId,
      wantedAvailableAlerts,
      wantedPriceChangeAlerts,
      emailAlertsEnabled,
      priceChangeThresholdPct,
    },
    update: {
      wantedAvailableAlerts,
      wantedPriceChangeAlerts,
      emailAlertsEnabled,
      priceChangeThresholdPct,
    },
  })

  // 16D: Alerts UI now lives at /account/wanted (view=alerts), not /account/alerts
  // (which is just a redirect shim) — revalidate the route that actually renders
  // this data, or a stale cache would keep showing pre-mutation state there.
  revalidatePath('/account/wanted')
  return null
}

// ─── mark read / mark all read ─────────────────────────────────────────────────

export async function markAlertReadAction(id: string): Promise<void> {
  const session = await getBuyerSession()
  if (!session) return

  await prisma.buyerAlertEvent.updateMany({
    where: { id, customerProfileId: session.profileId, readAt: null },
    data: { readAt: new Date() },
  })
  revalidatePath('/account/wanted')
}

export async function markAllAlertsReadAction(): Promise<void> {
  const session = await getBuyerSession()
  if (!session) return

  await prisma.buyerAlertEvent.updateMany({
    where: { customerProfileId: session.profileId, readAt: null },
    data: { readAt: new Date() },
  })
  revalidatePath('/account/wanted')
}

// ─── per-model wanted alert preference (16D) ───────────────────────────────────
// Explicit desired-state mutation, not a blind toggle: two identical "enable"
// (or "disable") requests — e.g. a double-click or a retried submit — always
// converge on the same final state, since each call sets `field` to the exact
// value the caller passed rather than negating whatever is currently in the DB.
// Ownership is enforced in the WHERE clause of a single updateMany (like
// removeFromWantedList in wantedList.ts) — never a separate findFirst-then-update
// gap, and never a browser-supplied customerProfileId.

export async function setWantedAlertAction(
  id: string,
  field: 'availabilityAlertEnabled' | 'priceAlertEnabled',
  enabled: boolean,
): Promise<void> {
  const session = await getBuyerSession()
  if (!session) return
  if (field !== 'availabilityAlertEnabled' && field !== 'priceAlertEnabled') return

  await prisma.wantedCatalogModel.updateMany({
    where: { id, customerProfileId: session.profileId },
    data: { [field]: enabled },
  })
  revalidatePath('/account/wanted')
}
