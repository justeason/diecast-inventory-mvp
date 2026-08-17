'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// 15H Part G — six operational domains + Settings, replacing the flat ~28-link nav.
// Legacy/superseded routes (raw intake operations, seller lifecycle cases, seller
// submissions-as-primary, export pages) are intentionally NOT listed here — they
// still work at their existing URLs (Part A section 4), just no longer compete with
// the daily workflow for top-level attention (Part J section 32).
//
// 15H focused-review section 3: every href below appears in exactly ONE group's
// children — Commission Policies and Locations previously appeared in both a
// domain group and Settings; both now have a single global-nav home (Settings).
// Domain hub pages (e.g. /admin/inventory, /admin/sellers) may still link to them
// contextually — that's not primary nav duplication.

export type NavChild = { href: string; label: string; badgeKey?: 'exceptions' | 'approvals' | 'shipments' }
export type NavGroup = { key: string; label: string; href: string; children: NavChild[] }

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'operations', label: 'Operations', href: '/admin',
    children: [
      { href: '/admin', label: 'Command Center' },
      { href: '/admin/intake', label: 'Intake' },
      { href: '/admin/intake/exceptions', label: 'Exceptions', badgeKey: 'exceptions' },
      { href: '/admin/approvals', label: 'Approvals', badgeKey: 'approvals' },
      { href: '/admin/intake/inbound', label: 'Inbound Shipments', badgeKey: 'shipments' },
    ],
  },
  {
    key: 'inventory', label: 'Inventory', href: '/admin/inventory',
    children: [
      { href: '/admin/inventory', label: 'Overview' },
      { href: '/admin/items', label: 'Items' },
      { href: '/admin/listings', label: 'Listings' },
      { href: '/admin/valuation', label: 'Valuation' },
      { href: '/admin/auto-listing', label: 'Auto-Listing' },
    ],
  },
  {
    key: 'sellers', label: 'Sellers', href: '/admin/sellers',
    children: [
      { href: '/admin/sellers', label: 'Overview' },
      { href: '/admin/seller-portfolios', label: 'Portfolios' },
      { href: '/admin/seller-profiles', label: 'Profiles' },
      { href: '/admin/seller-submissions', label: 'Submissions' },
    ],
  },
  {
    key: 'orders', label: 'Orders', href: '/admin/orders',
    children: [
      { href: '/admin/orders', label: 'Orders' },
      { href: '/admin/customers', label: 'Customers' },
    ],
  },
  {
    key: 'finance', label: 'Finance', href: '/admin/finance',
    children: [
      { href: '/admin/finance', label: 'Overview' },
      { href: '/admin/finance/position', label: 'Financial Position' },
      { href: '/admin/seller-payouts', label: 'Payouts' },
      { href: '/admin/reconciliation', label: 'Reconciliation' },
      { href: '/admin/analytics', label: 'Analytics' },
    ],
  },
  {
    key: 'catalog', label: 'Catalog', href: '/admin/catalog',
    children: [
      { href: '/admin/catalog', label: 'Models' },
      { href: '/admin/catalog-quality', label: 'Quality' },
      { href: '/admin/catalog/duplicates', label: 'Duplicates' },
      { href: '/admin/catalog-suggestions', label: 'Suggestions' },
      { href: '/admin/market-research', label: 'Market Data' },
      { href: '/admin/catalog-image-intelligence', label: 'Image Intelligence' },
      { href: '/admin/resale-estimator', label: 'Resale Estimator' },
    ],
  },
  {
    key: 'settings', label: 'Settings', href: '/admin/commission-policies',
    children: [
      { href: '/admin/commission-policies', label: 'Commission Policies' },
      { href: '/admin/risk-policies', label: 'Risk Policies' },
      { href: '/admin/locations', label: 'Locations' },
      { href: '/admin/system-health', label: 'System Health' },
      { href: '/admin/system/alerts', label: 'Buyer Alerts' },
    ],
  },
]

// Exported for logic tests (adminNav.test.ts) — no DOM/React rendering required.
export function matches(pathname: string, href: string): boolean {
  return pathname === href || (href !== '/admin' && pathname.startsWith(href + '/'))
}

export function activeGroup(pathname: string): NavGroup | null {
  for (const group of NAV_GROUPS) {
    if (group.children.some((c) => matches(pathname, c.href))) return group
  }
  return null
}

export type AdminNavBadges = { exceptions: number; approvals: number; shipments: number }

export function AdminNav({ badges }: { badges: AdminNavBadges }) {
  const pathname = usePathname()
  const active = activeGroup(pathname) ?? NAV_GROUPS[0]

  return (
    <div>
      <nav className="flex items-center gap-1 h-12 overflow-x-auto">
        {NAV_GROUPS.map((group) => (
          <Link
            key={group.key}
            href={group.href}
            className={`shrink-0 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              group.key === active.key ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {group.label}
          </Link>
        ))}
      </nav>
      <nav className="flex items-center gap-4 h-10 border-t border-gray-100 overflow-x-auto">
        {active.children.map((child) => {
          const count = child.badgeKey ? badges[child.badgeKey] : undefined
          return (
            <Link
              key={child.href}
              href={child.href}
              className={`shrink-0 text-sm ${matches(pathname, child.href) ? 'text-gray-900 font-semibold' : 'text-gray-500 hover:text-gray-900'}`}
            >
              {child.label}
              {!!count && (
                <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                  {count}
                </span>
              )}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
