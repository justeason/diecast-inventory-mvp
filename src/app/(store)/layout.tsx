import Link from 'next/link'

export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-7xl px-6 flex items-center gap-6 h-14">
          <Link href="/" className="font-semibold text-gray-900 mr-4">
            Diecast Shop
          </Link>
          <Link href="/browse" className="text-sm text-gray-600 hover:text-gray-900">
            Browse
          </Link>
          <Link href="/cart" className="text-sm text-gray-600 hover:text-gray-900">
            Cart
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}
