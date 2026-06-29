import Link from 'next/link'
import { CartCountBadge } from '@/components/store/CartCountBadge'

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

          {/* Right: cart + auth placeholders */}
          <div className="ml-auto flex items-center gap-1">
            <CartCountBadge />

            <button
              type="button"
              disabled
              title="Coming soon"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-400 cursor-not-allowed select-none"
            >
              Sign In
            </button>

            <button
              type="button"
              disabled
              title="Coming soon"
              aria-label="Profile (coming soon)"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-400 cursor-not-allowed"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </button>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
