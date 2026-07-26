import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ComparableSale, TargetModel } from '@/lib/resaleEstimator'

// Cap applied after target-aware filtering — all 500 slots are relevant candidates.
const CANDIDATE_LIMIT = 500

export async function fetchComparableSales(target: TargetModel): Promise<ComparableSale[]> {
  // Build OR conditions matching each level of the hierarchy.
  // Unrelated brands/models are excluded at the DB query level.
  const itemOrConditions: Prisma.ItemInstanceWhereInput[] = [
    // Level 1: exact catalog model
    { catalogId: target.id },
    // Level 2: same brand + name (model family / color-year variants)
    {
      catalog: {
        brand: { equals: target.brand, mode: 'insensitive' },
        name: { equals: target.name, mode: 'insensitive' },
      },
    },
  ]

  // Level 3: same brand + series + year (only when both are known)
  if (target.series && target.year != null) {
    itemOrConditions.push({
      catalog: {
        brand: { equals: target.brand, mode: 'insensitive' },
        series: { equals: target.series, mode: 'insensitive' },
        year: target.year,
      },
    })
  }

  // Level 4: same brand + series (year-agnostic)
  if (target.series) {
    itemOrConditions.push({
      catalog: {
        brand: { equals: target.brand, mode: 'insensitive' },
        series: { equals: target.series, mode: 'insensitive' },
      },
    })
  }

  const rows = await prisma.orderItem.findMany({
    where: {
      order: { status: 'complete', completedAt: { not: null } },
      price: { gt: 0 },
      item: { OR: itemOrConditions },
    },
    select: {
      id: true,
      orderId: true,
      price: true,
      order: { select: { completedAt: true } },
      listing: {
        // Listing.createdAt is the only available listing start timestamp in the schema.
        // There is no activatedAt or publishedAt field.
        select: { createdAt: true },
      },
      item: {
        select: {
          sku: true,
          catalog: {
            select: { id: true, brand: true, name: true, series: true, year: true },
          },
        },
      },
    },
    orderBy: { order: { completedAt: 'desc' } },
    take: CANDIDATE_LIMIT,
  })

  const result: ComparableSale[] = []
  for (const row of rows) {
    if (!row.order.completedAt) continue
    if (!row.listing) continue
    if (!row.item.catalog) continue
    if (row.price <= 0 || !isFinite(row.price)) continue

    result.push({
      orderItemId: row.id,
      orderId: row.orderId,
      catalogModelId: row.item.catalog.id,
      catalogBrand: row.item.catalog.brand,
      catalogName: row.item.catalog.name,
      catalogSeries: row.item.catalog.series,
      catalogYear: row.item.catalog.year,
      soldPriceCents: Math.round(row.price * 100),
      listingCreatedAt: row.listing.createdAt,
      orderCompletedAt: row.order.completedAt,
      sku: row.item.sku,
    })
  }
  return result
}
