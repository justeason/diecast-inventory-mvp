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

  revalidatePath('/account/alerts')
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
  revalidatePath('/account/alerts')
}

export async function markAllAlertsReadAction(): Promise<void> {
  const session = await getBuyerSession()
  if (!session) return

  await prisma.buyerAlertEvent.updateMany({
    where: { customerProfileId: session.profileId, readAt: null },
    data: { readAt: new Date() },
  })
  revalidatePath('/account/alerts')
}

// ─── per-model wanted alert toggle ─────────────────────────────────────────────

export async function toggleWantedAlertAction(
  id: string,
  field: 'availabilityAlertEnabled' | 'priceAlertEnabled',
): Promise<void> {
  const session = await getBuyerSession()
  if (!session) return
  if (field !== 'availabilityAlertEnabled' && field !== 'priceAlertEnabled') return

  const entry = await prisma.wantedCatalogModel.findFirst({
    where: { id, customerProfileId: session.profileId },
    select: { id: true, availabilityAlertEnabled: true, priceAlertEnabled: true },
  })
  if (!entry) return

  await prisma.wantedCatalogModel.update({
    where: { id },
    data: { [field]: !entry[field] },
  })
  revalidatePath('/account/wanted')
}
