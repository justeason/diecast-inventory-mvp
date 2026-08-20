import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { AccountNav } from '@/components/store/AccountNav'
import { prisma } from '@/lib/prisma'
import { toggleCollectionItemPublic } from '@/lib/actions/collectionItems'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My Collection | CollectNTrades',
  robots: { index: false, follow: false },
}

const PAGE_SIZE = 24

const CONDITION_LABELS: Record<string, string> = {
  mint:      'Mint',
  near_mint: 'Near Mint',
  good:      'Good',
  fair:      'Fair',
  poor:      'Poor',
  damaged:   'Damaged',
}

const CONDITION_COLORS: Record<string, string> = {
  mint:      'bg-green-100 text-green-700',
  near_mint: 'bg-blue-100 text-blue-700',
  good:      'bg-gray-100 text-gray-700',
  fair:      'bg-yellow-100 text-yellow-700',
  poor:      'bg-orange-100 text-orange-700',
  damaged:   'bg-red-100 text-red-700',
}

const CARDED_LOOSE_COLORS: Record<string, string> = {
  carded: 'bg-purple-100 text-purple-700',
  loose:  'bg-gray-100 text-gray-600',
}

function displayName(item: {
  brand: string | null
  name: string | null
  catalog: { brand: string; name: string } | null
}): string {
  if (item.catalog) return `${item.catalog.brand} ${item.catalog.name}`
  const parts = [item.brand, item.name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Unnamed item'
}

export default async function CollectionListPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const session = await getBuyerSession()

  if (!session) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">My Collection</h1>
        <p className="text-sm text-gray-500 mb-8">
          Sign in to view your personal diecast collection.
        </p>
        <BuyerOrderAccessForm />
      </div>
    )
  }

  const { cursor } = await searchParams

  const rows = await prisma.collectionItem.findMany({
    where: {
      profileId: session.profileId,
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: PAGE_SIZE + 1,
    select: {
      id:            true,
      brand:         true,
      name:          true,
      year:          true,
      condition:     true,
      cardedOrLoose: true,
      quantity:      true,
      isPublic:      true,
      createdAt:     true,
      catalog: {
        select: {
          brand: true,
          name:  true,
          photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true, altText: true } },
        },
      },
      photos: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
    },
  })

  const hasMore = rows.length > PAGE_SIZE
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows
  const nextCursor = hasMore ? items[items.length - 1].id : null

  return (
    <div className="max-w-2xl">
      <AccountNav />
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Collection</h1>
          <p className="text-sm text-gray-500 mt-1">
            {cursor ? `Page 2+` : `${items.length}${hasMore ? '+' : ''} item${items.length !== 1 ? 's' : ''}`}
            {' · '}
            <Link href="/account/collection/valuation" className="underline underline-offset-2 hover:text-gray-700">
              Estimate value
            </Link>
          </p>
        </div>
        <Link
          href="/account/collection/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
        >
          Add item
        </Link>
      </div>

      {items.length === 0 && !cursor ? (
        <div className="rounded-md border border-dashed border-gray-300 px-6 py-10 text-center">
          <p className="text-sm text-gray-500 mb-4">
            Your collection is empty. Add your first diecast.
          </p>
          <Link
            href="/account/collection/new"
            className="text-sm font-medium text-gray-900 hover:underline underline-offset-2"
          >
            Add an item →
          </Link>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {items.map((item) => {
              const ownPhoto = item.photos[0]
              const catalogPhoto = item.catalog?.photos?.[0]
              const photoUrl = ownPhoto?.url ?? catalogPhoto?.url ?? null
              const isRefImage = !ownPhoto && !!catalogPhoto

              return (
                <div key={item.id} className="rounded-md border border-gray-200 bg-white px-4 py-4">
                  <div className="flex items-center gap-4">
                    {photoUrl ? (
                      <div className="shrink-0 flex flex-col items-center gap-0.5 w-14">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={photoUrl}
                          alt=""
                          className="w-14 h-14 rounded-md object-cover border border-gray-200 bg-gray-100"
                        />
                        {isRefImage && (
                          <span className="text-[9px] leading-none text-gray-400">Reference</span>
                        )}
                      </div>
                    ) : (
                      <div className="w-14 h-14 rounded-md border border-dashed border-gray-200 bg-gray-50 shrink-0 flex items-center justify-center">
                        <span className="text-xs text-gray-300">No photo</span>
                      </div>
                    )}

                    <div className="flex-1 min-w-0 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Link
                          href={`/account/collection/${item.id}`}
                          className="font-medium text-gray-900 hover:underline underline-offset-2 truncate block"
                        >
                          {displayName(item)}
                          {item.year && (
                            <span className="ml-2 text-sm font-normal text-gray-500">
                              {item.year}
                            </span>
                          )}
                        </Link>
                        <div className="flex flex-wrap items-center gap-2 mt-1.5">
                          {item.condition && (
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CONDITION_COLORS[item.condition] ?? 'bg-gray-100 text-gray-600'}`}
                            >
                              {CONDITION_LABELS[item.condition] ?? item.condition}
                            </span>
                          )}
                          {item.cardedOrLoose && (
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CARDED_LOOSE_COLORS[item.cardedOrLoose] ?? 'bg-gray-100 text-gray-600'}`}
                            >
                              {item.cardedOrLoose.charAt(0).toUpperCase() + item.cardedOrLoose.slice(1)}
                            </span>
                          )}
                          {item.quantity > 1 && (
                            <span className="text-xs text-gray-400">×{item.quantity}</span>
                          )}
                          <form action={toggleCollectionItemPublic.bind(null, item.id, !item.isPublic)}>
                            <button
                              type="submit"
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                                item.isPublic
                                  ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                              }`}
                            >
                              {item.isPublic ? 'Public' : 'Private'}
                            </button>
                          </form>
                        </div>
                      </div>
                      <p className="text-xs text-gray-400 shrink-0 mt-0.5">
                        {item.createdAt.toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="mt-6 flex gap-4">
            {cursor && (
              <Link
                href="/account/collection"
                className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
              >
                ← First page
              </Link>
            )}
            {nextCursor && (
              <Link
                href={`/account/collection?cursor=${encodeURIComponent(nextCursor)}`}
                className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
              >
                Next {PAGE_SIZE} →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  )
}
