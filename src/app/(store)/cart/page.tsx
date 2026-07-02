import type { Metadata } from 'next'
import { CartPage } from '@/components/store/CartPage'

export const metadata: Metadata = {
  title: 'Cart | CollectNTrades',
  robots: { index: false, follow: false },
}

export default function CartRoute() {
  return <CartPage />
}
