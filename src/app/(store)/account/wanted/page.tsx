import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { getWantedList, getAvailableWantedList, getUnavailableWantedList, WANTED_PAGE_SIZE } from '@/lib/wantedListQuery'
import { matchWantedList } from '@/lib/wantedListMatching'
import { WantedListAddForm } from '@/components/store/WantedListAddForm'
import { RemoveFromWantedButton } from '@/components/store/RemoveFromWantedButton'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Wanted List | CollectNTrades',
  robots: { index: false, follow: false },
}

export default async function WantedListPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; available?: string }>
}) {
  const session = await getBuyerSession()
  if (!session) notFound()

  const { cursor, available } = await searchParams
  const filterAvailable = available === '1'
  const filterUnavailable = available === '0'

  // Use DB-level availability filters to avoid in-memory filtering across pages.
  const { items, nextCursor } = filterAvailable
    ? await getAvailableWantedList(session.profileId, cursor)
    : filterUnavailable
    ? await getUnavailableWantedList(session.profileId, cursor)
    : await getWantedList(session.profileId, cursor)

  const catalogIds = items.map(i => i.catalog.id)
  const availability = await matchWantedList(catalogIds)

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Wanted List</h1>
          <div className="flex gap-3 mt-1 text-sm text-gray-500">
            <Link
              href="/account/wanted"
              className={!filterAvailable && !filterUnavailable ? 'font-medium text-gray-900' : 'underline underline-offset-2 hover:text-gray-900'}
            >
              All
            </Link>
            <Link
              href="/account/wanted?available=1"
              className={filterAvailable ? 'font-medium text-gray-900' : 'underline underline-offset-2 hover:text-gray-900'}
            >
              Available
            </Link>
            <Link
              href="/account/wanted?available=0"
              className={filterUnavailable ? 'font-medium text-gray-900' : 'underline underline-offset-2 hover:text-gray-900'}
            >
              Not available
            </Link>
          </div>
        </div>
      </div>

      <WantedListAddForm />

      {items.length === 0 ? (
        <p className="text-sm text-gray-400">
          {filterAvailable
            ? 'None of your wanted models are currently available.'
            : filterUnavailable
            ? 'All your wanted models are currently available.'
            : 'Your wanted list is empty. Search for a model above to add it.'}
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
                    <p className="font-medium text-gray-900 truncate">{name}</p>
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
                      <RemoveFromWantedButton id={entry.id} />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
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
