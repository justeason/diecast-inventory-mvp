// 15E: DB boundary for the intake exception queue. Read-only (section 33) — never
// mutates (see actions/intakeExceptions.ts for resolution mutations). Bounded,
// targeted queries only (section 34): DB-side open-exception filter + summary counts,
// keyset pagination, batched seller/portfolio hydration, no full IntakeDraft/
// ItemInstance/CatalogModel load, 14C only in getExceptionDetail.

import { prisma } from '@/lib/prisma'
import {
  openIntakeExceptionWhere, isKnownExceptionCode, codesForCategory,
  type ExceptionCategory, type ExceptionAgeGroup, type IntakeExceptionCode,
} from '@/lib/intakeExceptions'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import type { PricingIntelligenceResult } from '@/lib/pricingIntelligence'
import type { Prisma } from '@prisma/client'

const PAGE_SIZE = 25

export type ExceptionQueueFilter = {
  code?: IntakeExceptionCode | null
  category?: ExceptionCategory | null
  portfolioId?: string | null
  shipmentId?: string | null
  profileId?: string | null
  ageGroup?: ExceptionAgeGroup | null
  q?: string
}

export type ExceptionQueueRow = {
  id: string
  code: string
  note: string | null
  createdAt: Date
  catalogLabel: string | null // resolved catalog if any; null = still unresolved (unknown_model)
  draftLabel: string // brand/name string fields fallback when catalog not yet resolved
  storageLabel: string | null
  condition: string | null
  cardedOrLoose: string | null
  source: 'workbench' | 'manual'
  sellerInboundShipmentId: string | null
  shipmentTrackingNumber: string | null
  portfolioId: string | null
  portfolioName: string | null
  sellerProfileId: string | null
  sellerLabel: string | null
}

function ageGroupCutoff(group: ExceptionAgeGroup, now: Date): Prisma.DateTimeFilter {
  const h = (n: number) => new Date(now.getTime() - n * 3_600_000)
  switch (group) {
    case '<1h': return { gt: h(1) }
    case '1-24h': return { lte: h(1), gt: h(24) }
    case '1-3d': return { lte: h(24), gt: h(72) }
    case '>3d': return { lte: h(72) }
  }
}

function buildWhere(filter: ExceptionQueueFilter, now: Date): Prisma.IntakeDraftWhereInput {
  const where: Prisma.IntakeDraftWhereInput = { ...openIntakeExceptionWhere() }

  if (filter.code && isKnownExceptionCode(filter.code)) {
    where.workbenchExceptionCode = filter.code
  } else if (filter.category) {
    where.workbenchExceptionCode = { in: codesForCategory(filter.category) }
  }
  if (filter.shipmentId) where.sellerInboundShipmentId = filter.shipmentId
  if (filter.portfolioId) {
    where.OR = [
      { sellerInboundShipment: { sellerPortfolioId: filter.portfolioId } },
      { sellerSubmission: { sellerPortfolioId: filter.portfolioId } },
    ]
  }
  if (filter.profileId) where.sellerSubmission = { profileId: filter.profileId }
  if (filter.ageGroup) where.createdAt = ageGroupCutoff(filter.ageGroup, now)

  const q = filter.q?.trim()
  if (q) {
    const textOr: Prisma.IntakeDraftWhereInput[] = [
      { id: q },
      { sellerInboundShipmentId: q },
      { brand: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
      { catalogModel: { OR: [{ brand: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } },
      { sellerInboundShipment: { sellerPortfolio: { name: { contains: q, mode: 'insensitive' } } } },
      { sellerSubmission: { sellerPortfolio: { name: { contains: q, mode: 'insensitive' } } } },
    ]
    // Combine with any existing OR (portfolioId) via AND so both constraints hold.
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: textOr }]
      delete where.OR
    } else {
      where.OR = textOr
    }
  }

  return where
}

const ROW_SELECT = {
  id: true, workbenchExceptionCode: true, workbenchExceptionNote: true, createdAt: true,
  brand: true, name: true, condition: true, cardedOrLoose: true,
  catalogModel: { select: { brand: true, name: true } },
  intakeLocation: { select: { label: true } },
  sellerInboundShipmentId: true,
  sellerInboundShipment: { select: { trackingNumber: true, sellerPortfolioId: true, sellerPortfolio: { select: { id: true, name: true } } } },
  sellerSubmission: { select: { profileId: true, sellerPortfolioId: true, sellerPortfolio: { select: { id: true, name: true } } } },
} as const

async function hydrateSellerLabels(profileIds: string[]): Promise<Map<string, string>> {
  if (profileIds.length === 0) return new Map()
  const profiles = await prisma.sellerProfile.findMany({
    where: { profileId: { in: profileIds } },
    select: { profileId: true, profile: { select: { name: true, email: true } } },
  })
  return new Map(profiles.map((p) => [p.profileId, p.profile.name ?? p.profile.email]))
}

function toRow(d: Prisma.IntakeDraftGetPayload<{ select: typeof ROW_SELECT }>, sellerLabels: Map<string, string>): ExceptionQueueRow {
  const portfolio = d.sellerInboundShipment?.sellerPortfolio ?? d.sellerSubmission?.sellerPortfolio ?? null
  const profileId = d.sellerSubmission?.profileId ?? null
  return {
    id: d.id,
    code: d.workbenchExceptionCode!,
    note: d.workbenchExceptionNote,
    createdAt: d.createdAt,
    catalogLabel: d.catalogModel ? `${d.catalogModel.brand} ${d.catalogModel.name}` : null,
    draftLabel: [d.brand, d.name].filter(Boolean).join(' ') || 'Untitled',
    storageLabel: d.intakeLocation?.label ?? null,
    condition: d.condition,
    cardedOrLoose: d.cardedOrLoose,
    source: d.sellerInboundShipmentId ? 'workbench' : 'manual',
    sellerInboundShipmentId: d.sellerInboundShipmentId,
    shipmentTrackingNumber: d.sellerInboundShipment?.trackingNumber ?? null,
    portfolioId: portfolio?.id ?? null,
    portfolioName: portfolio?.name ?? null,
    sellerProfileId: profileId,
    sellerLabel: profileId ? sellerLabels.get(profileId) ?? null : null,
  }
}

export async function searchExceptionQueue(
  filter: ExceptionQueueFilter,
  cursor: string | null,
  pageSize: number = PAGE_SIZE,
): Promise<{ items: ExceptionQueueRow[]; nextCursor: string | null }> {
  const where = buildWhere(filter, new Date())

  const rows = await prisma.intakeDraft.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: pageSize + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: ROW_SELECT,
  })

  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows

  const profileIds = [...new Set(page.map((d) => d.sellerSubmission?.profileId).filter((x): x is string => !!x))]
  const sellerLabels = await hydrateSellerLabels(profileIds)

  return {
    items: page.map((d) => toRow(d, sellerLabels)),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  }
}

export type ExceptionQueueSummary = {
  open: number
  byCategory: Record<ExceptionCategory, number>
  byCode: Record<IntakeExceptionCode, number>
  oldestCreatedAt: Date | null
}

export async function getExceptionQueueSummary(scope: { portfolioId?: string | null; shipmentId?: string | null } = {}): Promise<ExceptionQueueSummary> {
  const where = buildWhere({ portfolioId: scope.portfolioId, shipmentId: scope.shipmentId }, new Date())

  const [grouped, oldest] = await Promise.all([
    prisma.intakeDraft.groupBy({
      by: ['workbenchExceptionCode'],
      where,
      _count: { _all: true },
    }),
    prisma.intakeDraft.findFirst({
      where, orderBy: { createdAt: 'asc' }, select: { createdAt: true },
    }),
  ])

  const byCode: Record<IntakeExceptionCode, number> = {
    unknown_model: 0, invalid_storage: 0, missing_condition: 0, unexpected_overage: 0, conversion_failed: 0,
  }
  let open = 0
  for (const g of grouped) {
    const code = g.workbenchExceptionCode
    if (code && isKnownExceptionCode(code)) byCode[code] = g._count._all
    open += g._count._all
  }
  const byCategory: Record<ExceptionCategory, number> = {
    data_fixable: byCode.unknown_model + byCode.invalid_storage + byCode.missing_condition,
    retryable: byCode.conversion_failed,
    commercial_blocker: byCode.unexpected_overage,
  }

  return { open, byCategory, byCode, oldestCreatedAt: oldest?.createdAt ?? null }
}

// ── Detail (section 9) — one bounded, targeted read for a single draft's full
// resolution context. 14C pricing is fetched here ONLY (never per queue row). ───────

export type ExceptionDetail = {
  id: string
  code: string
  note: string | null
  // 15E-review section 1/7: immutable first-detection evidence, distinct from
  // code/note above (which reflect the CURRENT/live blocker). Null only for legacy
  // rows that predate the backfill migration and somehow still lack evidence (should
  // not occur given the migration's backfill, but the type stays honest about it).
  initialCode: string | null
  initialNote: string | null
  initialExceptionAt: Date | null
  createdAt: Date
  status: string
  brand: string | null
  name: string | null
  year: number | null
  series: string | null
  color: string | null
  scale: string | null
  condition: string | null
  cardedOrLoose: string | null
  conditionNotes: string | null
  frontPhotoUrl: string | null
  backPhotoUrl: string | null
  catalogModelId: string | null
  catalogLabel: string | null
  storageLocationId: string | null
  storageLabel: string | null
  convertedItemId: string | null
  convertedItemSku: string | null
  submission: { id: string } | null
  portfolio: { id: string; name: string | null } | null
  agreement: { id: string; status: string; type: string } | null
  shipment: { id: string; trackingNumber: string | null; receivedQuantity: number | null } | null
  sellerLabel: string | null
  pricing: PricingIntelligenceResult | null
}

export async function getExceptionDetail(draftId: string): Promise<ExceptionDetail | null> {
  const draft = await prisma.intakeDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true, status: true, workbenchExceptionCode: true, workbenchExceptionNote: true, createdAt: true,
      initialExceptionCode: true, initialExceptionNote: true, initialExceptionAt: true,
      brand: true, name: true, year: true, series: true, color: true, scale: true,
      condition: true, cardedOrLoose: true, conditionNotes: true, frontPhotoUrl: true, backPhotoUrl: true,
      catalogModelId: true, storageLocationId: true, convertedItemId: true,
      catalogModel: { select: { brand: true, name: true } },
      intakeLocation: { select: { label: true } },
      sellerSubmissionId: true,
      sellerSubmission: { select: { id: true, profileId: true, sellerPortfolioId: true, sellerPortfolio: { select: { id: true, name: true } } } },
      sellerInboundShipmentId: true,
      sellerInboundShipment: { select: { id: true, trackingNumber: true, receivedQuantity: true, sellerPortfolioId: true, sellerPortfolio: { select: { id: true, name: true } } } },
    },
  })
  if (!draft || draft.workbenchExceptionCode === null) return null

  const submissionId = draft.sellerSubmissionId
  const [agreement, sellerProfile, intel, convertedItem] = await Promise.all([
    submissionId
      ? prisma.sellerAgreement.findFirst({
          where: { submissionId, status: { not: 'cancelled' } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, type: true },
        })
      : Promise.resolve(null),
    (async () => {
      if (!submissionId) return null
      const sub = await prisma.sellerSubmission.findUnique({ where: { id: submissionId }, select: { profileId: true } })
      if (!sub) return null
      return prisma.sellerProfile.findUnique({ where: { profileId: sub.profileId }, select: { profile: { select: { name: true, email: true } } } })
    })(),
    draft.catalogModelId ? getPricingIntelligence(draft.catalogModelId) : Promise.resolve(null),
    draft.convertedItemId
      ? prisma.itemInstance.findUnique({ where: { id: draft.convertedItemId }, select: { sku: true } })
      : Promise.resolve(null),
  ])

  const portfolio = draft.sellerInboundShipment?.sellerPortfolio ?? draft.sellerSubmission?.sellerPortfolio ?? null

  return {
    id: draft.id,
    code: draft.workbenchExceptionCode,
    note: draft.workbenchExceptionNote,
    initialCode: draft.initialExceptionCode,
    initialNote: draft.initialExceptionNote,
    initialExceptionAt: draft.initialExceptionAt,
    createdAt: draft.createdAt,
    status: draft.status,
    brand: draft.brand, name: draft.name, year: draft.year, series: draft.series, color: draft.color, scale: draft.scale,
    condition: draft.condition, cardedOrLoose: draft.cardedOrLoose, conditionNotes: draft.conditionNotes,
    frontPhotoUrl: draft.frontPhotoUrl, backPhotoUrl: draft.backPhotoUrl,
    catalogModelId: draft.catalogModelId,
    catalogLabel: draft.catalogModel ? `${draft.catalogModel.brand} ${draft.catalogModel.name}` : null,
    storageLocationId: draft.storageLocationId,
    storageLabel: draft.intakeLocation?.label ?? null,
    convertedItemId: draft.convertedItemId,
    convertedItemSku: convertedItem?.sku ?? null,
    submission: draft.sellerSubmissionId ? { id: draft.sellerSubmissionId } : null,
    portfolio,
    agreement,
    shipment: draft.sellerInboundShipment
      ? { id: draft.sellerInboundShipment.id, trackingNumber: draft.sellerInboundShipment.trackingNumber, receivedQuantity: draft.sellerInboundShipment.receivedQuantity }
      : null,
    sellerLabel: sellerProfile ? (sellerProfile.profile.name ?? sellerProfile.profile.email) : null,
    pricing: intel,
  }
}
