'use client'

// 16B: shared account sub-navigation — rendered on /account and every /account/*
// personal page. Built from the SAME CUSTOMER_ACCOUNT_LINKS source of truth the
// header Account dropdown uses (Part 36) — no second, drifting tab list. Horizontally
// scrollable so it fits phone widths without wrapping into a dense grid (Part L/24).
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CUSTOMER_ACCOUNT_LINKS } from '@/lib/customerNav'

function isActive(href: string, pathname: string): boolean {
  return href === '/account' ? pathname === '/account' : pathname === href || pathname.startsWith(href + '/')
}

export function AccountNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Account" className="flex gap-1 overflow-x-auto border-b border-gray-200 mb-6">
      {CUSTOMER_ACCOUNT_LINKS.map((link) => {
        const active = isActive(link.href, pathname)
        return (
          <Link
            key={link.key}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 whitespace-nowrap px-3 py-2.5 text-sm border-b-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
              active ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-900'
            }`}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
