import type { Metadata } from 'next'
import Link from 'next/link'
import { getLeaderboardData, getPublicDirectory, DIRECTORY_PAGE_SIZE } from '@/lib/communityLeaderboardsQuery'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Collector Community | CollectNTrades',
  description: 'Browse collector profiles and see who has the biggest collections.',
}

export default async function CommunityPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const { cursor } = await searchParams
  const [leaderboards, directory] = await Promise.all([
    getLeaderboardData(),
    getPublicDirectory(cursor),
  ])

  return (
    <div className="space-y-12">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Collector Community</h1>
        <p className="text-sm text-gray-500 mt-1">
          Public collector profiles from the CollectNTrades community.
        </p>
      </div>

      {/* Largest collections */}
      {leaderboards.largestCollections.length > 0 && (
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-1">Largest collections</h2>
          <p className="text-xs text-gray-400 mb-4">Based on public collection items only.</p>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 text-left w-10">#</th>
                  <th className="px-4 py-2 text-left">Collector</th>
                  <th className="px-4 py-2 text-right">Models</th>
                  <th className="px-4 py-2 text-right">Items</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leaderboards.largestCollections.map(entry => (
                  <tr key={entry.handle} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-400 text-xs">{entry.rank}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/community/${entry.handle}`}
                        className="font-medium text-gray-900 hover:text-gray-600"
                      >
                        {entry.displayName}
                      </Link>
                      <span className="ml-2 text-xs text-gray-400">@{entry.handle}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{entry.distinctModels}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{entry.totalItems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Active collectors */}
      {leaderboards.activeCollectors.length > 0 && (
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-1">Active collectors</h2>
          <p className="text-xs text-gray-400 mb-4">Most additions to their collection in the last 30 days.</p>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 text-left w-10">#</th>
                  <th className="px-4 py-2 text-left">Collector</th>
                  <th className="px-4 py-2 text-right">Additions</th>
                  <th className="px-4 py-2 text-right">Models</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leaderboards.activeCollectors.map(entry => (
                  <tr key={entry.handle} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-400 text-xs">{entry.rank}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/community/${entry.handle}`}
                        className="font-medium text-gray-900 hover:text-gray-600"
                      >
                        {entry.displayName}
                      </Link>
                      <span className="ml-2 text-xs text-gray-400">@{entry.handle}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{entry.additions}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{entry.distinctModels}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Verified marketplace collectors */}
      {leaderboards.verifiedCollectors.length > 0 && (
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-1">Verified marketplace collectors</h2>
          <p className="text-xs text-gray-400 mb-4">Collectors with confirmed purchases in the last 180 days.</p>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 text-left w-10">#</th>
                  <th className="px-4 py-2 text-left">Collector</th>
                  <th className="px-4 py-2 text-right">Items purchased</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leaderboards.verifiedCollectors.map(entry => (
                  <tr key={entry.handle} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-400 text-xs">{entry.rank}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/community/${entry.handle}`}
                        className="font-medium text-gray-900 hover:text-gray-600"
                      >
                        {entry.displayName}
                      </Link>
                      <span className="ml-2 text-xs text-gray-400">@{entry.handle}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{entry.completedItemCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {leaderboards.largestCollections.length === 0 && leaderboards.activeCollectors.length === 0 && leaderboards.verifiedCollectors.length === 0 && (
        <p className="text-sm text-gray-400">
          No leaderboard data yet.{' '}
          <Link href="/account/community" className="underline underline-offset-2 hover:text-gray-700">
            Set up your profile
          </Link>{' '}
          and opt in to appear here.
        </p>
      )}


      {/* Directory */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-4">All collectors</h2>
        {directory.items.length === 0 && !cursor ? (
          <p className="text-sm text-gray-400">
            No public profiles yet.{' '}
            <Link href="/account/community" className="underline underline-offset-2 hover:text-gray-700">
              Be the first
            </Link>
            .
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {directory.items.map(p => (
                <Link
                  key={p.handle}
                  href={`/community/${p.handle}`}
                  className="block rounded-lg border border-gray-200 px-4 py-3 hover:border-gray-400 transition-colors"
                >
                  <p className="font-medium text-gray-900 text-sm">{p.displayName}</p>
                  <p className="text-xs text-gray-400 mt-0.5">@{p.handle}</p>
                  {p.bio && (
                    <p className="text-xs text-gray-500 mt-1 line-clamp-2">{p.bio}</p>
                  )}
                </Link>
              ))}
            </div>

            <div className="mt-6 flex gap-4">
              {cursor && (
                <Link
                  href="/community"
                  className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
                >
                  ← First page
                </Link>
              )}
              {directory.nextCursor && (
                <Link
                  href={`/community?cursor=${encodeURIComponent(directory.nextCursor)}`}
                  className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
                >
                  Next {DIRECTORY_PAGE_SIZE} →
                </Link>
              )}
            </div>
          </>
        )}
      </section>

      <p className="text-xs text-gray-400">
        Want to appear here?{' '}
        <Link href="/account/community" className="underline underline-offset-2 hover:text-gray-700">
          Set up your community profile
        </Link>
        .
      </p>
    </div>
  )
}
