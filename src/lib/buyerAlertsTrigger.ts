// 14A: Durable fan-out job creation — call INSIDE the same transaction as the listing
// mutation. This never does buyer fan-out itself (no paging, no email) — it only writes
// one idempotent BuyerAlertFanout row recording that a transition happened. If the
// process crashes immediately after commit, the row survives and a later invocation of
// processFanoutJobs() (cron or admin) will still fan out correctly — see
// buyerAlertsFanoutProcessor.ts.

import type { Prisma } from '@prisma/client'
import { toCents, buildAvailableEventKey, buildPriceChangeEventKey } from '@/lib/buyerAlertKeys'

type Tx = Prisma.TransactionClient

export async function createAvailableFanoutJob(
  tx: Tx,
  catalogModelId: string,
  listingId: string,
  listingVersion: number,
): Promise<void> {
  const eventKey = buildAvailableEventKey(listingId, listingVersion)
  await tx.buyerAlertFanout.createMany({
    data: [{ eventType: 'wanted_available', listingId, catalogModelId, eventKey, listingVersion }],
    skipDuplicates: true,
  })
}

// Only call for a listing that is CURRENTLY available (checked by the caller — see
// listings.ts). Creates a job whenever price genuinely changed at all; per-buyer
// threshold filtering happens later, in the fan-out processor, because the threshold
// is a per-buyer preference the trigger has no need to know about.
export async function createPriceChangeFanoutJob(
  tx: Tx,
  catalogModelId: string,
  listingId: string,
  oldPriceDollars: number,
  newPriceDollars: number,
  listingVersion: number,
): Promise<void> {
  const oldCents = toCents(oldPriceDollars)
  const newCents = toCents(newPriceDollars)
  if (oldCents === newCents) return // unchanged after normalization — no job

  const eventType = newCents < oldCents ? 'wanted_price_decrease' : 'wanted_price_increase'
  const eventKey = buildPriceChangeEventKey(listingId, oldCents, newCents, listingVersion)

  await tx.buyerAlertFanout.createMany({
    data: [{
      eventType, listingId, catalogModelId, eventKey, listingVersion,
      previousPriceCents: oldCents, currentPriceCents: newCents,
    }],
    skipDuplicates: true,
  })
}
