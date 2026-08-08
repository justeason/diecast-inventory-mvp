import Link from 'next/link'
import { CartCountBadge } from '@/components/store/CartCountBadge'
import { CategoryNav } from '@/components/store/CategoryNav'
import { getBuyerSession } from '@/lib/buyerSession'
import { getUnreadAlertCount } from '@/lib/buyerAlertsQuery'

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const session = await getBuyerSession()
  const unreadAlerts = session ? await getUnreadAlertCount(session.profileId) : 0

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-7xl px-6 flex items-center h-14 gap-6">
          {/* Left: brand + nav links */}
          <Link href="/" className="font-semibold text-gray-900 shrink-0">
            Diecast Shop
          </Link>
          <Link href="/browse" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Browse
          </Link>
          <Link href="/market" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Marketplace
          </Link>
          <Link href="/order-status" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Order Status
          </Link>
          <Link href="/account/orders" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            My Orders
          </Link>
          <Link href="/account/collection" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            My Collection
          </Link>
          <Link href="/account/wanted" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Wanted
          </Link>
          <Link href="/account/alerts" className="relative text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Alerts
            {unreadAlerts > 0 && (
              <span className="absolute -top-2 -right-3 flex h-4 w-4 items-center justify-center rounded-full bg-gray-900 text-[10px] font-bold text-white">
                {unreadAlerts > 99 ? '99+' : unreadAlerts}
              </span>
            )}
          </Link>
          <Link href="/account/community" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            My Profile
          </Link>
          <Link href="/community" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Community
          </Link>
          <Link href="/account/sell" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Sell
          </Link>
          <Link href="/account/capture" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Quick Capture
          </Link>

          {/* Right: cart */}
          <div className="ml-auto flex items-center">
            <CartCountBadge />
          </div>
        </nav>
        <CategoryNav />
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
