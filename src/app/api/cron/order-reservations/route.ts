import { releaseExpiredReservations } from '@/lib/orderReservation'
import { logger } from '@/lib/serverLogger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Scheduled via vercel.json crons. Same CRON_SECRET bearer-auth pattern as
// /api/cron/order-digest and /api/cron/buyer-alerts. Not a public endpoint —
// requests without the correct secret are rejected before any work happens.
//
// A route existing in code is not proof it is scheduled — see vercel.json for
// the actual registered cadence. Every release this job performs is a
// DB-conditional guarded transition (see orderReservation.ts), so duplicate
// or overlapping invocations (Vercel may run more than once for the same
// tick, or the schedule itself may be coarser than the 30-minute reservation
// window on some plan tiers) are always safe — never a double-release, never
// a reopened sold Listing, never a reversed payment. This job does NOT
// guarantee exact-to-the-second expiration; it guarantees eventual, safe
// recovery no later than the next run after a reservation's deadline passes.
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const requestId = request.headers.get('x-request-id') ?? undefined
  const result = await releaseExpiredReservations()
  logger.info('orderReservations.cron.run', {
    requestId,
    checked: result.checked, released: result.released, retained: result.retained, reconciledPaid: result.reconciledPaid,
  })

  return Response.json({ ok: true, result })
}
