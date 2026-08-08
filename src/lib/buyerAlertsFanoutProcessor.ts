// 14A: Durable fan-out processor. Claims BuyerAlertFanout jobs (bounded lease, safe
// under concurrent/duplicate invocations), resumes each job from its stored cursor,
// and creates BuyerAlertEvent rows in bounded pages. Never sends email — that's
// processPendingBuyerAlerts in buyerAlertsDelivery.ts.

import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/serverLogger'
import { isMeaningfulPriceChange } from '@/lib/buyerAlertKeys'
import { generateClaimToken, staleBefore, FANOUT_LEASE_MS } from '@/lib/buyerAlertsLease'

const FANOUT_PAGE_SIZE = 200
const JOB_BATCH_SIZE = 20

type WantedRow = {
  id: string
  customerProfileId: string
  availabilityAlertEnabled: boolean
  priceAlertEnabled: boolean
}

// Batch-fetches preferences for a page of profileIds — avoids one query per buyer.
async function loadPreferences(
  profileIds: string[],
): Promise<Map<string, { wantedAvailableAlerts: boolean; wantedPriceChangeAlerts: boolean; emailAlertsEnabled: boolean; priceChangeThresholdPct: number | null }>> {
  const rows = await prisma.buyerAlertPreference.findMany({
    where: { customerProfileId: { in: profileIds } },
    select: { customerProfileId: true, wantedAvailableAlerts: true, wantedPriceChangeAlerts: true, emailAlertsEnabled: true, priceChangeThresholdPct: true },
  })
  return new Map(rows.map(r => [r.customerProfileId, r]))
}

type EventInput = {
  customerProfileId: string
  catalogModelId: string
  listingId: string
  alertType: string
  eventKey: string
  previousPriceCents: number | null
  currentPriceCents: number | null
  status: 'pending' | 'suppressed'
}

// Claims one job: fresh 'pending' rows get startedAt set; recovered stale 'processing'
// rows (a prior worker crashed mid-traversal) keep their original startedAt.
async function claimFanoutJob(id: string): Promise<string | null> {
  const token = generateClaimToken()
  const now = new Date()

  const fromPending = await prisma.buyerAlertFanout.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'processing', claimedAt: now, claimToken: token, startedAt: now },
  })
  if (fromPending.count === 1) return token

  const fromStale = await prisma.buyerAlertFanout.updateMany({
    where: { id, status: 'processing', claimedAt: { lt: staleBefore(FANOUT_LEASE_MS) } },
    data: { status: 'processing', claimedAt: now, claimToken: token },
  })
  return fromStale.count === 1 ? token : null
}

// Resumes a job from its stored cursor and pages through WantedCatalogModel rows for
// job.catalogModelId. Persists the cursor after each page BEFORE moving to the next —
// so a crash mid-traversal resumes at the next page, not from the start — and verifies
// claimToken before every write, so a reclaimed (stolen) lease stops this worker cold.
async function runFanoutJob(jobId: string, claimToken: string): Promise<'completed' | 'lease_lost'> {
  const job = await prisma.buyerAlertFanout.findUnique({ where: { id: jobId } })
  if (!job) return 'completed' // nothing to do — treat a vanished job as trivially done

  const isAvailability = job.eventType === 'wanted_available'
  let cursor = job.cursor ?? undefined

  for (;;) {
    // audienceCutoffAt excludes buyers who added the model to their wanted list AFTER
    // this transition — otherwise a buyer who joins hours later while an old job is
    // still (or newly) processing would incorrectly get a historical alert. Applies to
    // both availability and price-change jobs — the audience query is shared.
    const rows: WantedRow[] = await prisma.wantedCatalogModel.findMany({
      where: { catalogModelId: job.catalogModelId, createdAt: { lte: job.audienceCutoffAt } },
      orderBy: { id: 'asc' },
      take: FANOUT_PAGE_SIZE,
      select: { id: true, customerProfileId: true, availabilityAlertEnabled: true, priceAlertEnabled: true },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })

    if (rows.length > 0) {
      const prefs = await loadPreferences(rows.map(r => r.customerProfileId))
      const events: EventInput[] = []

      for (const row of rows) {
        if (isAvailability && !row.availabilityAlertEnabled) continue
        if (!isAvailability && !row.priceAlertEnabled) continue

        const pref = prefs.get(row.customerProfileId)
        const typeEnabled = isAvailability ? (pref?.wantedAvailableAlerts ?? true) : (pref?.wantedPriceChangeAlerts ?? true)
        if (!typeEnabled) continue

        if (!isAvailability) {
          if (job.previousPriceCents === null || job.currentPriceCents === null) continue
          if (!isMeaningfulPriceChange(job.previousPriceCents, job.currentPriceCents, pref?.priceChangeThresholdPct)) continue
        }

        const emailEnabled = pref?.emailAlertsEnabled ?? true
        events.push({
          customerProfileId: row.customerProfileId,
          catalogModelId: job.catalogModelId,
          listingId: job.listingId,
          alertType: job.eventType,
          eventKey: job.eventKey,
          previousPriceCents: job.previousPriceCents,
          currentPriceCents: job.currentPriceCents,
          status: emailEnabled ? 'pending' : 'suppressed',
        })
      }

      if (events.length > 0) {
        // Idempotent: re-running this page (e.g. after a crash before the cursor
        // checkpoint below) cannot double-create — @@unique([customerProfileId, eventKey]).
        await prisma.buyerAlertEvent.createMany({ data: events, skipDuplicates: true })
      }

      const lastId = rows[rows.length - 1].id
      // claimToken-scoped: if another worker's stale-lease reclaim already stole this
      // job (this worker's own lease expired mid-traversal on a large fan-out), this
      // write affects 0 rows — this worker must stop immediately and must NOT advance
      // the cursor or mark complete, so it can never regress the new owner's progress.
      // claimedAt is renewed on every successful checkpoint so an actively-progressing
      // worker's lease never goes stale purely from taking longer than FANOUT_LEASE_MS
      // to finish a large wanted-list — only a truly stalled/crashed worker goes stale.
      const checkpoint = await prisma.buyerAlertFanout.updateMany({
        where: { id: jobId, claimToken },
        data: { cursor: lastId, claimedAt: new Date() },
      })
      if (checkpoint.count === 0) return 'lease_lost' // another worker owns this job now — stop immediately
      cursor = lastId
    }

    if (rows.length < FANOUT_PAGE_SIZE) {
      const finished = await prisma.buyerAlertFanout.updateMany({
        where: { id: jobId, claimToken },
        data: { status: 'complete', completedAt: new Date() },
      })
      return finished.count === 1 ? 'completed' : 'lease_lost'
    }
  }
}

export type FanoutProcessResult = { claimed: number; completed: number; failed: number; leaseLost: number }

export async function processFanoutJobs(batchSize = JOB_BATCH_SIZE): Promise<FanoutProcessResult> {
  const candidates = await prisma.buyerAlertFanout.findMany({
    where: { OR: [{ status: 'pending' }, { status: 'processing', claimedAt: { lt: staleBefore(FANOUT_LEASE_MS) } }] },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true },
  })

  const result: FanoutProcessResult = { claimed: 0, completed: 0, failed: 0, leaseLost: 0 }

  for (const { id } of candidates) {
    const token = await claimFanoutJob(id)
    if (!token) continue // lost the claim race to another worker
    result.claimed++

    try {
      const outcome = await runFanoutJob(id, token)
      if (outcome === 'completed') result.completed++
      else result.leaseLost++
    } catch (err) {
      await prisma.buyerAlertFanout.updateMany({
        where: { id, claimToken: token },
        data: { status: 'failed', failureCode: err instanceof Error ? err.name : 'unknown_error' },
      })
      result.failed++
      logger.error('buyerAlerts.fanout.jobFailed', err, { fanoutJobId: id })
    }
  }

  return result
}
