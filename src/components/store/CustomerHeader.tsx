'use client'

// 16A: one shared customer navigation component — desktop links, Account menu
// (dropdown when authenticated, plain sign-in link when anonymous), and the mobile
// menu, all built from the same CUSTOMER_PRIMARY_NAV / CUSTOMER_ACCOUNT_LINKS
// source of truth (Part 26/27). `isAuthenticated`/`unreadAlerts` are computed
// server-side (buyer session cookie) and passed in as props — never inferred
// client-side, so there is no hydration mismatch and no client-trusted auth state
// (Part 23).
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOutBuyer } from '@/lib/actions/buyerAuth'
import { CartCountBadge } from '@/components/store/CartCountBadge'
import {
  CUSTOMER_PRIMARY_NAV, CUSTOMER_ACCOUNT_LINKS, CUSTOMER_ACCOUNT_ANONYMOUS_HREF,
  getCustomerPrimarySection,
} from '@/lib/customerNav'

const linkCls = (active: boolean) =>
  `text-sm transition-colors ${active ? 'text-gray-900 font-semibold' : 'text-gray-600 hover:text-gray-900'}`

export function CustomerHeader({ isAuthenticated, unreadAlerts }: { isAuthenticated: boolean; unreadAlerts: number }) {
  const pathname = usePathname()
  const activeSection = getCustomerPrimarySection(pathname)
  const [accountOpen, setAccountOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onOutsideClick(e: MouseEvent | TouchEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setAccountOpen(false)
    }
    document.addEventListener('mousedown', onOutsideClick)
    document.addEventListener('touchstart', onOutsideClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onOutsideClick)
      document.removeEventListener('touchstart', onOutsideClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // Route/pathname changes close any open menu — never leaves a stale open panel.
  // Adjusted during render (React's documented pattern for resetting state in
  // response to a prop/derived value change), not inside an effect.
  const [menuPathname, setMenuPathname] = useState(pathname)
  if (pathname !== menuPathname) {
    setMenuPathname(pathname)
    setAccountOpen(false)
    setMobileOpen(false)
    setMobileAccountOpen(false)
  }

  return (
    <nav className="mx-auto max-w-7xl px-6 flex items-center h-14 gap-6">
      <Link href="/" className="font-semibold text-gray-900 shrink-0">
        Diecast Shop
      </Link>

      {/* Desktop primary nav (Part 15) */}
      <div className="hidden md:flex items-center gap-6">
        {CUSTOMER_PRIMARY_NAV.map((item) => (
          <Link key={item.key} href={item.href} aria-current={activeSection === item.key ? 'page' : undefined} className={linkCls(activeSection === item.key)}>
            {item.label}
          </Link>
        ))}
      </div>

      <div className="ml-auto hidden md:flex items-center gap-4">
        <CartCountBadge />
        {isAuthenticated ? (
          <div ref={accountRef} className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((o) => !o)}
              className={`flex items-center gap-1 ${linkCls(activeSection === 'account')}`}
            >
              Account
              <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 text-gray-400 transition-transform ${accountOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {accountOpen && (
              <div role="menu" className="absolute top-full right-0 mt-1 z-50 min-w-[200px] rounded-md border border-gray-200 bg-white py-1 shadow-lg">
                {CUSTOMER_ACCOUNT_LINKS.map((link) => (
                  <Link key={link.key} href={link.href} role="menuitem" onClick={() => setAccountOpen(false)} className="flex items-center justify-between px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-gray-900">
                    {link.label}
                    {link.badge === 'unreadAlerts' && unreadAlerts > 0 && (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-900 text-[10px] font-bold text-white">{unreadAlerts > 99 ? '99+' : unreadAlerts}</span>
                    )}
                  </Link>
                ))}
                <form action={signOutBuyer} role="none">
                  <button type="submit" role="menuitem" className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-gray-900">
                    Sign Out
                  </button>
                </form>
              </div>
            )}
          </div>
        ) : (
          <Link href={CUSTOMER_ACCOUNT_ANONYMOUS_HREF} className={linkCls(activeSection === 'account')}>
            Account
          </Link>
        )}
      </div>

      {/* Mobile: cart stays reachable without opening the menu; toggle exposes the rest (Part 16) */}
      <div className="md:hidden ml-auto flex items-center gap-1">
        <CartCountBadge />
        <button
          type="button"
          aria-expanded={mobileOpen}
          aria-controls="customer-mobile-menu"
          aria-label="Toggle menu"
          onClick={() => setMobileOpen((o) => !o)}
          className="rounded-md p-2 text-gray-600 hover:bg-gray-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {mobileOpen ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
          </svg>
        </button>
      </div>

      {mobileOpen && (
        <div id="customer-mobile-menu" className="md:hidden absolute top-14 left-0 right-0 z-40 border-t border-gray-200 bg-white px-6 py-3 space-y-1 shadow-lg">
          {CUSTOMER_PRIMARY_NAV.map((item) => (
            <Link key={item.key} href={item.href} className={`block py-2 ${linkCls(activeSection === item.key)}`}>
              {item.label}
            </Link>
          ))}
          {isAuthenticated ? (
            <div className="pt-1">
              <button
                type="button"
                aria-expanded={mobileAccountOpen}
                aria-controls="customer-mobile-account"
                onClick={() => setMobileAccountOpen((o) => !o)}
                className={`flex w-full items-center justify-between py-2 ${linkCls(activeSection === 'account')}`}
              >
                Account
                <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 text-gray-400 transition-transform ${mobileAccountOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {mobileAccountOpen && (
                <div id="customer-mobile-account" className="pl-4 space-y-1">
                  {CUSTOMER_ACCOUNT_LINKS.map((link) => (
                    <Link key={link.key} href={link.href} className="flex items-center justify-between py-2 text-sm text-gray-600 hover:text-gray-900">
                      {link.label}
                      {link.badge === 'unreadAlerts' && unreadAlerts > 0 && (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-900 text-[10px] font-bold text-white">{unreadAlerts > 99 ? '99+' : unreadAlerts}</span>
                      )}
                    </Link>
                  ))}
                  <form action={signOutBuyer}>
                    <button type="submit" className="w-full text-left py-2 text-sm text-gray-600 hover:text-gray-900">
                      Sign Out
                    </button>
                  </form>
                </div>
              )}
            </div>
          ) : (
            <Link href={CUSTOMER_ACCOUNT_ANONYMOUS_HREF} className={`block py-2 ${linkCls(activeSection === 'account')}`}>
              Account
            </Link>
          )}
        </div>
      )}
    </nav>
  )
}
