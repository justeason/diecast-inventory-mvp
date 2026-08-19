import { CategoryNav } from '@/components/store/CategoryNav'
import { CustomerHeader } from '@/components/store/CustomerHeader'
import { getBuyerSession } from '@/lib/buyerSession'
import { getUnreadAlertCount } from '@/lib/buyerAlertsQuery'

// 16A: primary customer navigation simplified to five stable concepts (Shop / Sell /
// Community / Order Status / Account) — see src/lib/customerNav.ts for the shared
// definition and CustomerHeader.tsx for the desktop/mobile/Account-menu rendering
// (which also hosts the cart badge, Part 26 — one shared nav component).
// isAuthenticated/unreadAlerts are resolved here (server, from the session cookie)
// and passed down as props — never inferred client-side (Part 23).
export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const session = await getBuyerSession()
  const unreadAlerts = session ? await getUnreadAlertCount(session.profileId) : 0

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200">
        <CustomerHeader isAuthenticated={!!session} unreadAlerts={unreadAlerts} />
        <CategoryNav />
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
