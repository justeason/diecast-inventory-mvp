import Link from 'next/link'
import { logoutAdmin } from '@/lib/actions/auth'
import { getAdminAttentionBadges } from '@/lib/adminOperationsQuery'
import { AdminNav } from '@/components/admin/AdminNav'
import { AdminSearchBox } from '@/components/admin/AdminSearchBox'

// 15H Part G — grouped nav replaces the flat ~28-link header. Badges are one bounded
// query composed of cheap groupBy/count reads (Part N section 41), shared by both
// the nav badges here and the command-center Needs Attention section.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const badges = await getAdminAttentionBadges()
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-7xl px-6 flex items-center gap-4 h-14 border-b border-gray-100">
          <Link href="/admin" className="font-semibold text-gray-900">Admin</Link>
          <div className="ml-auto flex items-center gap-4">
            <AdminSearchBox />
            <form action={logoutAdmin}>
              <button type="submit" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">
                Logout
              </button>
            </form>
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-6">
          <AdminNav
            badges={{
              exceptions: badges.intakeExceptions,
              approvals: badges.pendingApprovals,
              shipments: badges.shipmentDiscrepancies,
            }}
          />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
