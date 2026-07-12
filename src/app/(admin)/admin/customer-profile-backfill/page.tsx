/**
 * TEMPORARY PRODUCTION TOOL — DELETE AFTER BACKFILL IS COMPLETE.
 * File to delete: src/app/(admin)/admin/customer-profile-backfill/page.tsx
 *
 * Runs the CustomerProfile backfill inside the Vercel runtime so it uses
 * the same DATABASE_URL that production is connected to.
 */

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { normalizeEmail } from '@/lib/normalizeEmail'

export const dynamic = 'force-dynamic'

export default async function CustomerProfileBackfillPage({
  searchParams,
}: {
  searchParams: Promise<{
    done?: string
    linked?: string
    profiles?: string
    skipped?: string
  }>
}) {
  const sp = await searchParams

  // ── Live counts (re-queried on every load) ──────────────────────────────────
  const [orderCount, profileCount, nullProfileCount, invalidEmailCount] = await Promise.all([
    prisma.order.count(),
    prisma.customerProfile.count(),
    prisma.order.count({ where: { customerProfileId: null } }),
    prisma.order.count({
      where: {
        customerProfileId: null,
        OR: [
          { buyerEmail: '' },
          { buyerEmail: { not: { contains: '@' } } },
        ],
      },
    }),
  ])

  // ── Server action ───────────────────────────────────────────────────────────
  async function runBackfill(_formData: FormData) {
    'use server'

    const orders = await prisma.order.findMany({
      where: { customerProfileId: null },
      select: {
        id: true,
        buyerEmail: true,
        buyerName: true,
        buyerPhone: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    // Group by normalized email; skip blank / invalid
    const groups = new Map<string, typeof orders>()
    let skipped = 0

    for (const order of orders) {
      const normalized = normalizeEmail(order.buyerEmail ?? '')
      if (!normalized || !normalized.includes('@')) {
        skipped++
        continue
      }
      const existing = groups.get(normalized) ?? []
      existing.push(order)
      groups.set(normalized, existing)
    }

    let linked = 0
    let upserted = 0

    for (const [email, groupOrders] of groups) {
      // Use the last (most recently submitted) order for name/phone
      const latest = groupOrders[groupOrders.length - 1]

      const profile = await prisma.customerProfile.upsert({
        where:  { email },
        update: { name: latest.buyerName, phone: latest.buyerPhone ?? null },
        create: { email, name: latest.buyerName, phone: latest.buyerPhone ?? null },
        select: { id: true },
      })
      upserted++

      const ids = groupOrders.map((o) => o.id)
      const updated = await prisma.order.updateMany({
        where: { id: { in: ids }, customerProfileId: null },
        data:  { customerProfileId: profile.id },
      })
      linked += updated.count
    }

    redirect(
      `/admin/customer-profile-backfill?done=1&linked=${linked}&profiles=${upserted}&skipped=${skipped}`
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const hasPending = nullProfileCount > 0

  return (
    <div className="max-w-xl">
      {/* Warning */}
      <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-sm font-semibold text-amber-800">
          Temporary production-only tool. Run once, then delete this page.
        </p>
        <p className="mt-1 font-mono text-xs text-amber-700 break-all">
          src/app/(admin)/admin/customer-profile-backfill/page.tsx
        </p>
      </div>

      <h1 className="text-xl font-bold text-gray-900 mb-6">Customer Profile Backfill</h1>

      {/* Current counts */}
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
        Current database state
      </h2>
      <div className="mb-6 rounded-md border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {[
              ['Orders (total)',                          orderCount],
              ['CustomerProfiles (total)',                profileCount],
              ['Orders with null profileId',             nullProfileCount],
              ['Unlinked orders with blank/invalid email (will be skipped)', invalidEmailCount],
            ].map(([label, count]) => (
              <tr key={String(label)} className="bg-white">
                <td className="px-4 py-3 text-gray-600">{label}</td>
                <td className="px-4 py-3 text-right font-mono font-medium text-gray-900">
                  {String(count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Result banner */}
      {sp.done === '1' && (
        <div className="mb-6 rounded-md border border-green-200 bg-green-50 px-4 py-4 text-sm">
          <p className="font-semibold text-green-800 mb-2">Backfill complete</p>
          <dl className="space-y-1">
            <div className="flex justify-between">
              <dt className="text-green-700">Orders linked</dt>
              <dd className="font-mono font-medium text-green-900">{sp.linked ?? '0'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-green-700">Profiles created / updated</dt>
              <dd className="font-mono font-medium text-green-900">{sp.profiles ?? '0'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-green-700">Orders skipped (invalid email)</dt>
              <dd className="font-mono font-medium text-green-900">{sp.skipped ?? '0'}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-green-600">
            Counts above have been refreshed. Safe to run again — idempotent.
          </p>
        </div>
      )}

      {/* Action */}
      <form action={runBackfill}>
        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white
                     hover:bg-gray-700 transition-colors"
        >
          Run customer profile backfill
        </button>
        {!hasPending && (
          <p className="mt-2 text-xs text-gray-500">
            No unlinked orders found — nothing to do. Running again is safe and will
            return zeros.
          </p>
        )}
      </form>

      <div className="mt-8 border-t border-gray-200 pt-6 flex gap-6">
        <Link href="/admin/customers" className="text-sm text-gray-500 hover:text-gray-900">
          ← View Customers
        </Link>
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-900">
          ← Dashboard
        </Link>
      </div>
    </div>
  )
}
