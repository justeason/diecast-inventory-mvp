'use client'

import { useState, useCallback } from 'react'
import { type CartItem, getCart, addToCart, removeFromCart, clearCart } from './cart'

export function useCart() {
  const [items, setItems] = useState<CartItem[]>(getCart)

  const add = useCallback((item: CartItem) => {
    setItems(addToCart(item))
  }, [])

  const remove = useCallback((listingId: string) => {
    setItems(removeFromCart(listingId))
  }, [])

  const clear = useCallback(() => {
    clearCart()
    setItems([])
  }, [])

  const isInCart = useCallback(
    (listingId: string) => items.some((i) => i.listingId === listingId),
    [items]
  )

  return { items, add, remove, clear, isInCart }
}
