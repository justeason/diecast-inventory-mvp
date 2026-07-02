import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'] })

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? 'https://collectntrades.com'),
  title: {
    default: 'CollectNTrades | Die-Cast Cars, Collectibles & Trading Cards',
    template: '%s',
  },
  description:
    'Shop collectible die-cast cars, Hot Wheels, Matchbox, Pokémon cards, and more from CollectNTrades.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.className}>
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  )
}
