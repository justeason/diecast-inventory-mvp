'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

const CATEGORIES = [
  {
    label: 'Hot Wheels',
    items: [
      { label: 'All Hot Wheels',           href: '/browse?brand=Hot%20Wheels' },
      { label: 'Zamac Hot Wheels',         href: '/browse?brand=Hot%20Wheels&q=Zamac' },
      { label: '2026 K Case Latest Sets',  href: '/browse?brand=Hot%20Wheels&q=K%20Case' },
      { label: 'Super Treasure Hunt',      href: '/browse?brand=Hot%20Wheels&q=Super%20Treasure%20Hunt' },
      { label: 'Treasure Hunt',            href: '/browse?brand=Hot%20Wheels&q=Treasure%20Hunt' },
      { label: 'Premium',                  href: '/browse?brand=Hot%20Wheels&q=Premium' },
      { label: 'Mainline',                 href: '/browse?brand=Hot%20Wheels&q=Mainline' },
    ],
  },
  {
    label: 'Matchbox',
    items: [
      { label: 'All Matchbox',   href: '/browse?brand=Matchbox' },
      { label: 'Mainline',       href: '/browse?brand=Matchbox&q=Mainline' },
      { label: 'Premium',        href: '/browse?brand=Matchbox&q=Premium' },
      { label: 'New Releases',   href: '/browse?brand=Matchbox&q=New%20Releases' },
    ],
  },
  {
    label: 'Pokémon Cards',
    items: [
      { label: 'All Pokémon Cards',   href: '/browse?q=Pok%C3%A9mon' },
      { label: 'Sealed Products',     href: '/browse?q=Sealed' },
      { label: 'Single Cards',        href: '/browse?q=Single%20Cards' },
      { label: 'Booster Packs',       href: '/browse?q=Booster%20Packs' },
      { label: 'Elite Trainer Boxes', href: '/browse?q=Elite%20Trainer%20Box' },
    ],
  },
]

export function CategoryNav() {
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent | TouchEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenCategory(null)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('touchstart', handleOutsideClick)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('touchstart', handleOutsideClick)
    }
  }, [])

  function toggle(label: string) {
    setOpenCategory((prev) => (prev === label ? null : label))
  }

  return (
    <div className="border-t border-gray-100">
      <nav ref={navRef} className="mx-auto max-w-7xl px-6 flex items-center gap-1 h-10">
        {CATEGORIES.map((category) => {
          const isOpen = openCategory === category.label
          return (
            <div key={category.label} className="group relative">
              {/* Top-level trigger — button on all screen sizes.
                  Desktop: CSS group-hover still opens the dropdown on hover.
                  Mobile: click/tap toggles via JS state. */}
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={() => toggle(category.label)}
                className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors"
              >
                {category.label}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className={`h-3 w-3 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {/* Dropdown — JS state (isOpen) wins; CSS hover is a bonus on desktop */}
              <div
                role="menu"
                className={`absolute top-full left-0 z-50 min-w-[200px] rounded-md border border-gray-200 bg-white py-1 shadow-lg ${
                  isOpen ? 'block' : 'hidden group-hover:block group-focus-within:block'
                }`}
              >
                {category.items.map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    role="menuitem"
                    onClick={() => setOpenCategory(null)}
                    className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          )
        })}
      </nav>
    </div>
  )
}
