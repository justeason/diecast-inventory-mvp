import { prisma } from '@/lib/prisma'

export const OBSERVATIONS_PAGE_SIZE = 25
export const BATCHES_PAGE_SIZE = 25

export type ImportBatchRow = {
  id: string
  provider: string
  sourceType: string
  originalFileName: string | null
  rowCount: number
  importedCount: number
  duplicateCount: number
  errorCount: number
  adminInfo: string | null
  createdAt: Date
}

export type ObservationListRow = {
  id: string
  provider: string
  externalId: string | null
  observationType: string
  matchStatus: string
  title: string
  currency: string
  totalPrice: string
  observedAt: Date
  soldAt: Date | null
  condition: string | null
  catalogModelId: string | null
  catalogModelName: string | null
  createdAt: Date
}

export type ObservationDetail = {
  id: string
  importBatchId: string | null
  provider: string
  externalId: string | null
  fingerprint: string
  observationType: string
  matchStatus: string
  matchMethod: string | null
  title: string
  sourceUrl: string | null     // admin-only
  currency: string
  price: string
  shippingPrice: string | null
  totalPrice: string
  soldAt: Date | null
  listedAt: Date | null
  observedAt: Date
  condition: string | null
  locationText: string | null
  rawSnapshot: unknown         // admin-only
  rejectionReason: string | null
  catalogModelId: string | null
  catalogModelName: string | null
  updatedAt: Date
  audits: Array<{
    id: string
    action: string
    adminInfo: string | null
    createdAt: Date
  }>
  createdAt: Date
}

export type DashboardStats = {
  totalObservations: number
  matchedCount: number
  unmatchedCount: number
  rejectedCount: number
  totalBatches: number
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [totalObservations, matchedCount, unmatchedCount, rejectedCount, totalBatches] =
    await Promise.all([
      prisma.externalMarketObservation.count(),
      prisma.externalMarketObservation.count({ where: { matchStatus: 'matched' } }),
      prisma.externalMarketObservation.count({ where: { matchStatus: 'unmatched' } }),
      prisma.externalMarketObservation.count({ where: { matchStatus: 'rejected' } }),
      prisma.externalMarketImportBatch.count(),
    ])
  return { totalObservations, matchedCount, unmatchedCount, rejectedCount, totalBatches }
}

// Keyset pagination on id DESC (newest first).
// Returns nextCursor to pass as afterId on the next call; null means last page.
export async function listImportBatches(afterId: string | undefined): Promise<{
  batches: ImportBatchRow[]
  nextCursor: string | null
  total: number
}> {
  const [batches, total] = await Promise.all([
    prisma.externalMarketImportBatch.findMany({
      where:   afterId ? { id: { lt: afterId } } : undefined,
      orderBy: { id: 'desc' },
      take:    BATCHES_PAGE_SIZE + 1,
      select: {
        id: true, provider: true, sourceType: true, originalFileName: true,
        rowCount: true, importedCount: true, duplicateCount: true, errorCount: true,
        adminInfo: true, createdAt: true,
      },
    }),
    prisma.externalMarketImportBatch.count(),
  ])

  const hasMore = batches.length > BATCHES_PAGE_SIZE
  const page    = hasMore ? batches.slice(0, BATCHES_PAGE_SIZE) : batches
  return {
    batches:    page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
    total,
  }
}

export type ObservationFilter = {
  matchStatus?:   string
  provider?:      string
  catalogModelId?: string
}

// Keyset pagination on id DESC (newest first).
export async function listObservations(
  afterId: string | undefined,
  filter: ObservationFilter = {},
): Promise<{ observations: ObservationListRow[]; nextCursor: string | null; total: number }> {
  const where = {
    ...(afterId              ? { id: { lt: afterId } }                     : {}),
    ...(filter.matchStatus   ? { matchStatus: filter.matchStatus }         : {}),
    ...(filter.provider      ? { provider:    filter.provider }            : {}),
    ...(filter.catalogModelId ? { catalogModelId: filter.catalogModelId }  : {}),
  }

  // Count uses filter without the cursor so the total reflects the filtered set.
  const countWhere = {
    ...(filter.matchStatus   ? { matchStatus:   filter.matchStatus }       : {}),
    ...(filter.provider      ? { provider:      filter.provider }          : {}),
    ...(filter.catalogModelId ? { catalogModelId: filter.catalogModelId }  : {}),
  }

  const [rows, total] = await Promise.all([
    prisma.externalMarketObservation.findMany({
      where,
      orderBy: { id: 'desc' },
      take:    OBSERVATIONS_PAGE_SIZE + 1,
      select: {
        id: true, provider: true, externalId: true, observationType: true,
        matchStatus: true, title: true, currency: true, totalPrice: true,
        observedAt: true, soldAt: true, condition: true,
        catalogModelId: true,
        catalogModel: { select: { brand: true, name: true } },
        createdAt: true,
      },
    }),
    prisma.externalMarketObservation.count({ where: countWhere }),
  ])

  const hasMore = rows.length > OBSERVATIONS_PAGE_SIZE
  const page    = hasMore ? rows.slice(0, OBSERVATIONS_PAGE_SIZE) : rows

  return {
    observations: page.map(r => ({
      id:              r.id,
      provider:        r.provider,
      externalId:      r.externalId,
      observationType: r.observationType,
      matchStatus:     r.matchStatus,
      title:           r.title,
      currency:        r.currency,
      totalPrice:      r.totalPrice.toString(),
      observedAt:      r.observedAt,
      soldAt:          r.soldAt,
      condition:       r.condition,
      catalogModelId:  r.catalogModelId,
      catalogModelName: r.catalogModel
        ? `${r.catalogModel.brand} ${r.catalogModel.name}`
        : null,
      createdAt: r.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
    total,
  }
}

export async function getObservationById(id: string): Promise<ObservationDetail | null> {
  const row = await prisma.externalMarketObservation.findUnique({
    where: { id },
    select: {
      id: true, importBatchId: true, provider: true, externalId: true, fingerprint: true,
      observationType: true, matchStatus: true, matchMethod: true, title: true,
      sourceUrl: true, currency: true, price: true, shippingPrice: true, totalPrice: true,
      soldAt: true, listedAt: true, observedAt: true, condition: true, locationText: true,
      rawSnapshot: true, rejectionReason: true, catalogModelId: true,
      catalogModel: { select: { brand: true, name: true } },
      updatedAt: true,
      audits: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, action: true, adminInfo: true, createdAt: true },
      },
      createdAt: true,
    },
  })

  if (!row) return null

  return {
    id:              row.id,
    importBatchId:   row.importBatchId,
    provider:        row.provider,
    externalId:      row.externalId,
    fingerprint:     row.fingerprint,
    observationType: row.observationType,
    matchStatus:     row.matchStatus,
    matchMethod:     row.matchMethod,
    title:           row.title,
    sourceUrl:       row.sourceUrl,
    currency:        row.currency,
    price:           row.price.toString(),
    shippingPrice:   row.shippingPrice?.toString() ?? null,
    totalPrice:      row.totalPrice.toString(),
    soldAt:          row.soldAt,
    listedAt:        row.listedAt,
    observedAt:      row.observedAt,
    condition:       row.condition,
    locationText:    row.locationText,
    rawSnapshot:     row.rawSnapshot,
    rejectionReason: row.rejectionReason,
    catalogModelId:  row.catalogModelId,
    catalogModelName: row.catalogModel
      ? `${row.catalogModel.brand} ${row.catalogModel.name}`
      : null,
    updatedAt: row.updatedAt,
    audits:    row.audits,
    createdAt: row.createdAt,
  }
}
