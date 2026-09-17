import type { Metadata } from 'next'
import Link from 'next/link'
import { getBuyerSession } from '@/lib/buyerSession'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'
import { AccountNav } from '@/components/store/AccountNav'
import { prisma } from '@/lib/prisma'
import { toggleCollectionItemPublic } from '@/lib/actions/collectionItems'
import { getPortfolio, type PortfolioHolding } from '@/lib/portfolioQuery'
import { centsToDisplay } from '@/lib/marketModelPageDisplay'

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

const CONFIDENCE_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

function formatPercent(ratio: number): string {
  const pct = ratio * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function formatCoverage(covered: number, total: number): string {
  return `Covers ${covered} of ${total} cop${total === 1 ? 'y' : 'ies'}`
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

  // 25B: one Portfolio snapshot over the ENTIRE collection (never the visible
  // cursor page) — a single asOf shared across every model valuation in the
  // batch. The paginated card list below stays responsible for the visible
  // rows only; this same result also supplies their per-row value/cost/gain
  // fields, so market valuation is computed exactly once, not duplicated.
  const asOf = new Date()

  const [qtyAgg, distinctModelGroups, freeformCount, matchingCount, rows, portfolio] = await Promise.all([
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
    getPortfolio(session.profileId, asOf),
  ])

  const holdingByItemId = new Map<string, PortfolioHolding>(portfolio.holdings.map((h) => [h.collectionItemId, h]))

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

      {itemCount > 0 && (
        <section className="mb-8 rounded-md border border-gray-200 bg-gray-50 px-4 py-3 space-y-4">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Portfolio</h2>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Estimated Portfolio Value</p>
              <p className="text-lg font-semibold text-gray-900">
                {portfolio.estimatedPortfolioValueCents !== null ? centsToDisplay(portfolio.estimatedPortfolioValueCents) : '—'}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatCoverage(portfolio.marketValueCoverage.valuedCopies, portfolio.marketValueCoverage.totalCopies)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Recorded Cost</p>
              <p className="text-lg font-semibold text-gray-900">
                {portfolio.recordedCostCents !== null ? centsToDisplay(portfolio.recordedCostCents) : '—'}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatCoverage(portfolio.costCoverage.knownCostCopies, portfolio.costCoverage.totalCopies)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Unrealized Gain/Loss</p>
              <p className="text-lg font-semibold text-gray-900">
                {portfolio.unrealizedGainLossCents !== null ? centsToDisplay(portfolio.unrealizedGainLossCents) : '—'}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatCoverage(portfolio.gainLossCoverage.comparableCopies, portfolio.gainLossCoverage.totalCopies)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Recorded Realized Gain/Loss</p>
              <p className="text-lg font-semibold text-gray-900">
                {portfolio.recordedRealizedGainLossCents !== null ? centsToDisplay(portfolio.recordedRealizedGainLossCents) : '—'}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Covers {portfolio.realizedCoverage.coveredDisposals} of {portfolio.realizedCoverage.totalDisposals} sale{portfolio.realizedCoverage.totalDisposals === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-3 space-y-1 text-xs text-gray-500">
            <p>Estimated values are not guaranteed sale proceeds — they reflect executed CollectNTrades and tracked external marketplace sales for this exact model only. Some items may show limited market data.</p>
            <p>Recorded Cost uses purchase prices you recorded where the cost can be interpreted safely. Multi-copy historical purchase-cost tracking is limited.</p>
            <p>Unrealized Gain/Loss is estimated market value minus recorded purchase cost for currently owned items where both values are available. Not an amount you can necessarily realize immediately.</p>
            <p>Recorded Realized Gain/Loss is based on recorded acquisition cost and known seller proceeds for items you&apos;ve sold or removed; not tax/accounting advice.</p>
          </div>
        </section>
      )}

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
              const holding = holdingByItemId.get(item.id) ?? null

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

                        {holding && (
                          <div className="mt-2 text-xs text-gray-700 space-y-0.5">
                            {holding.valuationStatus === 'valued' ? (
                              <p>
                                Est. value/copy: <span className="font-medium">{centsToDisplay(holding.estimatedUnitValueCents!)}</span>
                                {item.quantity > 1 && (
                                  <> · Holding value: <span className="font-medium">{centsToDisplay(holding.estimatedHoldingValueCents!)}</span></>
                                )}
                                {holding.confidence && <> · {CONFIDENCE_LABELS[holding.confidence]}</>}
                              </p>
                            ) : holding.valuationStatus === 'no_catalog_match' ? (
                              <p className="text-gray-400">No catalog match — market value unavailable</p>
                            ) : holding.valuationStatus === 'invalid_quantity' ? (
                              <p className="text-red-500">Invalid quantity — excluded from Portfolio totals</p>
                            ) : (
                              <p className="text-gray-400">Not enough market data yet</p>
                            )}

                            {holding.costStatus === 'known' ? (
                              <p>
                                Recorded Cost: <span className="font-medium">{centsToDisplay(holding.recordedCostCents!)}</span>
                                {holding.unrealizedGainLossCents !== null && (
                                  <>
                                    {' · '}Unrealized: <span className="font-medium">{centsToDisplay(holding.unrealizedGainLossCents)}</span>
                                    {holding.unrealizedGainLossPercent !== null && ` (${formatPercent(holding.unrealizedGainLossPercent)})`}
                                  </>
                                )}
                              </p>
                            ) : holding.costStatus === 'partial' ? (
                              <p className="text-gray-400">
                                Recorded Cost: <span className="font-medium text-gray-700">{centsToDisplay(holding.recordedCostCents!)}</span>
                                {' '}(known for {holding.knownCostCopies} of {item.quantity} — partial coverage)
                              </p>
                            ) : (
                              <Link
                                href={`/account/collection/${item.id}#add-another`}
                                className="text-gray-500 hover:text-gray-900 underline underline-offset-2"
                              >
                                Add purchase price
                              </Link>
                            )}
                          </div>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
                          {item.catalogId && (
                            <Link
                              href={`/account/collection/${item.id}#add-another`}
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
