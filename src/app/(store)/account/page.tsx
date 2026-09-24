import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { getAccountOverview } from '@/lib/accountOverviewQuery'
import { getAccountPersonalization, type AccountPersonalization } from '@/lib/accountPersonalizationQuery'
import { logger } from '@/lib/serverLogger'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { AccountNav } from '@/components/store/AccountNav'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { CatalogModelCard } from '@/components/store/CatalogModelCard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My Account | CollectNTrades',
  robots: { index: false, follow: false },
}

const SUBTITLE = 'Orders, collection, wanted list, and selling — all in one place.'

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending review', paid: 'Paid', picking: 'Preparing', shipped: 'Shipped', complete: 'Complete', cancelled: 'Cancelled',
}

// Same values as account/orders/page.tsx's own ORDER_STATUS_COLORS — colocated per
// that page's existing convention (every account page defines its own local
// label/color map), not a second status vocabulary.
const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700', paid: 'bg-blue-100 text-blue-700', picking: 'bg-purple-100 text-purple-700',
  shipped: 'bg-indigo-100 text-indigo-700', complete: 'bg-green-100 text-green-700', cancelled: 'bg-red-100 text-red-700',
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
        <p className="text-sm text-gray-500 mb-8">{SUBTITLE}</p>
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
  const ordersEmpty = overview.orders.activeCount === 0 && overview.orders.recent.length === 0

  // 36B: optional account enrichment, isolated from the core dashboard summary
  // above — a technical failure here must never make Orders/Collection/
  // Wanted/Selling unusable (mirrors 32B's optional-context principle). Never
  // catches the auth/session check above, only this personalization read.
  let personalization: AccountPersonalization | null = null
  try {
    personalization = await getAccountPersonalization(session.profileId)
  } catch (err) {
    logger.error('account_personalization_failed', err, { route: '/account' })
    personalization = null
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">My Account</h1>
      <p className="text-sm text-gray-500 mb-6">{SUBTITLE}</p>
      <AccountNav />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Orders">
          {overview.orders.activeCount > 0 ? (
            <p className="text-sm text-gray-700">{overview.orders.activeCount} active order{overview.orders.activeCount !== 1 ? 's' : ''}</p>
          ) : ordersEmpty ? (
            <p className="text-sm text-gray-400">No orders yet.</p>
          ) : (
            <p className="text-sm text-gray-500">No active orders</p>
          )}
          <CardActions>
            <CardAction href={ordersEmpty ? '/browse' : '/account/orders'} label={ordersEmpty ? 'Browse the catalog' : 'View Orders'} />
          </CardActions>
        </Card>

        <Card title="Collection">
          {overview.collection.itemCount > 0 ? (
            <>
              <p className="text-sm text-gray-700">{overview.collection.itemCount} item{overview.collection.itemCount !== 1 ? 's' : ''}</p>
              <p className="text-sm text-gray-700">{overview.collection.entryCount} entr{overview.collection.entryCount !== 1 ? 'ies' : 'y'}</p>
            </>
          ) : (
            <p className="text-sm text-gray-400">Start your collection.</p>
          )}
          <CardActions>
            <CardAction href="/account/collection" label={overview.collection.itemCount > 0 ? 'View Collection' : 'Add an item'} />
            {overview.collection.itemCount > 0 && <CardAction href="/account/collection/new" label="Add Item" secondary />}
          </CardActions>
        </Card>

        <Card title="Wanted & Alerts">
          {overview.wanted.wantedCount > 0 ? (
            <>
              <p className="text-sm text-gray-700">{overview.wanted.wantedCount} wanted</p>
              {overview.wanted.unreadAlertCount > 0 && (
                <p className="text-sm text-gray-500">{overview.wanted.unreadAlertCount} new alert{overview.wanted.unreadAlertCount !== 1 ? 's' : ''}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400">Nothing on your wanted list yet.</p>
          )}
          <CardActions>
            {overview.wanted.wantedCount > 0 ? (
              <>
                <CardAction href="/account/wanted" label="View Wanted & Alerts" />
                <CardAction href="/account/wanted?available=1" label="Check Available Matches" secondary />
              </>
            ) : (
              <CardAction href="/browse" label="Browse models" />
            )}
          </CardActions>
        </Card>

        <Card title="Selling">
          {overview.selling.outstandingPayoutCents > 0 ? (
            <p className="text-sm text-gray-700">${(overview.selling.outstandingPayoutCents / 100).toFixed(2)} outstanding payout</p>
          ) : (
            <p className="text-sm text-gray-400">Track your selling activity.</p>
          )}
          <CardActions>
            <CardAction href="/account/portfolios" label="View Selling" />
            <CardAction href="/account/sell" label="Sell Something" secondary />
          </CardActions>
        </Card>
      </div>

      <div className="mt-10">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <QuickAction href="/browse" label="Browse Catalog" />
          <QuickAction href="/account/sell" label="Sell Something" />
          <QuickAction href="/account/capture" label="Quick Capture" />
          <QuickAction href="/order-status" label="Order Status" />
        </div>
      </div>

      <div className="mt-10">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Recent Orders</h2>
        {overview.orders.recent.length > 0 ? (
          <div className="rounded-md border border-gray-200 divide-y divide-gray-100 bg-white">
            {overview.orders.recent.map((o) => (
              <Link
                key={o.id}
                href="/account/orders"
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm hover:bg-gray-50 transition-colors"
              >
                <span className="text-gray-500">
                  {o.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-100 text-gray-600'}`}>
                  {ORDER_STATUS_LABELS[o.status] ?? o.status}
                </span>
                {o.totalCents !== null && (
                  <span className="tabular-nums text-gray-700 font-medium">${(o.totalCents / 100).toFixed(2)}</span>
                )}
              </Link>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-gray-300 px-4 py-6 text-center">
            <p className="text-sm text-gray-500 mb-1">No orders yet.</p>
            <Link href="/browse" className="text-sm font-medium text-gray-900 hover:underline underline-offset-2">
              Browse the catalog →
            </Link>
          </div>
        )}
      </div>

      {personalization && personalization.recentlyAdded.length > 0 && (
        <div className="mt-10">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Recently added to your Collection</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {personalization.recentlyAdded.map((entry) => (
              <Link
                key={entry.id}
                href={`/account/collection/${entry.id}`}
                className="block rounded-lg border border-gray-200 overflow-hidden bg-white hover:border-gray-400 transition-colors"
              >
                <div className="aspect-square overflow-hidden relative">
                  <PhotoThumbnail photoUrl={entry.photoUrl} alt={`${entry.brand} ${entry.name}`} size="fill" />
                </div>
                <div className="p-3">
                  <p className="text-xs font-medium text-gray-900 line-clamp-2 leading-snug">
                    {entry.brand} {entry.name}{entry.year ? ` (${entry.year})` : ''}
                  </p>
                  {entry.series && <p className="text-xs text-gray-400 mt-0.5 truncate">{entry.series}</p>}
                  {entry.quantity > 1 && <p className="text-xs text-gray-500 mt-0.5">You own {entry.quantity}</p>}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {personalization && personalization.continueCollecting.length > 0 && (
        <div className="mt-10">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Continue collecting</h2>
          <p className="text-sm text-gray-500 mb-3">Explore models related to your Collection.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6">
            {personalization.continueCollecting.map((candidate) => (
              <div key={candidate.model.id}>
                <p className="text-xs text-gray-500 mb-1.5">{candidate.reason.label}</p>
                <CatalogModelCard
                  model={candidate.model}
                  availability={candidate.availability}
                  relationship={candidate.relationship}
                  marketValuation={candidate.marketValuation}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 p-4">
      <h2 className="text-sm font-semibold text-gray-900 mb-2">{title}</h2>
      {children}
    </div>
  )
}

function CardActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{children}</div>
}

function CardAction({ href, label, secondary }: { href: string; label: string; secondary?: boolean }) {
  return (
    <Link
      href={href}
      className={secondary ? 'text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2' : 'text-sm font-medium text-blue-600 hover:underline'}
    >
      {label} →
    </Link>
  )
}

function QuickAction({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
      {label}
    </Link>
  )
}
