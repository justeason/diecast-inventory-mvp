/**
 * TEMPORARY diagnostic page — safe to delete after the investigation is resolved.
 * Shows which database Vercel is connected to and basic table counts.
 * No credentials are rendered — only host, db name, and row counts.
 */
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export default async function AdminDbCheckPage() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  let host   = '(unable to parse)'
  let dbName = '(unable to parse)'
  try {
    const u = new URL(dbUrl)
    host   = u.hostname
    dbName = u.pathname.replace(/^\//, '') || '(none)'
  } catch { /* leave defaults */ }

  const [orderCount, profileCount, nullProfileCount] = await Promise.all([
    prisma.order.count(),
    prisma.customerProfile.count(),
    prisma.order.count({ where: { customerProfileId: null } }),
  ])

  const rows = [
    { label: 'DATABASE_URL present',         value: String(Boolean(dbUrl)) },
    { label: 'Database host',                value: host },
    { label: 'Database name',               value: dbName },
    { label: 'Orders (total)',              value: String(orderCount) },
    { label: 'CustomerProfiles (total)',    value: String(profileCount) },
    { label: 'Orders with null profileId', value: String(nullProfileCount) },
  ]

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-bold text-gray-900 mb-1">DB Diagnostic</h1>
      <p className="text-xs text-amber-600 mb-6">
        Temporary page — delete after investigation is resolved.
      </p>
      <div className="rounded-md border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.label} className="bg-white">
                <td className="px-4 py-3 text-gray-500 w-56 shrink-0">{r.label}</td>
                <td className="px-4 py-3 font-mono text-gray-900">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
