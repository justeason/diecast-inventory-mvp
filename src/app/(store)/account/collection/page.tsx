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

const VALID_CONDITIONS = new Set(Object.keys(CONDITION_LABELS))
const VALID_TYPES = new Set(['carded', 'loose'])

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
  searchParams: Promise<{ cursor?: string; q?: string; condition?: string; type?: string; sort?: string }>
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

  const { cursor, q: rawQ, condition: rawCondition, type: rawType, sort: rawSort } = await searchParams
  const q = rawQ?.trim() ?? ''
  const condition = rawCondition && VALID_CONDITIONS.has(rawCondition) ? rawCondition : ''
  const type = rawType && VALID_TYPES.has(rawType) ? rawType : ''
  const sortNewest = rawSort === 'newest'
  const isFiltered = !!(q || condition || type)

  // Explicit query-string builder (matches account/wanted/page.tsx's established
  // ternary style) so Prev/Next pagination links preserve the active search/filter/
  // sort instead of silently dropping them (16E Part 47 — search/filter combined with
  // pagination must not lose state or produce incorrect results).
  function pageHref(cursorValue: string | null): string {
    const parts: string[] = []
    if (q) parts.push(`q=${encodeURIComponent(q)}`)
    if (condition) parts.push(`condition=${condition}`)
    if (type) parts.push(`type=${type}`)
    if (sortNewest) parts.push('sort=newest')
    if (cursorValue) parts.push(`cursor=${encodeURIComponent(cursorValue)}`)
    return parts.length > 0 ? `/account/collection?${parts.join('&')}` : '/account/collection'
  }

  // Base (unfiltered) where — used only for the exact header totals, so "42 items ·
  // 35 entries" always describes the WHOLE collection, matching accountOverviewQuery.ts's
  // CollectionSummary, never the current search/filter result count.
  const baseWhere = { profileId: session.profileId }

  const filterWhere = {
    profileId: session.profileId,
    ...(condition ? { condition } : {}),
    ...(type ? { cardedOrLoose: type } : {}),
    ...(q
      ? {
          OR: [
            { brand: { contains: q, mode: 'insensitive' as const } },
            { name: { contains: q, mode: 'insensitive' as const } },
            { catalog: { brand: { contains: q, mode: 'insensitive' as const } } },
            { catalog: { name: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  }

  const [qtyAgg, distinctModelGroups, freeformCount, matchingCount, rows] = await Promise.all([
    // 16E Final: CollectionItem.quantity is the number of owned physical copies a
    // row represents (schema default 1, NOT NULL) — SUM(quantity), not row count,
    // is the true "items" total. A single row with quantity=5 is 5 owned items.
    prisma.collectionItem.aggregate({ where: baseWhere, _sum: { quantity: true } }),
    prisma.collectionItem.groupBy({ by: ['catalogId'], where: { ...baseWhere, catalogId: { not: null } } }),
    // Freeform (no catalog match) rows have no catalogId to group by, and the
    // domain does NOT deduplicate them (only (profileId, catalogId) is unique) —
    // each is its own distinct entry, never collapsed into one null group.
    prisma.collectionItem.count({ where: { ...baseWhere, catalogId: null } }),
    isFiltered ? prisma.collectionItem.count({ where: filterWhere }) : Promise.resolve(null),
    prisma.collectionItem.findMany({
      where: {
        ...filterWhere,
        ...(cursor ? (sortNewest ? { id: { lt: cursor } } : { id: { gt: cursor } }) : {}),
      },
      orderBy: { id: sortNewest ? 'desc' : 'asc' },
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
        catalogId:     true,
        catalog: {
          select: {
            brand: true,
            name:  true,
            photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true, altText: true } },
          },
        },
        photos: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
      },
    }),
  ])

  const itemCount = qtyAgg._sum.quantity ?? 0
  const entryCount = distinctModelGroups.length + freeformCount
  const hasMore = rows.length > PAGE_SIZE
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows
  const nextCursor = hasMore ? items[items.length - 1].id : null

  return (
    <div className="max-w-2xl">
      <AccountNav />
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Collection</h1>
          <p className="text-sm text-gray-500 mt-1">
            {itemCount} item{itemCount !== 1 ? 's' : ''} · {entryCount} entr{entryCount !== 1 ? 'ies' : 'y'}
            {' · '}
            <Link href="/account/collection/valuation" className="underline underline-offset-2 hover:text-gray-700">
              Estimate value →
            </Link>
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Link
            href="/account/collection/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
          >
            Add Item
          </Link>
          <Link
            href="/account/capture"
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Quick Capture
          </Link>
        </div>
      </div>

      {(itemCount > 0 || isFiltered) && (
        <form method="GET" action="/account/collection" className="flex flex-wrap items-end gap-3 mb-6">
          <div className="flex-1 min-w-[160px]">
            <label htmlFor="collection-q" className="block text-xs font-medium text-gray-600 mb-1">Search</label>
            <input
              id="collection-q"
              name="q"
              type="text"
              defaultValue={q}
              placeholder="Model, brand..."
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="collection-condition" className="block text-xs font-medium text-gray-600 mb-1">Condition</label>
            <select id="collection-condition" name="condition" defaultValue={condition} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">Any</option>
              {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="collection-type" className="block text-xs font-medium text-gray-600 mb-1">Type</label>
            <select id="collection-type" name="type" defaultValue={type} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">Any</option>
              <option value="carded">Carded</option>
              <option value="loose">Loose</option>
            </select>
          </div>
          <div>
            <label htmlFor="collection-sort" className="block text-xs font-medium text-gray-600 mb-1">Sort</label>
            <select id="collection-sort" name="sort" defaultValue={sortNewest ? 'newest' : 'oldest'} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
            </select>
          </div>
          <button
            type="submit"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Apply
          </button>
          {isFiltered && (
            <Link href="/account/collection" className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2">
              Clear
            </Link>
          )}
        </form>
      )}

      {isFiltered && matchingCount !== null && (
        <p className="text-xs text-gray-500 mb-4">
          {/* matchingCount is a row/entry count (collectionItem.count), not a
              physical-copy total — labeled "entries" so it is never confused with
              the SUM(quantity)-based "items" header stat above. */}
          {matchingCount} matching entr{matchingCount !== 1 ? 'ies' : 'y'}
        </p>
      )}

      {items.length === 0 && !cursor && !isFiltered ? (
        <div className="rounded-md border border-dashed border-gray-300 px-6 py-10 text-center">
          <p className="text-sm text-gray-700 mb-1">Your collection is empty.</p>
          <p className="text-sm text-gray-500 mb-4">Add your first item manually or use Quick Capture.</p>
          <div className="flex items-center justify-center gap-3">
            <Link
              href="/account/collection/new"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
            >
              Add Item
            </Link>
            <Link
              href="/account/capture"
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Quick Capture
            </Link>
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-400">
          No items match your search.{' '}
          <Link href="/account/collection" className="underline underline-offset-2 hover:text-gray-700">Clear filters</Link>
        </p>
      ) : (
        <>
          <div className="space-y-3">
            {items.map((item) => {
              const ownPhoto = item.photos[0]
              const catalogPhoto = item.catalog?.photos?.[0]
              const photoUrl = ownPhoto?.url ?? catalogPhoto?.url ?? null
              const isRefImage = !ownPhoto && !!catalogPhoto
              const name = displayName(item)

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
                          {name}
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
                          {/* Quantity lives on this one row — the create path already
                              rejects a second row for the same catalog model (see
                              collectionItems.ts), so there is nothing to sum/group across
                              rows here; this is always the exact owned quantity. */}
                          {item.quantity > 1 && (
                            <span className="text-xs text-gray-500">You own {item.quantity}</span>
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

                        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
                          {item.catalogId && (
                            <Link
                              href={`/account/collection/${item.id}/edit#quantity`}
                              aria-label={`Add another ${name}`}
                              className="font-medium text-gray-900 hover:underline underline-offset-2"
                            >
                              Add Another
                            </Link>
                          )}
                          <Link
                            href={`/account/collection/${item.id}/sell`}
                            aria-label={`Sell one ${name}`}
                            className="font-medium text-gray-900 hover:underline underline-offset-2"
                          >
                            Sell One
                          </Link>
                          {item.catalogId && (
                            <Link
                              href={`/catalog/${item.catalogId}`}
                              aria-label={`View market for ${name}`}
                              className="text-gray-500 hover:text-gray-900 transition-colors"
                            >
                              View Market
                            </Link>
                          )}
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
                href={pageHref(null)}
                className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
              >
                ← First page
              </Link>
            )}
            {nextCursor && (
              <Link
                href={pageHref(nextCursor)}
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
