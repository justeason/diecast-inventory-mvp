// 14A: Buyer-facing read queries for alert preferences + the notification center.
// No seller identity, no raw internal IDs beyond what the buyer already owns,
// bounded/deterministic pagination.

import { prisma } from '@/lib/prisma'

export const ALERT_PAGE_SIZE = 20

export type ResolvedAlertPreference = {
  wantedAvailableAlerts:   boolean
  wantedPriceChangeAlerts: boolean
  emailAlertsEnabled:      boolean
  priceChangeThresholdPct: number | null
}

const DEFAULT_PREFERENCE: ResolvedAlertPreference = {
  wantedAvailableAlerts:   true,
  wantedPriceChangeAlerts: true,
  emailAlertsEnabled:      true,
  priceChangeThresholdPct: null,
}

// Buyers who never visited /account/alerts have no BuyerAlertPreference row —
// schema defaults (all enabled) apply, so absence resolves to DEFAULT_PREFERENCE.
export async function resolveAlertPreference(profileId: string): Promise<ResolvedAlertPreference> {
  const row = await prisma.buyerAlertPreference.findUnique({
    where: { customerProfileId: profileId },
    select: {
      wantedAvailableAlerts: true,
      wantedPriceChangeAlerts: true,
      emailAlertsEnabled: true,
      priceChangeThresholdPct: true,
    },
  })
  return row ?? DEFAULT_PREFERENCE
}

export type AlertEventRow = {
  id: string
  alertType: string
  catalogModelId: string
  listingId: string | null
  previousPriceCents: number | null
  currentPriceCents: number | null
  status: string
  createdAt: Date
  readAt: Date | null
  catalogModel: { brand: string; name: string; year: number | null }
  // Live availability at render time (not from the event snapshot) — avoids showing
  // stale "available" state for an item that sold since the alert was created.
  listingActive: boolean
}

const EVENT_SELECT = {
  id: true,
  alertType: true,
  catalogModelId: true,
  listingId: true,
  previousPriceCents: true,
  currentPriceCents: true,
  status: true,
  createdAt: true,
  readAt: true,
  catalogModel: { select: { brand: true, name: true, year: true } },
} as const

export async function getAlertEvents(
  profileId: string,
  cursor?: string,
): Promise<{ items: AlertEventRow[]; nextCursor: string | null }> {
  const rows = await prisma.buyerAlertEvent.findMany({
    where: { customerProfileId: profileId },
    orderBy: { id: 'desc' }, // cuid is time-ordered — id desc == newest first
    take: ALERT_PAGE_SIZE + 1,
    select: EVENT_SELECT,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  })

  const hasMore = rows.length > ALERT_PAGE_SIZE
  const page = hasMore ? rows.slice(0, ALERT_PAGE_SIZE) : rows

  const listingIds = [...new Set(page.map(r => r.listingId).filter((x): x is string => x !== null))]
  const activeListings = listingIds.length === 0 ? [] : await prisma.listing.findMany({
    where: { id: { in: listingIds }, status: 'active', item: { status: 'available' } },
    select: { id: true },
  })
  const activeSet = new Set(activeListings.map(l => l.id))

  return {
    items: page.map(r => ({ ...r, listingActive: r.listingId !== null && activeSet.has(r.listingId) })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  }
}

export async function getUnreadAlertCount(profileId: string): Promise<number> {
  return prisma.buyerAlertEvent.count({
    where: { customerProfileId: profileId, readAt: null },
  })
}

// Ownership-scoped: only marks the row read if it belongs to profileId.
export async function markAlertRead(id: string, profileId: string): Promise<boolean> {
  const result = await prisma.buyerAlertEvent.updateMany({
    where: { id, customerProfileId: profileId, readAt: null },
    data: { readAt: new Date() },
  })
  return result.count > 0
}

export async function markAllAlertsRead(profileId: string): Promise<number> {
  const result = await prisma.buyerAlertEvent.updateMany({
    where: { customerProfileId: profileId, readAt: null },
    data: { readAt: new Date() },
  })
  return result.count
}
