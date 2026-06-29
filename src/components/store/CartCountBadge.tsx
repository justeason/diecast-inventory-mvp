'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { getCart, type CartItem } from '@/lib/cart'

export function CartCountBadge() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const update = () => {
      const cart = getCart() as Array<CartItem & { quantity?: number }>
      const total = cart.reduce((sum, item) => sum + (item.quantity ?? 1), 0)
      setCount(total)
    }

    update()
    window.addEventListener('cart-updated', update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener('cart-updated', update)
      window.removeEventListener('storage', update)
    }
  }, [])

  return (
    <Link
      href="/cart"
      className="relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>
      <span>Cart</span>
      {count > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-gray-900 text-[10px] font-bold text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  )
}
