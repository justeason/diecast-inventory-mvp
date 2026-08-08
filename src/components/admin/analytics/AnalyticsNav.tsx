import Link from 'next/link'

const TABS = [
  { href: '/admin/analytics', label: 'Overview' },
  { href: '/admin/analytics/inventory', label: 'Inventory' },
  { href: '/admin/analytics/conversion', label: 'Conversion' },
  { href: '/admin/analytics/payouts', label: 'Payouts' },
  { href: '/admin/analytics/sellers', label: 'Sellers' },
  { href: '/admin/analytics/revenue', label: 'Revenue' },
]

// Preserves the current filter query string across sub-nav links.
export function AnalyticsNav({ currentPath, queryString }: { currentPath: string; queryString: string }) {
  return (
    <nav className="flex gap-4 border-b border-gray-200 mb-6">
      {TABS.map(t => (
        <Link
          key={t.href}
          href={queryString ? `${t.href}?${queryString}` : t.href}
          className={`pb-2 text-sm border-b-2 -mb-px ${
            currentPath === t.href ? 'border-gray-900 font-medium text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-900'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
