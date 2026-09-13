// 22B: canonical ask (current-opportunity) primitives — deliberately separate
// from marketSaleQuery.ts (22A §59/§79). An ask is a currently-purchasable-or-
// visible opportunity, never executed-sale evidence; internal and external asks
// stay distinct (external asks never affect CollectNTrades Lowest Ask, 22A §42).
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { isValidPackagingType, type PackagingType } from '@/lib/marketVariant'
import { normalizeExternalComparableIdentity, EXTERNAL_COMPARABLE_SELECT, type ExternalComparableInput } from '@/lib/normalizedExternalComparable'
import { internalPriceToCents, externalPriceToCents } from '@/lib/marketMoney'

export const DEFAULT_ASK_LIMIT = 100
export const MAX_ASK_LIMIT = 500

export type MarketAskObservation = {
  sourceType: 'internal_ask' | 'external_ask'
  sourceRecordId: string
  catalogModelId: string
  marketVariantId: string | null
  packagingType: PackagingType | null
  priceCents: number
  currency: 'USD'
  listedAt: Date | null
  observedAt: Date | null
  purchasableHere: boolean
}

// ── Internal asks — currently purchasable CollectNTrades listings ──────────
// §37: reuses the established Series-20 "available" predicate
// (Listing.status='active' AND item.status='available') verbatim — no new
// equivalent predicate invented. Current (mutable) ItemInstance identity is
// CORRECT here — this is live inventory, not historical sale evidence.

export type InternalAskInput = {
  id: string
  price: number
  item: {
    catalogId: string
    marketVariantId: string
    marketVariant: { packagingType: string } | null
  }
}

export function toInternalAsk(listing: InternalAskInput): MarketAskObservation {
  return {
    sourceType: 'internal_ask',
    sourceRecordId: listing.id,
    catalogModelId: listing.item.catalogId,
    marketVariantId: listing.item.marketVariantId,
    packagingType: isValidPackagingType(listing.item.marketVariant?.packagingType) ? listing.item.marketVariant!.packagingType : null,
    priceCents: internalPriceToCents(listing.price),
    currency: 'USD',
    listedAt: null,
    observedAt: null,
    purchasableHere: true,
  }
}

export type InternalAskFilter = {
  catalogModelId: string
  marketVariantId?: string
  limit?: number
}

const INTERNAL_ASK_SELECT = {
  id: true,
  price: true,
  item: {
    select: {
      catalogId: true,
      marketVariantId: true,
      marketVariant: { select: { packagingType: true } },
    },
  },
} as const

function buildInternalAskWhere(filter: InternalAskFilter): Prisma.ListingWhereInput {
  return {
    status: 'active',
    item: {
      status: 'available',
      catalogId: filter.catalogModelId,
      ...(filter.marketVariantId !== undefined ? { marketVariantId: filter.marketVariantId } : {}),
    },
  }
}

export async function getInternalAsks(filter: InternalAskFilter): Promise<MarketAskObservation[]> {
  const take = Math.min(filter.limit ?? DEFAULT_ASK_LIMIT, MAX_ASK_LIMIT)
  const rows = await prisma.listing.findMany({
    where: buildInternalAskWhere(filter),
    select: INTERNAL_ASK_SELECT,
    orderBy: [{ price: 'asc' }, { id: 'asc' }],
    take,
  })
  return rows.map(toInternalAsk)
}

// §40/§43: Lowest Ask uses INTERNAL purchasable listings only — external asks
// never contribute, regardless of price.
export async function getLowestAsk(filter: { catalogModelId: string; marketVariantId?: string }): Promise<MarketAskObservation | null> {
  const asks = await getInternalAsks({ ...filter, limit: 1 })
  return asks[0] ?? null
}

// ── Internal ask summary (24B) — Lowest/Median Ask + Available Copies, EXACT
// regardless of eligible population size. getInternalAsks is intentionally
// bounded (DEFAULT_ASK_LIMIT/MAX_ASK_LIMIT) with no hasMore signal, so a median
// computed over its truncated result would silently be wrong once eligible
// supply exceeds the limit. Instead: an exact count(), then only the 1-2
// specific ordered rows the median actually needs (price ASC, id ASC — same
// deterministic order as getInternalAsks) — never a full/bounded fetch-then-
// median. Internal-only; external asks never contribute (same rule as Lowest Ask).
export type InternalAskSummary = {
  lowestAskCents: number | null
  medianAskCents: number | null
  availableCopies: number
}

const ASK_SUMMARY_ORDER_BY: Prisma.ListingOrderByWithRelationInput[] = [{ price: 'asc' }, { id: 'asc' }]

export async function getInternalAskSummary(filter: {
  catalogModelId: string
  marketVariantId?: string
}): Promise<InternalAskSummary> {
  const where = buildInternalAskWhere(filter)

  const availableCopies = await prisma.listing.count({ where })
  if (availableCopies === 0) {
    return { lowestAskCents: null, medianAskCents: null, availableCopies: 0 }
  }

  const lowest = await prisma.listing.findFirst({ where, orderBy: ASK_SUMMARY_ORDER_BY, select: { price: true } })
  const lowestAskCents = lowest ? internalPriceToCents(lowest.price) : null

  let medianAskCents: number | null
  if (availableCopies === 1) {
    medianAskCents = lowestAskCents
  } else if (availableCopies % 2 === 1) {
    const mid = await prisma.listing.findFirst({
      where,
      orderBy: ASK_SUMMARY_ORDER_BY,
      skip: (availableCopies - 1) / 2,
      select: { price: true },
    })
    medianAskCents = mid ? internalPriceToCents(mid.price) : null
  } else {
    const pair = await prisma.listing.findMany({
      where,
      orderBy: ASK_SUMMARY_ORDER_BY,
      skip: availableCopies / 2 - 1,
      take: 2,
      select: { price: true },
    })
    medianAskCents =
      pair.length === 2 ? Math.round((internalPriceToCents(pair[0].price) + internalPriceToCents(pair[1].price)) / 2) : null
  }

  return { lowestAskCents, medianAskCents, availableCopies }
}

// ── External asks — matched active_ask observations, never purchasable here ─

export type ExternalAskInput = ExternalComparableInput & {
  observationType: string
  currency: string
  price: Prisma.Decimal
  listedAt: Date | null
  observedAt: Date
}

export function toExternalAsk(row: ExternalAskInput): MarketAskObservation | null {
  const identity = normalizeExternalComparableIdentity(row)
  if (!identity) return null
  if (row.observationType !== 'active_ask') return null
  if (row.currency !== 'USD') return null
  if (!row.price.gt(0)) return null

  return {
    sourceType: 'external_ask',
    sourceRecordId: identity.externalObservationId,
    catalogModelId: identity.catalogModelId,
    marketVariantId: identity.marketVariantId,
    packagingType: identity.packagingType,
    priceCents: externalPriceToCents(row.price),
    currency: 'USD',
    listedAt: row.listedAt,
    observedAt: row.observedAt,
    purchasableHere: false,
  }
}

export type ExternalAskFilter = {
  catalogModelId: string
  marketVariantId?: string
  provider?: string
  limit?: number
}

const EXTERNAL_ASK_SELECT = {
  ...EXTERNAL_COMPARABLE_SELECT,
  observationType: true,
  currency: true,
  price: true,
  listedAt: true,
  observedAt: true,
} as const

function buildExternalAskWhere(filter: ExternalAskFilter): Prisma.ExternalMarketObservationWhereInput {
  return {
    catalogModelId: filter.catalogModelId,
    matchStatus: 'matched',
    observationType: 'active_ask',
    currency: 'USD',
    price: { gt: 0 },
    ...(filter.marketVariantId !== undefined ? { marketVariantId: filter.marketVariantId } : {}),
    ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
  }
}

export async function getExternalAsks(filter: ExternalAskFilter): Promise<MarketAskObservation[]> {
  const take = Math.min(filter.limit ?? DEFAULT_ASK_LIMIT, MAX_ASK_LIMIT)
  const rows = await prisma.externalMarketObservation.findMany({
    where: buildExternalAskWhere(filter),
    select: EXTERNAL_ASK_SELECT,
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take,
  })
  return rows.map(toExternalAsk).filter((a): a is MarketAskObservation => a !== null)
}
