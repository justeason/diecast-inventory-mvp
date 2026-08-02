import { median } from '@/lib/resaleEstimator'

// ─── Raw input types (from query layer) ──────────────────────────────────────

export type RawActiveListing = {
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
    }
    itemPhotoUrl: string | null
    catalogPhotoUrl: string | null
  }
}

export type RawSoldItem = {
  id: string
  catalogModelId: string
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  soldAt: Date
  photoUrl: string | null
}

export type RawSaleRecord = {
  orderItemId: string
  catalogModelId: string
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  soldPriceDollars: number
  completedAt: Date
  listingCreatedAt: Date | null
}

export type CatalogPhotoMap = Record<string, string | null>

// ─── Public output types ──────────────────────────────────────────────────────

export type PublicListingItem = {
  id: string
  title: string
  price: number
  createdAt: Date
  photoUrl: string | null
  imageSource: 'item' | 'catalog' | 'none'
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
    }
  }
}

export type PublicSoldItem = {
  id: string
  catalogModelId: string
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  soldAt: Date
  photoUrl: string | null
}

export type TrendingModel = {
  catalogModelId: string
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  photoUrl: string | null
  saleCount: number
  latestSaleAt: Date
  activeListingCount: number
}

export type FastMoverModel = {
  catalogModelId: string
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  photoUrl: string | null
  medianDaysToSell: number
  saleCount: number
}

export type PriceMoverModel = {
  catalogModelId: string
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  photoUrl: string | null
  recentMedianCents: number
  priorMedianCents: number
  pctChange: number
}

export type MerchandisingData = {
  recentlyListed: PublicListingItem[]
  recentlySold: PublicSoldItem[]
  highValue: PublicListingItem[]
  trendingModels: TrendingModel[]
  fastMovers: FastMoverModel[]
  topPriceMovers: PriceMoverModel[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const TRENDING_WINDOW_DAYS = 30
export const FAST_MOVER_WINDOW_DAYS = 180
export const RECENT_PRICE_WINDOW_DAYS = 90
export const PRIOR_PRICE_WINDOW_DAYS = 180
export const TRENDING_MIN_SALES = 2
export const FAST_MOVER_MIN_SAMPLES = 2
export const PRICE_MOVER_MIN_SAMPLES = 3
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_RESULTS = 12

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapActiveListing(raw: RawActiveListing): PublicListingItem {
  const photoUrl = raw.item.itemPhotoUrl ?? raw.item.catalogPhotoUrl ?? null
  const imageSource: 'item' | 'catalog' | 'none' = raw.item.itemPhotoUrl
    ? 'item'
    : raw.item.catalogPhotoUrl
      ? 'catalog'
      : 'none'
  return {
    id: raw.id,
    title: raw.title,
    price: raw.price,
    createdAt: raw.createdAt,
    photoUrl,
    imageSource,
    item: {
      sku: raw.item.sku,
      cardedOrLoose: raw.item.cardedOrLoose,
      condition: raw.item.condition,
      catalog: raw.item.catalog,
    },
  }
}

// ─── Section builders (DB already orders/limits; these are type mappers) ─────

export function buildRecentlyListed(raw: RawActiveListing[]): PublicListingItem[] {
  return raw.map(mapActiveListing)
}

export function buildHighValue(raw: RawActiveListing[]): PublicListingItem[] {
  return raw.map(mapActiveListing)
}

export function buildRecentlySold(raw: RawSoldItem[]): PublicSoldItem[] {
  return raw.map((r) => ({
    id: r.id,
    catalogModelId: r.catalogModelId,
    catalogBrand: r.catalogBrand,
    catalogName: r.catalogName,
    catalogYear: r.catalogYear,
    catalogSeries: r.catalogSeries,
    soldAt: r.soldAt,
    photoUrl: r.photoUrl,
  }))
}

// ─── Trending models ──────────────────────────────────────────────────────────
// Rank: saleCount DESC, latestSaleAt DESC, catalogModelId ASC (deterministic)

export function computeTrendingModels(
  sales: RawSaleRecord[],
  catalogPhotos: CatalogPhotoMap,
  activeListingCounts: Record<string, number>,
  windowDays = TRENDING_WINDOW_DAYS,
  minSales = TRENDING_MIN_SALES,
  maxResults = MAX_RESULTS,
  nowMs = Date.now(),
): TrendingModel[] {
  const windowStart = nowMs - windowDays * MS_PER_DAY
  const filtered = sales.filter((s) => s.completedAt.getTime() >= windowStart)

  type Group = { firstSale: RawSaleRecord; count: number; latestSaleAt: Date }
  const groups = new Map<string, Group>()

  for (const s of filtered) {
    const g = groups.get(s.catalogModelId)
    if (!g) {
      groups.set(s.catalogModelId, { firstSale: s, count: 1, latestSaleAt: s.completedAt })
    } else {
      g.count++
      if (s.completedAt > g.latestSaleAt) g.latestSaleAt = s.completedAt
    }
  }

  const results: TrendingModel[] = []
  for (const [catalogModelId, g] of groups) {
    if (g.count < minSales) continue
    const { firstSale: f } = g
    results.push({
      catalogModelId,
      catalogBrand: f.catalogBrand,
      catalogName: f.catalogName,
      catalogYear: f.catalogYear,
      catalogSeries: f.catalogSeries,
      photoUrl: catalogPhotos[catalogModelId] ?? null,
      saleCount: g.count,
      latestSaleAt: g.latestSaleAt,
      activeListingCount: activeListingCounts[catalogModelId] ?? 0,
    })
  }

  return results
    .sort((a, b) => {
      if (b.saleCount !== a.saleCount) return b.saleCount - a.saleCount
      const timeDiff = b.latestSaleAt.getTime() - a.latestSaleAt.getTime()
      if (timeDiff !== 0) return timeDiff
      return a.catalogModelId.localeCompare(b.catalogModelId)
    })
    .slice(0, maxResults)
}

// ─── Fast movers ──────────────────────────────────────────────────────────────
// Rank: medianDaysToSell ASC, saleCount DESC, catalogModelId ASC

export function computeFastMovers(
  sales: RawSaleRecord[],
  catalogPhotos: CatalogPhotoMap,
  windowDays = FAST_MOVER_WINDOW_DAYS,
  minSamples = FAST_MOVER_MIN_SAMPLES,
  maxResults = MAX_RESULTS,
  nowMs = Date.now(),
): FastMoverModel[] {
  const windowStart = nowMs - windowDays * MS_PER_DAY

  type Group = { firstSale: RawSaleRecord; days: number[] }
  const groups = new Map<string, Group>()

  for (const s of sales) {
    if (s.completedAt.getTime() < windowStart) continue
    if (!s.listingCreatedAt) continue
    const ms = s.completedAt.getTime() - s.listingCreatedAt.getTime()
    if (ms < 0) continue
    const days = Math.round(ms / MS_PER_DAY)
    const g = groups.get(s.catalogModelId)
    if (!g) {
      groups.set(s.catalogModelId, { firstSale: s, days: [days] })
    } else {
      g.days.push(days)
    }
  }

  const results: FastMoverModel[] = []
  for (const [catalogModelId, g] of groups) {
    if (g.days.length < minSamples) continue
    const sorted = g.days.slice().sort((a, b) => a - b)
    const { firstSale: f } = g
    results.push({
      catalogModelId,
      catalogBrand: f.catalogBrand,
      catalogName: f.catalogName,
      catalogYear: f.catalogYear,
      catalogSeries: f.catalogSeries,
      photoUrl: catalogPhotos[catalogModelId] ?? null,
      medianDaysToSell: median(sorted),
      saleCount: g.days.length,
    })
  }

  return results
    .sort((a, b) => {
      if (a.medianDaysToSell !== b.medianDaysToSell) return a.medianDaysToSell - b.medianDaysToSell
      if (b.saleCount !== a.saleCount) return b.saleCount - a.saleCount
      return a.catalogModelId.localeCompare(b.catalogModelId)
    })
    .slice(0, maxResults)
}

// ─── Top price movers (gainers only) ─────────────────────────────────────────
// recent = last recentWindowDays; prior = [priorWindowDays, recentWindowDays)
// Rank: pctChange DESC, catalogModelId ASC

export function computeTopPriceMovers(
  sales: RawSaleRecord[],
  catalogPhotos: CatalogPhotoMap,
  recentWindowDays = RECENT_PRICE_WINDOW_DAYS,
  priorWindowDays = PRIOR_PRICE_WINDOW_DAYS,
  minSamplesEach = PRICE_MOVER_MIN_SAMPLES,
  maxResults = MAX_RESULTS,
  nowMs = Date.now(),
): PriceMoverModel[] {
  const recentStart = nowMs - recentWindowDays * MS_PER_DAY
  const priorStart = nowMs - priorWindowDays * MS_PER_DAY

  type PriceGroup = { firstSale: RawSaleRecord; cents: number[] }
  const recentPrices = new Map<string, PriceGroup>()
  const priorPrices = new Map<string, PriceGroup>()

  for (const s of sales) {
    const cents = Math.round(s.soldPriceDollars * 100)
    if (cents <= 0) continue
    const t = s.completedAt.getTime()

    let map: Map<string, PriceGroup> | null = null
    if (t >= recentStart) {
      map = recentPrices
    } else if (t >= priorStart) {
      map = priorPrices
    }
    if (!map) continue

    const g = map.get(s.catalogModelId)
    if (!g) {
      map.set(s.catalogModelId, { firstSale: s, cents: [cents] })
    } else {
      g.cents.push(cents)
    }
  }

  const results: PriceMoverModel[] = []
  for (const [catalogModelId, rg] of recentPrices) {
    if (rg.cents.length < minSamplesEach) continue
    const pg = priorPrices.get(catalogModelId)
    if (!pg || pg.cents.length < minSamplesEach) continue

    const recentMedianCents = median(rg.cents.slice().sort((a, b) => a - b))
    const priorMedianCents = median(pg.cents.slice().sort((a, b) => a - b))
    if (priorMedianCents <= 0) continue

    const pctChange = ((recentMedianCents - priorMedianCents) / priorMedianCents) * 100
    if (pctChange <= 0) continue

    const { firstSale: f } = rg
    results.push({
      catalogModelId,
      catalogBrand: f.catalogBrand,
      catalogName: f.catalogName,
      catalogYear: f.catalogYear,
      catalogSeries: f.catalogSeries,
      photoUrl: catalogPhotos[catalogModelId] ?? null,
      recentMedianCents,
      priorMedianCents,
      pctChange,
    })
  }

  return results
    .sort((a, b) => {
      if (b.pctChange !== a.pctChange) return b.pctChange - a.pctChange
      return a.catalogModelId.localeCompare(b.catalogModelId)
    })
    .slice(0, maxResults)
}
