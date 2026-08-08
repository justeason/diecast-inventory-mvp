// 14A: Admin-only read queries. No buyer email/name — event ID, catalog model,
// alert type, timestamps, status, failure code only.

import { prisma } from '@/lib/prisma'

export type AlertStatusCounts = { pending: number; sending: number; sent: number; failed: number; suppressed: number; delivery_unknown: number }

export async function getAlertStatusCounts(): Promise<AlertStatusCounts> {
  const rows = await prisma.buyerAlertEvent.groupBy({ by: ['status'], _count: { id: true } })
  const counts: AlertStatusCounts = { pending: 0, sending: 0, sent: 0, failed: 0, suppressed: 0, delivery_unknown: 0 }
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof AlertStatusCounts] = r._count.id
  }
  return counts
}

export type FanoutStatusCounts = { pending: number; processing: number; complete: number; failed: number }

export async function getFanoutStatusCounts(): Promise<FanoutStatusCounts> {
  const rows = await prisma.buyerAlertFanout.groupBy({ by: ['status'], _count: { id: true } })
  const counts: FanoutStatusCounts = { pending: 0, processing: 0, complete: 0, failed: 0 }
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof FanoutStatusCounts] = r._count.id
  }
  return counts
}

export async function getOldestPendingAgeMs(): Promise<number | null> {
  const oldest = await prisma.buyerAlertEvent.findFirst({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })
  return oldest ? Date.now() - oldest.createdAt.getTime() : null
}

export async function getOldestPendingFanoutAgeMs(): Promise<number | null> {
  const oldest = await prisma.buyerAlertFanout.findFirst({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })
  return oldest ? Date.now() - oldest.createdAt.getTime() : null
}

const RECENT_ROWS_LIMIT = 20

export type RecentFailureRow = {
  id: string
  alertType: string
  createdAt: Date
  failureCode: string | null
  status: string
  catalogModel: { brand: string; name: string; year: number | null }
}

// Includes both 'failed' (definitive) and 'delivery_unknown' (ambiguous) — status is
// shown distinctly in the UI so admins don't mistake one for the other.
export async function getRecentFailures(): Promise<RecentFailureRow[]> {
  return prisma.buyerAlertEvent.findMany({
    where: { status: { in: ['failed', 'delivery_unknown'] } },
    orderBy: { createdAt: 'desc' },
    take: RECENT_ROWS_LIMIT,
    select: {
      id: true, alertType: true, createdAt: true, failureCode: true, status: true,
      catalogModel: { select: { brand: true, name: true, year: true } },
    },
  })
}
