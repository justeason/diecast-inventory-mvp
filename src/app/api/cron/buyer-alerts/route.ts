import { processPendingBuyerAlerts } from '@/lib/buyerAlertsDelivery'
import { processFanoutJobs } from '@/lib/buyerAlertsFanoutProcessor'
import { logger } from '@/lib/serverLogger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Scheduled via vercel.json crons. Same CRON_SECRET bearer-auth pattern as
// /api/cron/order-digest. Not a public endpoint — requests without the correct
// secret are rejected before any work happens.
//
// This is the durability backstop, not the only path to delivery: fan-out jobs and
// alert events are both durable DB rows, so even if this cron never runs (or runs
// once/day on a Hobby-tier schedule — see vercel.json), a later invocation (this cron,
// or the admin "process next batch" button) still completes them correctly. Vercel may
// also invoke this route more than once for the same scheduled tick or run overlapping
// invocations — both fan-out and delivery claiming are DB-conditional, so concurrent/
// duplicate invocations are safe (see buyerAlertsLease.ts).
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const requestId = request.headers.get('x-request-id') ?? undefined
  const fanout = await processFanoutJobs()
  const delivery = await processPendingBuyerAlerts()
  logger.info('buyerAlerts.cron.run', {
    requestId,
    fanoutClaimed: fanout.claimed, fanoutCompleted: fanout.completed, fanoutFailed: fanout.failed, fanoutLeaseLost: fanout.leaseLost,
    deliveryClaimed: delivery.claimed, deliverySent: delivery.sent, deliveryFailed: delivery.failed, deliverySuppressed: delivery.suppressed, deliveryUnknown: delivery.unknown,
  })

  return Response.json({ ok: true, fanout, delivery })
}
