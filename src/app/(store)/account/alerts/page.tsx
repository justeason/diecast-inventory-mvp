import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { resolveAlertPreference, getAlertEvents, ALERT_PAGE_SIZE } from '@/lib/buyerAlertsQuery'
import { AlertPreferencesForm } from '@/components/store/AlertPreferencesForm'
import { MarkAlertReadButton, MarkAllAlertsReadButton } from '@/components/store/MarkAlertReadButtons'
import { AccountNav } from '@/components/store/AccountNav'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Alerts | CollectNTrades',
  robots: { index: false, follow: false },
}

const ALERT_LABELS: Record<string, string> = {
  wanted_available:       'Now available',
  wanted_price_decrease:  'Price dropped',
  wanted_price_increase:  'Price increased',
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const session = await getBuyerSession()
  if (!session) notFound()

  const { cursor } = await searchParams
  const [preference, { items, nextCursor }] = await Promise.all([
    resolveAlertPreference(session.profileId),
    getAlertEvents(session.profileId, cursor),
  ])

  const unreadCount = items.filter(i => i.readAt === null).length

  return (
    <div className="max-w-2xl space-y-8">
      <AccountNav />
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Alerts</h1>
        <p className="text-sm text-gray-500 mt-1">
          Notifications for models on your wanted list.
        </p>
      </div>

      <AlertPreferencesForm preference={preference} />

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          Notifications{unreadCount > 0 ? ` (${unreadCount} unread on this page)` : ''}
        </h2>
        <MarkAllAlertsReadButton />
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-400">No notifications yet.</p>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const name = `${item.catalogModel.brand} ${item.catalogModel.name}${item.catalogModel.year ? ` (${item.catalogModel.year})` : ''}`
            const isPriceChange = item.alertType === 'wanted_price_decrease' || item.alertType === 'wanted_price_increase'

            return (
              <div
                key={item.id}
                className={`rounded-md border px-4 py-3 ${item.readAt === null ? 'border-gray-300 bg-white' : 'border-gray-100 bg-gray-50'}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      {ALERT_LABELS[item.alertType] ?? item.alertType}
                    </p>
                    <p className="font-medium text-gray-900 truncate">{name}</p>

                    {isPriceChange && item.previousPriceCents !== null && item.currentPriceCents !== null && (
                      <p className="text-sm text-gray-600 mt-1">
                        <span className="line-through text-gray-400">{fmtUsd(item.previousPriceCents)}</span>
                        {' → '}
                        <span className="font-medium">{fmtUsd(item.currentPriceCents)}</span>
                      </p>
                    )}
                    {!isPriceChange && item.currentPriceCents !== null && (
                      <p className="text-sm text-gray-600 mt-1">{fmtUsd(item.currentPriceCents)}</p>
                    )}

                    <p className="text-xs text-gray-400 mt-1">
                      {item.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {' · '}
                      {item.listingActive ? 'Available' : 'No longer available'}
                    </p>

                    {item.listingActive && item.listingId && (
                      <Link
                        href={`/browse/${item.listingId}`}
                        className="text-xs font-medium text-gray-900 hover:underline underline-offset-2"
                      >
                        View listing →
                      </Link>
                    )}
                  </div>

                  {item.readAt === null && <MarkAlertReadButton id={item.id} />}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {(cursor || nextCursor) && (
        <div className="flex gap-4">
          {cursor && (
            <Link href="/account/alerts" className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2">
              ← First page
            </Link>
          )}
          {nextCursor && (
            <Link
              href={`/account/alerts?cursor=${encodeURIComponent(nextCursor)}`}
              className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
            >
              Next {ALERT_PAGE_SIZE} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
