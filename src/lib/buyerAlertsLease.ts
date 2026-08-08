// 14A: Shared delivery/fan-out lease primitives.
//
// Both BuyerAlertFanout and BuyerAlertEvent use the same claim pattern:
//   1. claim: updateMany({ where: { id, OR: [pending, stale-lease] }, data: { status: processing, claimedAt, claimToken } })
//      — succeeds (count===1) only if this call actually transitioned the row; a
//        concurrent claimant racing for the same row gets count===0 and backs off.
//   2. do the work
//   3. writeIfClaimValid: updateMany({ where: { id, claimToken }, data: {...} })
//      — only succeeds if THIS worker's token is still current. If the lease expired
//        mid-work and another worker's stale-recovery claim already overwrote
//        claimToken, this write affects 0 rows — a stale worker can never clobber a
//        fresher result.
//
// DB-level conditional updates are the correctness mechanism — no in-memory mutex,
// so this is safe across concurrent cron invocations, duplicate cron deliveries, and
// a simultaneous admin-triggered run.

import crypto from 'crypto'

export const DELIVERY_LEASE_MS = 5 * 60 * 1000  // email send is bounded to an 8s timeout
export const FANOUT_LEASE_MS   = 10 * 60 * 1000 // a large wanted-list traversal may span several pages

export function generateClaimToken(): string {
  return crypto.randomBytes(16).toString('hex')
}

export function staleBefore(leaseMs: number): Date {
  return new Date(Date.now() - leaseMs)
}
