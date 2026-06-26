export type CartItem = {
  listingId: string
  title: string
  price: number
  sku: string
  condition: string
  cardedOrLoose: string
}

const CART_KEY = 'diecast-cart'

export function getCart(): CartItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(CART_KEY)
    return raw ? (JSON.parse(raw) as CartItem[]) : []
  } catch {
    return []
  }
}

export function addToCart(item: CartItem): CartItem[] {
  const cart = getCart()
  if (cart.some((i) => i.listingId === item.listingId)) return cart
  const updated = [...cart, item]
  localStorage.setItem(CART_KEY, JSON.stringify(updated))
  return updated
}

export function removeFromCart(listingId: string): CartItem[] {
  const updated = getCart().filter((i) => i.listingId !== listingId)
  localStorage.setItem(CART_KEY, JSON.stringify(updated))
  return updated
}

export function clearCart(): void {
  localStorage.removeItem(CART_KEY)
}
