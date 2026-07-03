import Link from 'next/link'
import { logoutAdmin } from '@/lib/actions/auth'

const navLinks = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/catalog', label: 'Catalog' },
  { href: '/admin/items', label: 'Items' },
  { href: '/admin/locations', label: 'Locations' },
  { href: '/admin/listings', label: 'Listings' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/intake', label: 'Intake' },
  { href: '/admin/analytics', label: 'Analytics' },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <nav className="mx-auto max-w-7xl px-6 flex items-center gap-6 h-14">
          <span className="font-semibold text-gray-900 mr-4">Admin</span>
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              {link.label}
            </Link>
          ))}
          <form action={logoutAdmin} className="ml-auto">
            <button
              type="submit"
              className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              Logout
            </button>
          </form>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
