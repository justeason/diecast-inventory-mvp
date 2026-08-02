import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPublicProfile } from '@/lib/communityLeaderboardsQuery'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import type { Badge } from '@/lib/communityLeaderboards'

export const dynamic = 'force-dynamic'

const BADGE_LABELS: Record<Badge, string> = {
  public_collector: 'Collector',
  collection_10: '10+ models',
  collection_50: '50+ models',
  collection_100: '100+ models',
  active_collector: 'Active collector',
  verified_buyer: 'Verified buyer',
}

type Props = { params: Promise<{ handle: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params
  const profile = await getPublicProfile(handle)
  if (!profile) return { title: 'Collector Not Found | CollectNTrades' }
  return {
    title: `${profile.displayName} (@${profile.handle}) | CollectNTrades`,
    description: profile.bio ?? `Collector profile for @${profile.handle} on CollectNTrades.`,
  }
}

export default async function PublicProfilePage({ params }: Props) {
  const { handle } = await params
  const profile = await getPublicProfile(handle)
  if (!profile) notFound()

  return (
    <div className="max-w-3xl space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{profile.displayName}</h1>
        <p className="text-sm text-gray-400 mt-0.5">@{profile.handle}</p>
        {profile.bio && (
          <p className="text-sm text-gray-600 mt-3 max-w-lg">{profile.bio}</p>
        )}

        {/* Badges */}
        <div className="flex flex-wrap gap-2 mt-4">
          {profile.badges
            .filter(b => b !== 'public_collector')
            .map(b => (
              <span
                key={b}
                className="inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700"
              >
                {BADGE_LABELS[b]}
              </span>
            ))}
        </div>
      </div>

      {/* Collection stats */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-3">Collection</h2>
        <div className="flex gap-8 text-sm">
          <div>
            <p className="text-2xl font-bold text-gray-900">{profile.collection.distinctModels}</p>
            <p className="text-xs text-gray-500 mt-0.5">distinct models</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{profile.collection.totalItems}</p>
            <p className="text-xs text-gray-500 mt-0.5">total items</p>
          </div>
        </div>
      </section>

      {/* Recent additions */}
      {profile.collection.recentItems.length > 0 && (
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-4">Recent additions</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {profile.collection.recentItems.map(item => {
              const name = `${item.catalogBrand} ${item.catalogName}${item.catalogYear ? ` (${item.catalogYear})` : ''}`
              return (
                <div key={item.id} className="rounded-lg border border-gray-200 overflow-hidden bg-white">
                  <div className="aspect-square overflow-hidden">
                    <PhotoThumbnail photoUrl={item.photoUrl} alt={name} size="fill" />
                  </div>
                  <div className="p-3">
                    <p className="text-xs font-medium text-gray-900 line-clamp-2 leading-snug">{name}</p>
                    {item.catalogSeries && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{item.catalogSeries}</p>
                    )}
                    {item.catalogColor && (
                      <p className="text-xs text-gray-400 truncate">{item.catalogColor}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {profile.showOnLeaderboards && (
        <p className="text-xs text-gray-400">
          This collector appears on the{' '}
          <Link href="/community" className="underline underline-offset-2 hover:text-gray-700">
            community leaderboards
          </Link>
          .
        </p>
      )}

      <div className="text-xs text-gray-400">
        <Link href="/community" className="underline underline-offset-2 hover:text-gray-700">
          ← All collectors
        </Link>
      </div>
    </div>
  )
}
