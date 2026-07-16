import Link from 'next/link'
import { CartCountBadge } from '@/components/store/CartCountBadge'
import { CategoryNav } from '@/components/store/CategoryNav'

export default function StoreLayout({ children }: { children: React.ReactNode }) {
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
          <Link href="/order-status" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Order Status
          </Link>
          <Link href="/account/orders" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            My Orders
          </Link>
          <Link href="/account/collection" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            My Collection
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
