import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { getWantedList, getAvailableWantedList, getUnavailableWantedList, WANTED_PAGE_SIZE } from '@/lib/wantedListQuery'
import { matchWantedList } from '@/lib/wantedListMatching'
import { getUnreadAlertCount, resolveAlertPreference, getAlertEvents, ALERT_PAGE_SIZE } from '@/lib/buyerAlertsQuery'
import { WantedListAddForm } from '@/components/store/WantedListAddForm'
import { RemoveFromWantedButton } from '@/components/store/RemoveFromWantedButton'
import { WantedAlertToggle } from '@/components/store/WantedAlertToggle'
import { AlertPreferencesForm } from '@/components/store/AlertPreferencesForm'
import { MarkAlertReadButton, MarkAllAlertsReadButton } from '@/components/store/MarkAlertReadButtons'
import { AccountNav } from '@/components/store/AccountNav'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Wanted & Alerts | CollectNTrades',
  robots: { index: false, follow: false },
}

const ALERT_LABELS: Record<string, string> = {
  wanted_available:      'Now available',
  wanted_price_decrease: 'Price dropped',
  wanted_price_increase: 'Price increased',
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// 16D: shared tab strip — one concept ("Wanted & Alerts"), three internal views.
// `available=1` is preserved as a deep link (16C's /account "Check Available
// Matches →" already points here) even though it is now reachable via the
// "Available Now" tab too.
function TabBar({ activeView, unreadAlertCount }: { activeView: 'all' | 'available' | 'alerts'; unreadAlertCount: number }) {
  const tabCls = (active: boolean) =>
    `px-3 py-2 text-sm border-b-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
      active ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-900'
    }`
  return (
    <nav aria-label="Wanted & Alerts views" className="flex gap-1 border-b border-gray-200">
      <Link href="/account/wanted" aria-current={activeView === 'all' ? 'page' : undefined} className={tabCls(activeView === 'all')}>
        All Wanted
      </Link>
      <Link href="/account/wanted?available=1" aria-current={activeView === 'available' ? 'page' : undefined} className={tabCls(activeView === 'available')}>
        Available Now
      </Link>
      <Link href="/account/wanted?view=alerts" aria-current={activeView === 'alerts' ? 'page' : undefined} className={tabCls(activeView === 'alerts')}>
        Recent Alerts{unreadAlertCount > 0 ? ` (${unreadAlertCount})` : ''}
      </Link>
    </nav>
  )
}

export default async function WantedListPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; available?: string; view?: string }>
}) {
  const session = await getBuyerSession()
  if (!session) notFound()

  const { cursor, available, view } = await searchParams
  const showAlerts = view === 'alerts'
  const filterAvailable = available === '1'
  const filterUnavailable = available === '0'

  const [wantedCount, unreadAlertCount] = await Promise.all([
    prisma.wantedCatalogModel.count({ where: { customerProfileId: session.profileId } }),
    getUnreadAlertCount(session.profileId),
  ])

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Wanted & Alerts</h1>
      <p className="text-sm text-gray-500 mt-1">
        {wantedCount} wanted{unreadAlertCount > 0 ? ` · ${unreadAlertCount} new alert${unreadAlertCount !== 1 ? 's' : ''}` : ''}
      </p>
    </div>
  )

  // ── Recent Alerts view ──────────────────────────────────────────────────────
  if (showAlerts) {
    const [preference, { items, nextCursor }] = await Promise.all([
      resolveAlertPreference(session.profileId),
      getAlertEvents(session.profileId, cursor),
    ])

    return (
      <div className="max-w-2xl space-y-6">
        <AccountNav />
        {header}
        <TabBar activeView="alerts" unreadAlertCount={unreadAlertCount} />

        <AlertPreferencesForm preference={preference} />

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Recent Alerts</h2>
          <MarkAllAlertsReadButton />
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-gray-400">No alerts yet.</p>
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
                        <Link href={`/browse/${item.listingId}`} className="text-xs font-medium text-gray-900 hover:underline underline-offset-2">
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
              <Link href="/account/wanted?view=alerts" className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2">
                ← First page
              </Link>
            )}
            {nextCursor && (
              <Link
                href={`/account/wanted?view=alerts&cursor=${encodeURIComponent(nextCursor)}`}
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

  // ── Wanted list view (default / available=1 / available=0) ─────────────────
  // Use DB-level availability filters to avoid in-memory filtering across pages.
  const { items, nextCursor } = filterAvailable
    ? await getAvailableWantedList(session.profileId, cursor)
    : filterUnavailable
    ? await getUnavailableWantedList(session.profileId, cursor)
    : await getWantedList(session.profileId, cursor)

  const catalogIds = items.map(i => i.catalog.id)
  const availability = await matchWantedList(catalogIds)

  return (
    <div className="max-w-2xl space-y-6">
      <AccountNav />
      {header}
      <TabBar activeView={filterAvailable ? 'available' : 'all'} unreadAlertCount={unreadAlertCount} />

      {filterUnavailable ? (
        <p className="text-xs text-gray-400">
          Showing unavailable only. <Link href="/account/wanted" className="underline underline-offset-2 hover:text-gray-600">Show all →</Link>
        </p>
      ) : !filterAvailable ? (
        <p className="text-xs text-gray-400">
          <Link href="/account/wanted?available=0" className="underline underline-offset-2 hover:text-gray-600">Show unavailable only →</Link>
        </p>
      ) : null}

      <WantedListAddForm />

      {items.length === 0 ? (
        <p className="text-sm text-gray-400">
          {filterAvailable
            ? 'None of your wanted models are currently available.'
            : filterUnavailable
            ? 'All your wanted models are currently available.'
            : (
              <>
                Nothing on your wanted list yet. Browse the catalog to find something you want.
              </>
            )}
        </p>
      ) : (
        <div className="space-y-3">
          {items.map(entry => {
            const avail = availability.get(entry.catalog.id)
            const name = `${entry.catalog.brand} ${entry.catalog.name}${entry.catalog.year ? ` (${entry.catalog.year})` : ''}`

            return (
              <div key={entry.id} className="rounded-md border border-gray-200 bg-white px-4 py-4">
                <div className="flex items-start gap-4">
                  {entry.catalog.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={entry.catalog.photoUrl}
                      alt=""
                      className="w-14 h-14 rounded-md object-cover border border-gray-200 bg-gray-100 shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-md border border-dashed border-gray-200 bg-gray-50 shrink-0 flex items-center justify-center">
                      <span className="text-xs text-gray-300">No photo</span>
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/catalog/${entry.catalog.id}`}
                      className="font-medium text-gray-900 hover:underline underline-offset-2 truncate block"
                    >
                      {name}
                    </Link>
                    {entry.catalog.series && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{entry.catalog.series}</p>
                    )}
                    {entry.catalog.color && (
                      <p className="text-xs text-gray-400 truncate">{entry.catalog.color}</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      {avail?.hasActiveListing ? (
                        <span className="font-medium text-green-700">
                          Available — {avail.activeListingCount} listing{avail.activeListingCount !== 1 ? 's' : ''}
                          {avail.lowestActivePrice !== null &&
                            ` from $${avail.lowestActivePrice.toFixed(2)}`}
                        </span>
                      ) : (
                        <span className="text-gray-400">Not currently available</span>
                      )}
                      {entry.maxDesiredPrice && (
                        <span className="text-gray-500">
                          Max budget: ${parseFloat(entry.maxDesiredPrice).toFixed(2)}
                        </span>
                      )}
                    </div>

                    {entry.notes && (
                      <p className="mt-1 text-xs text-gray-400">{entry.notes}</p>
                    )}

                    <div className="mt-2 flex items-center gap-2">
                      <WantedAlertToggle
                        id={entry.id}
                        field="availabilityAlertEnabled"
                        enabled={entry.availabilityAlertEnabled}
                        label="Availability alert"
                        modelName={name}
                      />
                      <WantedAlertToggle
                        id={entry.id}
                        field="priceAlertEnabled"
                        enabled={entry.priceAlertEnabled}
                        label="Price alert"
                        modelName={name}
                      />
                    </div>

                    <div className="mt-3 flex items-center gap-4">
                      {avail?.firstListingId && (
                        <Link
                          href={`/browse/${avail.firstListingId}`}
                          className="text-xs font-medium text-gray-900 hover:underline underline-offset-2"
                        >
                          View listing →
                        </Link>
                      )}
                      <Link
                        href={`/account/wanted/${entry.id}/edit`}
                        className="text-xs text-gray-500 hover:text-gray-900 transition-colors"
                      >
                        Edit
                      </Link>
                      <RemoveFromWantedButton id={entry.id} modelName={name} />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {items.length === 0 && !filterAvailable && !filterUnavailable && (
        <Link
          href="/browse"
          className="inline-block text-sm font-medium text-gray-900 hover:underline underline-offset-2"
        >
          Browse Catalog →
        </Link>
      )}

      {(cursor || nextCursor) && (
        <div className="flex gap-4">
          {cursor && (
            <Link
              href={filterAvailable ? '/account/wanted?available=1' : filterUnavailable ? '/account/wanted?available=0' : '/account/wanted'}
              className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
            >
              ← First page
            </Link>
          )}
          {nextCursor && (
            <Link
              href={`/account/wanted?cursor=${encodeURIComponent(nextCursor)}${filterAvailable ? '&available=1' : filterUnavailable ? '&available=0' : ''}`}
              className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
            >
              Next {WANTED_PAGE_SIZE} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
