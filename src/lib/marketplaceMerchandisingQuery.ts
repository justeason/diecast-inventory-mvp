import { unstable_cache } from 'next/cache'
import { prisma } from '@/lib/prisma'
import type {
  RawActiveListing,
  RawSoldItem,
  RawSaleRecord,
  CatalogPhotoMap,
  MerchandisingData,
} from './marketplaceMerchandising'
import {
  buildRecentlyListed,
  buildHighValue,
  buildRecentlySold,
  computeTrendingModels,
  computeFastMovers,
  computeTopPriceMovers,
  PRIOR_PRICE_WINDOW_DAYS,
} from './marketplaceMerchandising'

const SCAN_BATCH = 100
const MS_PER_DAY = 24 * 60 * 60 * 1000

const ACTIVE_LISTING_SELECT = {
  id: true,
  title: true,
  price: true,
  createdAt: true,
  item: {
    select: {
      sku: true,
      cardedOrLoose: true,
      condition: true,
      catalog: {
        select: {
          brand: true,
          name: true,
          year: true,
          series: true,
          color: true,
          photos: { take: 1, orderBy: { sortOrder: 'asc' as const }, select: { url: true } },
        },
      },
      photos: { where: { type: 'front' }, take: 1, select: { url: true } },
    },
  },
} as const

function mapListingRow(r: {
  id: string
  title: string
  price: number
  createdAt: Date
  item: {
    sku: string
    cardedOrLoose: string
    condition: string
    catalog: {
      brand: string
      name: string
      year: number | null
      series: string | null
      color: string | null
      photos: { url: string }[]
    }
    photos: { url: string }[]
  }
}): RawActiveListing {
  return {
    id: r.id,
    title: r.title,
    price: r.price,
    createdAt: r.createdAt,
    item: {
      sku: r.item.sku,
      cardedOrLoose: r.item.cardedOrLoose,
      condition: r.item.condition,
      catalog: {
        brand: r.item.catalog.brand,
        name: r.item.catalog.name,
        year: r.item.catalog.year,
        series: r.item.catalog.series,
        color: r.item.catalog.color,
      },
      itemPhotoUrl: r.item.photos[0]?.url ?? null,
      catalogPhotoUrl: r.item.catalog.photos[0]?.url ?? null,
    },
  }
}

async function fetchRecentlyListed(): Promise<RawActiveListing[]> {
  const rows = await prisma.listing.findMany({
    where: { status: 'active', item: { status: 'available' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 12,
    select: ACTIVE_LISTING_SELECT,
  })
  return rows.map(mapListingRow)
}

async function fetchHighValue(): Promise<RawActiveListing[]> {
  const rows = await prisma.listing.findMany({
    where: { status: 'active', item: { status: 'available' } },
    orderBy: [{ price: 'desc' }, { id: 'asc' }],
    take: 12,
    select: ACTIVE_LISTING_SELECT,
  })
  return rows.map(mapListingRow)
}

async function fetchRecentlySold(): Promise<RawSoldItem[]> {
  const rows = await prisma.orderItem.findMany({
    where: {
      order: { status: 'complete', completedAt: { not: null } },
      price: { gt: 0 },
    },
    orderBy: [{ order: { completedAt: 'desc' } }, { id: 'asc' }],
    take: 12,
    select: {
      id: true,
      order: { select: { completedAt: true } },
      item: {
        select: {
          catalogId: true,
          catalog: {
            select: {
              brand: true,
              name: true,
              year: true,
              series: true,
              photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
            },
          },
          photos: { where: { type: 'front' }, take: 1, select: { url: true } },
        },
      },
    },
  })
  return rows
    .filter((r): r is typeof r & { order: { completedAt: Date } } => r.order.completedAt != null)
    .map((r) => ({
      id: r.id,
      catalogModelId: r.item.catalogId,
      catalogBrand: r.item.catalog.brand,
      catalogName: r.item.catalog.name,
      catalogYear: r.item.catalog.year,
      catalogSeries: r.item.catalog.series,
      soldAt: r.order.completedAt,
      photoUrl: r.item.photos[0]?.url ?? r.item.catalog.photos[0]?.url ?? null,
    }))
}

// Keyset-paginated scan of all completed OrderItems in the sales window.
// No silent take cap — scans until batch is smaller than SCAN_BATCH.
async function scanSalesWindow(windowStart: Date): Promise<RawSaleRecord[]> {
  const results: RawSaleRecord[] = []
  let cursorId: string | undefined

  for (;;) {
    const batch = await prisma.orderItem.findMany({
      where: {
        order: { status: 'complete', completedAt: { gte: windowStart } },
        price: { gt: 0 },
      },
      select: {
        id: true,
        price: true,
        listing: { select: { createdAt: true } },
        order: { select: { completedAt: true } },
        item: {
          select: {
            catalogId: true,
            catalog: { select: { brand: true, name: true, year: true, series: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })

    for (const oi of batch) {
      if (!oi.order.completedAt) continue
      results.push({
        orderItemId: oi.id,
        catalogModelId: oi.item.catalogId,
        catalogBrand: oi.item.catalog.brand,
        catalogName: oi.item.catalog.name,
        catalogYear: oi.item.catalog.year,
        catalogSeries: oi.item.catalog.series,
        soldPriceDollars: oi.price,
        completedAt: oi.order.completedAt,
        listingCreatedAt: oi.listing.createdAt,
      })
    }

    if (batch.length < SCAN_BATCH) break
    cursorId = batch[batch.length - 1].id
  }

  return results
}

async function fetchCatalogPhotos(catalogIds: string[]): Promise<CatalogPhotoMap> {
  if (catalogIds.length === 0) return {}
  const rows = await prisma.catalogModel.findMany({
    where: { id: { in: catalogIds } },
    select: {
      id: true,
      photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
    },
  })
  return Object.fromEntries(rows.map((r) => [r.id, r.photos[0]?.url ?? null]))
}

async function fetchActiveListingCounts(catalogIds: string[]): Promise<Record<string, number>> {
  if (catalogIds.length === 0) return {}
  const rows = await prisma.listing.findMany({
    where: {
      status: 'active',
      item: { status: 'available', catalogId: { in: catalogIds } },
    },
    select: { item: { select: { catalogId: true } } },
  })
  const counts: Record<string, number> = {}
  for (const r of rows) {
    counts[r.item.catalogId] = (counts[r.item.catalogId] ?? 0) + 1
  }
  return counts
}

// Cached for 300 s. Public-only data — no admin/seller/buyer fields included.
// Both /market and / call this function; they share the same cache entry.
export const getMerchandisingData = unstable_cache(
  async (): Promise<MerchandisingData> => {
    return buildMerchandisingData()
  },
  ['public', 'marketplace', 'merchandising'],
  { revalidate: 300 },
)

async function buildMerchandisingData(): Promise<MerchandisingData> {
  const nowMs = Date.now()
  const windowStart = new Date(nowMs - PRIOR_PRICE_WINDOW_DAYS * MS_PER_DAY)

  const [rawRecentlyListed, rawHighValue, rawRecentlySold, salesWindow] = await Promise.all([
    fetchRecentlyListed(),
    fetchHighValue(),
    fetchRecentlySold(),
    scanSalesWindow(windowStart),
  ])

  const saleCatalogIds = [...new Set(salesWindow.map((s) => s.catalogModelId))]

  // Preliminary trending pass (no photos/counts) to get the catalog IDs we need counts for
  const trendingPrelim = computeTrendingModels(salesWindow, {}, {}, undefined, undefined, undefined, nowMs)
  const trendingCatalogIds = trendingPrelim.map((t) => t.catalogModelId)

  const [catalogPhotos, activeListingCounts] = await Promise.all([
    fetchCatalogPhotos(saleCatalogIds),
    fetchActiveListingCounts(trendingCatalogIds),
  ])

  return {
    recentlyListed: buildRecentlyListed(rawRecentlyListed),
    recentlySold: buildRecentlySold(rawRecentlySold),
    highValue: buildHighValue(rawHighValue),
    trendingModels: computeTrendingModels(
      salesWindow,
      catalogPhotos,
      activeListingCounts,
      undefined,
      undefined,
      undefined,
      nowMs,
    ),
    fastMovers: computeFastMovers(salesWindow, catalogPhotos, undefined, undefined, undefined, nowMs),
    topPriceMovers: computeTopPriceMovers(
      salesWindow,
      catalogPhotos,
      undefined,
      undefined,
      undefined,
      undefined,
      nowMs,
    ),
  }
}
