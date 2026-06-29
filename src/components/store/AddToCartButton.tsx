'use client'

import { useCart } from '@/lib/use-cart'
import type { CartItem } from '@/lib/cart'

type Props = {
  item: CartItem
}

export function AddToCartButton({ item }: Props) {
  const { add, isInCart } = useCart()
  const inCart = isInCart(item.listingId)

  return (
    <button
      onClick={() => {
          add(item)
          window.dispatchEvent(new Event('cart-updated'))
        }}
      disabled={inCart}
      className={
        inCart
          ? 'w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-400 cursor-default'
          : 'w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors'
      }
    >
      {inCart ? 'In Cart' : 'Add to Cart'}
    </button>
  )
}
