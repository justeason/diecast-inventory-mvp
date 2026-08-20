import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { getAccountOverview } from '@/lib/accountOverviewQuery'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { AccountNav } from '@/components/store/AccountNav'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My Account | CollectNTrades',
  robots: { index: false, follow: false },
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending review', paid: 'Paid', picking: 'Preparing', shipped: 'Shipped', complete: 'Complete', cancelled: 'Cancelled',
}

// 16B: the customer home. Anonymous visitors get the existing sign-in/access
// experience only — no private counts are queried or rendered before
// authentication (Part N/28, Part O/29). Authenticated identity comes exclusively
// from the server-verified session, never request input (Part N/27).
export default async function AccountOverviewPage() {
  const session = await getBuyerSession()

  if (!session) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">My Account</h1>
        <p className="text-sm text-gray-500 mb-8">
          Sign in to manage your orders, collection, wanted list, and selling activity.
        </p>
        <BuyerOrderAccessForm />
        <p className="mt-6 text-sm text-gray-400">
          Have an order ID?{' '}
          <Link href="/order-status" className="text-gray-500 hover:text-gray-900 underline underline-offset-2">
            Check a single order status.
          </Link>
        </p>
      </div>
    )
  }

  const overview = await getAccountOverview(session.profileId)

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">My Account</h1>
      <AccountNav />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Orders" href="/account/orders">
          {overview.orders.activeCount > 0 ? (
            <p className="text-sm text-gray-700">{overview.orders.activeCount} active order{overview.orders.activeCount !== 1 ? 's' : ''}</p>
          ) : overview.orders.recent.length > 0 ? (
            <p className="text-sm text-gray-500">No active orders</p>
          ) : (
            <EmptyState text="No orders yet." actionLabel="Browse the catalog" actionHref="/browse" />
          )}
          {overview.orders.recent.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-gray-400">
              {overview.orders.recent.map((o) => (
                <li key={o.id}>
                  {o.createdAt.toLocaleDateString()} · {ORDER_STATUS_LABELS[o.status] ?? o.status}
                  {o.totalCents !== null && <> · ${(o.totalCents / 100).toFixed(2)}</>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Collection" href="/account/collection">
          {overview.collection.itemCount > 0 ? (
            <p className="text-sm text-gray-700">
              {overview.collection.itemCount} item{overview.collection.itemCount !== 1 ? 's' : ''} · {overview.collection.uniqueModelCount} unique model{overview.collection.uniqueModelCount !== 1 ? 's' : ''}
            </p>
          ) : (
            <EmptyState text="Start your collection." actionLabel="Add an item" actionHref="/account/collection/new" />
          )}
        </Card>

        <Card title="Wanted & Alerts" href="/account/wanted">
          {overview.wanted.wantedCount > 0 ? (
            <p className="text-sm text-gray-700">{overview.wanted.wantedCount} wanted</p>
          ) : (
            <EmptyState text="Nothing on your wanted list yet." actionLabel="Browse models" actionHref="/browse" />
          )}
          {overview.wanted.unreadAlertCount > 0 && (
            <p className="text-sm text-gray-500 mt-0.5">{overview.wanted.unreadAlertCount} new alert{overview.wanted.unreadAlertCount !== 1 ? 's' : ''}</p>
          )}
          <Link href="/account/wanted" className="mt-2 inline-block text-sm text-blue-600 hover:underline">
            Check available matches →
          </Link>
        </Card>

        <Card title="Selling" href="/account/portfolios">
          {overview.selling.outstandingPayoutCents > 0 && (
            <p className="text-sm text-gray-700">${(overview.selling.outstandingPayoutCents / 100).toFixed(2)} payout outstanding</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/account/portfolios" className="text-sm text-blue-600 hover:underline">View Selling →</Link>
            <Link href="/account/sell" className="text-sm text-blue-600 hover:underline">Sell Something →</Link>
          </div>
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <QuickAction href="/browse" label="Browse Catalog" />
          <QuickAction href="/account/sell" label="Sell Something" />
          <QuickAction href="/account/capture" label="Quick Capture" />
          <QuickAction href="/order-status" label="Check Order Status" />
        </div>
      </div>
    </div>
  )
}

function Card({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <Link href={href} className="text-xs text-blue-600 hover:underline">View →</Link>
      </div>
      {children}
    </div>
  )
}

function EmptyState({ text, actionLabel, actionHref }: { text: string; actionLabel: string; actionHref: string }) {
  return (
    <div>
      <p className="text-sm text-gray-400">{text}</p>
      <Link href={actionHref} className="text-sm text-blue-600 hover:underline">{actionLabel} →</Link>
    </div>
  )
}

function QuickAction({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
      {label}
    </Link>
  )
}
