// 15C: DB boundary for the unified ItemInstance lifecycle read model. Read-only
// (section 23 — never mutates ItemInstance/Listing/Order/SellerAgreement/SellerPayout/
// storage/lifecycle events). Bounded, targeted queries for the detail page; keyset
// pagination + DB-side filters for search (section 24). No buyer PII in the
// lightweight list/search read model (section 25).

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { decimalFromFloatDollars } from '@/lib/businessAnalyticsMath'
import {
  deriveItemLifecycleStage,
  detectItemContradictions,
  type ItemLifecycleStage,
  type ItemContradiction,
} from '@/lib/itemLifecycle'
import { getPricingIntelligence, getListingPriceComparison } from '@/lib/pricingIntelligenceQuery'
import type { PricingIntelligenceResult, ListingPriceComparison } from '@/lib/pricingIntelligence'

// ── Timeline (section 9) — built entirely from raw authoritative timestamp fields,
// never from a second, potentially-duplicative representation (e.g. SellerLifecycleEvent)
// of the same occurrence. Fixed per-type priority is the deterministic tie-breaker when
// two events share the exact same timestamp. ──────────────────────────────────────────

export type ItemTimelineEntry = { title: string; occurredAt: Date; priority: number }

const TIMELINE_PRIORITY: Record<string, number> = {
  submission_created: 0,
  agreement_proposed: 1,
  agreement_accepted: 2,
  shipment_created: 3,
  shipment_received: 4,
  intake_started: 5,
  item_created: 6,
  listing_created: 7,
  order_created: 8,
  order_completed: 9,
  payout_line_created: 10,
  payout_paid: 11,
}

function sortTimeline(entries: ItemTimelineEntry[]): ItemTimelineEntry[] {
  return [...entries].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.priority - b.priority)
}

export type ItemSourceInfo = {
  type: 'consignment' | 'buyout' | 'company_owned' | 'unknown'
  sellerProfileId: string | null
  sellerLabel: string | null
  sellerPortfolioId: string | null
  portfolioName: string | null
  submissionId: string | null
  agreementId: string | null
  agreementStatus: string | null
  // 15D: authoritative when set directly from ItemInstance.sellerInboundShipmentId
  // (see shipmentLineageExplicit) — the workbench sets this exactly once at
  // conversion, never inferred. Falls back to the legacy single-shipment inference
  // below only for items created before 15D.
  inboundShipmentId: string | null
  // true only for the legacy (pre-15D) inference path: exactly one non-cancelled
  // shipment exists for the submission, so it PROBABLY — not provably — covered this
  // item. False whenever inboundShipmentId came from the explicit 15D field.
  shipmentLineageExplicit: boolean
  // true when the submission has MULTIPLE non-cancelled shipments AND this item has no
  // explicit 15D lineage — this ItemInstance cannot prove which one physically
  // contained it (no per-item shipment FK existed pre-15D). Never guessed from seller/
  // timestamp/order/quantity — see 15C-review section 6. 15D added the explicit FK
  // (ItemInstance.sellerInboundShipmentId) so this ambiguity can no longer occur for
  // items created via the bulk intake workbench.
  shipmentLineageAmbiguous: boolean
  intakeDraftId: string | null
}

export type ItemLifecycleRecord = {
  item: {
    id: string
    sku: string
    catalogId: string
    brand: string
    name: string
    series: string | null
    year: number | null
    color: string | null
    scale: string | null
    cardedOrLoose: string
    condition: string
    conditionNotes: string | null
    status: string
    listPrice: number | null
    notes: string | null
    createdAt: Date
    updatedAt: Date
  }
  location: { id: string; label: string } | null
  source: ItemSourceInfo
  listing: { id: string; status: string; price: number; version: number; createdAt: Date; updatedAt: Date } | null
  order: {
    orderId: string
    orderItemId: string
    status: string
    paymentStatus: string
    price: number
    createdAt: Date
    completedAt: Date | null
    paidAt: Date | null
  } | null
  financial: {
    sourceType: string | null
    purchasePrice: number | null // admin-only — buyout/company-owned acquisition cost
    grossSalePrice: Prisma.Decimal | null
    commissionAmount: Prisma.Decimal | null
    sellerProceeds: Prisma.Decimal | null
    grossMargin: Prisma.Decimal | null // company-owned/buyout only — sale price minus purchase cost. NOT "profit".
    payoutStatus: string | null
    payoutId: string | null
  }
  pricing: {
    intelligence: PricingIntelligenceResult | null
    listingComparison: ListingPriceComparison | null
  }
  lifecycleStage: ItemLifecycleStage
  contradictions: ItemContradiction[]
  timeline: ItemTimelineEntry[]
  // 15C-review section 2: explicit indication that more order-attempt history exists
  // beyond the bounded timeline slice above — never silently truncated.
  additionalOrderHistoryCount: number
}

// 15C-review section 1: current-state correctness must never depend on an arbitrary
// history cap. These two queries are each independently bounded (take: 1) and
// together are sufficient to determine the authoritative current order — a completed
// sale always exists as at most one row to find, and only ONE active (non-cancelled,
// non-complete) order can exist for an item at a time (creating a new order requires
// the item to be 'available', and reservation flips it to 'reserved' atomically) — so
// neither query can ever "miss" the relevant row by scanning too few candidates,
// regardless of how many CANCELLED historical attempts exist.
const ORDER_SELECT = {
  id: true, price: true, createdAt: true,
  order: { select: { id: true, status: true, paymentStatus: true, completedAt: true, paidAt: true, createdAt: true } },
} as const

async function fetchCompletedOrderItem(itemId: string) {
  return prisma.orderItem.findFirst({
    where: { itemId, order: { status: 'complete' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // earliest — deterministic even if >1 exists (see multiple_completed_sales)
    select: ORDER_SELECT,
  })
}

async function fetchActiveOrderItem(itemId: string) {
  return prisma.orderItem.findFirst({
    where: { itemId, order: { status: { notIn: ['complete', 'cancelled'] } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // latest live reservation/payment attempt
    select: ORDER_SELECT,
  })
}

// Presentation-only bound for the timeline's order history — never consulted for
// current-state determination (section 2). See getItemLifecycleRecord's `timeline`
// construction and `additionalOrderHistoryCount` on the returned record.
const TIMELINE_ORDER_HISTORY_LIMIT = 20

export async function getItemLifecycleRecord(itemId: string): Promise<ItemLifecycleRecord | null> {
  const item = await prisma.itemInstance.findUnique({
    where: { id: itemId },
    select: {
      id: true, sku: true, catalogId: true, locationId: true,
      cardedOrLoose: true, condition: true, conditionNotes: true,
      purchasePrice: true, listPrice: true, status: true, notes: true,
      sourceType: true, sellerAgreementId: true, sellerPortfolioId: true,
      sellerInboundShipmentId: true,
      createdAt: true, updatedAt: true,
      catalog: { select: { brand: true, name: true, series: true, year: true, color: true, scale: true } },
      location: { select: { id: true, label: true } },
      listing: { select: { id: true, status: true, price: true, version: true, createdAt: true, updatedAt: true } },
      intakeDraft: { select: { id: true, sellerSubmissionId: true, createdAt: true } },
    },
  })
  if (!item) return null

  const [
    agreement, completedOrderItem, activeOrderItem, completedOrderCount,
    recentOrderItemsForTimeline, totalOrderItemCount,
  ] = await Promise.all([
    item.sellerAgreementId
      ? prisma.sellerAgreement.findUnique({
          where: { id: item.sellerAgreementId },
          select: {
            id: true, status: true, submissionId: true, sellerProfileId: true, sellerPortfolioId: true,
            proposedAt: true, acceptedAt: true,
          },
        })
      : null,
    fetchCompletedOrderItem(itemId),
    fetchActiveOrderItem(itemId),
    // Bounded COUNT (section 3) — proves "more than one" without loading a list.
    prisma.orderItem.count({ where: { itemId, order: { status: 'complete' } } }),
    // Bounded, presentation-only recent history for the timeline (section 2) —
    // completely separate from current-order determination above.
    prisma.orderItem.findMany({
      where: { itemId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_ORDER_HISTORY_LIMIT,
      select: ORDER_SELECT,
    }),
    prisma.orderItem.count({ where: { itemId } }),
  ])

  // completedOrder always wins when present (terminal, authoritative); otherwise the
  // current active order; otherwise null. See selectCurrentOrder for the equivalent
  // pure precedence rule this mirrors.
  const currentOrderItem = completedOrderItem ?? activeOrderItem ?? null

  const payoutLine = currentOrderItem
    ? await prisma.sellerPayoutLine.findFirst({
        where: { orderItemId: currentOrderItem.id },
        select: {
          id: true, orderItemId: true, status: true, grossSalePrice: true, commissionAmount: true, netAmount: true,
          payoutId: true, createdAt: true, payout: { select: { id: true, status: true, paidAt: true } },
        },
      })
    : null

  const submissionId = item.intakeDraft?.sellerSubmissionId ?? agreement?.submissionId ?? null

  const [submission, portfolio, shipments] = await Promise.all([
    submissionId
      ? prisma.sellerSubmission.findUnique({
          where: { id: submissionId },
          select: { id: true, createdAt: true, profileId: true, sellerPortfolioId: true },
        })
      : null,
    item.sellerPortfolioId
      ? prisma.sellerPortfolio.findUnique({ where: { id: item.sellerPortfolioId }, select: { id: true, name: true } })
      : null,
    submissionId
      ? prisma.sellerInboundShipment.findMany({
          where: { sellerSubmissionId: submissionId, status: { not: 'cancelled' } },
          select: { id: true, createdAt: true, receivedAt: true },
        })
      : [],
  ])

  const sellerProfile = submission
    ? await prisma.sellerProfile.findUnique({
        where: { profileId: submission.profileId },
        select: { id: true, profile: { select: { name: true, email: true } } },
      })
    : null

  // Source type: authoritative from ItemInstance.sourceType — null (legacy/manual
  // creation) is reported as 'unknown', never guessed as consignment/buyout.
  const sourceType: ItemSourceInfo['type'] =
    item.sourceType === 'consignment' || item.sourceType === 'buyout' || item.sourceType === 'company_owned'
      ? item.sourceType
      : 'unknown'

  const source: ItemSourceInfo = {
    type: sourceType,
    sellerProfileId: sellerProfile?.id ?? null,
    sellerLabel: sellerProfile ? (sellerProfile.profile.name ?? sellerProfile.profile.email) : null,
    sellerPortfolioId: item.sellerPortfolioId,
    portfolioName: portfolio?.name ?? null,
    submissionId,
    agreementId: item.sellerAgreementId,
    agreementStatus: agreement?.status ?? null,
    inboundShipmentId: item.sellerInboundShipmentId ?? (shipments.length === 1 ? shipments[0].id : null),
    shipmentLineageExplicit: item.sellerInboundShipmentId !== null,
    shipmentLineageAmbiguous: item.sellerInboundShipmentId === null && shipments.length > 1,
    intakeDraftId: item.intakeDraft?.id ?? null,
  }

  const order = currentOrderItem
    ? {
        orderId: currentOrderItem.order.id,
        orderItemId: currentOrderItem.id,
        status: currentOrderItem.order.status,
        paymentStatus: currentOrderItem.order.paymentStatus,
        price: currentOrderItem.price,
        createdAt: currentOrderItem.createdAt,
        completedAt: currentOrderItem.order.completedAt,
        paidAt: currentOrderItem.order.paidAt,
      }
    : null

  const consignmentPayoutSettled =
    sourceType === 'consignment' && item.status === 'sold'
      ? payoutLine !== null && (payoutLine.status === 'voided' || payoutLine.payout?.status === 'paid')
      : null

  const contradictions = detectItemContradictions({
    itemStatus: item.status,
    hasActiveListing: item.listing?.status === 'active',
    hasCompletedOrderItem: completedOrderCount > 0,
    sourceType: item.sourceType,
    hasAnyPayoutLine: payoutLine !== null,
    locationId: item.locationId,
    sellerPortfolioId: item.sellerPortfolioId,
    agreementPortfolioId: agreement ? agreement.sellerPortfolioId : undefined,
    completedOrderCount,
  })

  const lifecycleStage = deriveItemLifecycleStage({
    itemStatus: item.status,
    sourceType: item.sourceType,
    hasActiveListing: item.listing?.status === 'active',
    hasCompletedOrder: order !== null && order.status === 'complete',
    currentOrderStatus: order?.status ?? null,
    currentOrderPaymentStatus: order?.paymentStatus ?? null,
    consignmentPayoutSettled,
    contradictions,
  })

  const financial = {
    sourceType: item.sourceType,
    purchasePrice: item.purchasePrice,
    grossSalePrice: payoutLine?.grossSalePrice ?? (order ? decimalFromFloatDollars(order.price) : null),
    commissionAmount: payoutLine?.commissionAmount ?? null,
    sellerProceeds: payoutLine?.netAmount ?? null,
    grossMargin:
      sourceType !== 'consignment' && order && item.purchasePrice !== null
        ? decimalFromFloatDollars(order.price).minus(decimalFromFloatDollars(item.purchasePrice))
        : null,
    payoutStatus: payoutLine ? (payoutLine.payout?.status ?? payoutLine.status) : null,
    payoutId: payoutLine?.payoutId ?? null,
  }

  const [intelligence, listingComparisonResult] = await Promise.all([
    getPricingIntelligence(item.catalogId),
    item.listing ? getListingPriceComparison(item.listing.id) : Promise.resolve(null),
  ])
  const listingComparison = listingComparisonResult?.comparison ?? null

  const timeline: ItemTimelineEntry[] = []
  if (submission) timeline.push({ title: 'Seller submission created', occurredAt: submission.createdAt, priority: TIMELINE_PRIORITY.submission_created })
  if (agreement?.proposedAt) timeline.push({ title: 'Agreement proposed', occurredAt: agreement.proposedAt, priority: TIMELINE_PRIORITY.agreement_proposed })
  if (agreement?.acceptedAt) timeline.push({ title: 'Agreement accepted', occurredAt: agreement.acceptedAt, priority: TIMELINE_PRIORITY.agreement_accepted })
  for (const s of shipments) {
    timeline.push({ title: 'Inbound shipment created', occurredAt: s.createdAt, priority: TIMELINE_PRIORITY.shipment_created })
    if (s.receivedAt) timeline.push({ title: 'Shipment received', occurredAt: s.receivedAt, priority: TIMELINE_PRIORITY.shipment_received })
  }
  if (item.intakeDraft) timeline.push({ title: 'Intake started', occurredAt: item.intakeDraft.createdAt, priority: TIMELINE_PRIORITY.intake_started })
  timeline.push({ title: 'Item created', occurredAt: item.createdAt, priority: TIMELINE_PRIORITY.item_created })
  if (item.listing) timeline.push({ title: 'Listing created', occurredAt: item.listing.createdAt, priority: TIMELINE_PRIORITY.listing_created })
  // 15C-review section 2: a BOUNDED, presentation-only slice of order history — most
  // recent TIMELINE_ORDER_HISTORY_LIMIT attempts, including cancelled ones, so
  // historical cancelled orders remain visible even though they are never "current"
  // (section 2/9). This bound affects ONLY what's displayed here; it played no part in
  // determining `order`/`lifecycleStage`/`financial` above, which used the two
  // dedicated, unbounded-correctness queries instead. No timestamp is fabricated for
  // cancellation itself: Order has no authoritative `cancelledAt` field, only a
  // generic `updatedAt`, which is never used to label a specific event (section 7).
  for (const oi of recentOrderItemsForTimeline) {
    const label = oi.order.status === 'cancelled' ? 'Order created (cancelled)' : 'Order created'
    timeline.push({ title: label, occurredAt: oi.createdAt, priority: TIMELINE_PRIORITY.order_created })
    if (oi.order.completedAt) timeline.push({ title: 'Sale completed', occurredAt: oi.order.completedAt, priority: TIMELINE_PRIORITY.order_completed })
  }
  if (payoutLine) {
    timeline.push({ title: 'Seller payout obligation created', occurredAt: payoutLine.createdAt, priority: TIMELINE_PRIORITY.payout_line_created })
    if (payoutLine.payout?.paidAt) timeline.push({ title: 'Seller payout paid', occurredAt: payoutLine.payout.paidAt, priority: TIMELINE_PRIORITY.payout_paid })
  }

  return {
    item: {
      id: item.id, sku: item.sku, catalogId: item.catalogId,
      brand: item.catalog.brand, name: item.catalog.name, series: item.catalog.series,
      year: item.catalog.year, color: item.catalog.color, scale: item.catalog.scale,
      cardedOrLoose: item.cardedOrLoose, condition: item.condition, conditionNotes: item.conditionNotes,
      status: item.status, listPrice: item.listPrice, notes: item.notes,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    },
    location: item.location,
    source,
    listing: item.listing,
    order,
    financial,
    pricing: { intelligence, listingComparison },
    lifecycleStage,
    contradictions,
    timeline: sortTimeline(timeline),
    additionalOrderHistoryCount: Math.max(0, totalOrderItemCount - recentOrderItemsForTimeline.length),
  }
}

// ── Item search / list (section 14/24) — DB-side filters, keyset pagination, no
// full-table load, batched hydration of listing/location (never N+1). No buyer PII
// (section 25) — this is the lightweight list read model, not the detail record. ────

export type ItemSearchFilter = {
  q: string
  status: string
  condition: string
  cardedOrLoose: string
  sort: 'newest' | 'oldest' | 'sku' | 'brand' | 'status'
}

export type ItemSearchRow = {
  id: string
  sku: string
  brand: string
  name: string
  status: string
  condition: string
  locationLabel: string | null
  listingStatus: string | null
  listPrice: number | null
  photoUrl: string | null
}

function searchOrderBy(sort: ItemSearchFilter['sort']): Prisma.ItemInstanceOrderByWithRelationInput[] {
  switch (sort) {
    case 'newest': return [{ createdAt: 'desc' }, { id: 'desc' }]
    case 'oldest': return [{ createdAt: 'asc' }, { id: 'asc' }]
    case 'brand': return [{ catalog: { brand: 'asc' } }, { catalog: { name: 'asc' } }, { id: 'asc' }]
    case 'status': return [{ status: 'asc' }, { id: 'asc' }]
    case 'sku': default: return [{ sku: 'asc' }, { id: 'asc' }]
  }
}

function buildSearchWhere(filter: ItemSearchFilter): Prisma.ItemInstanceWhereInput {
  const where: Prisma.ItemInstanceWhereInput = {}
  if (filter.status) where.status = filter.status
  if (filter.condition) where.condition = filter.condition
  if (filter.cardedOrLoose) where.cardedOrLoose = filter.cardedOrLoose

  const q = filter.q.trim()
  if (q) {
    const or: Prisma.ItemInstanceWhereInput[] = [
      { sku: { contains: q, mode: 'insensitive' } },
      { catalog: { brand: { contains: q, mode: 'insensitive' } } },
      { catalog: { name: { contains: q, mode: 'insensitive' } } },
      { catalog: { series: { contains: q, mode: 'insensitive' } } },
      { location: { label: { contains: q, mode: 'insensitive' } } },
      { sellerPortfolio: { name: { contains: q, mode: 'insensitive' } } },
      { sellerPortfolio: { sellerProfile: { profile: { name: { contains: q, mode: 'insensitive' } } } } },
      { sellerPortfolio: { sellerProfile: { profile: { email: { contains: q, mode: 'insensitive' } } } } },
      // Exact-id lookups — practical for pasting an id straight from another page.
      { id: q },
      { sellerPortfolioId: q },
      { listing: { id: q } },
      { orderItems: { some: { orderId: q } } },
    ]
    const yearNum = parseInt(q, 10)
    if (!isNaN(yearNum)) or.push({ catalog: { year: { equals: yearNum } } })
    where.OR = or
  }
  return where
}

const SEARCH_PAGE_SIZE = 25

export async function searchItemsPage(
  filter: ItemSearchFilter,
  cursor: string | null,
  pageSize: number = SEARCH_PAGE_SIZE,
): Promise<{ items: ItemSearchRow[]; nextCursor: string | null }> {
  const where = buildSearchWhere(filter)
  const orderBy = searchOrderBy(filter.sort)

  const rows = await prisma.itemInstance.findMany({
    where,
    orderBy,
    take: pageSize + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true, sku: true, status: true, condition: true, listPrice: true,
      catalog: { select: { brand: true, name: true } },
      location: { select: { label: true } },
      listing: { select: { status: true } },
      photos: { where: { type: 'front' }, take: 1, select: { url: true } },
    },
  })

  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows

  return {
    items: page.map(r => ({
      id: r.id, sku: r.sku, brand: r.catalog.brand, name: r.catalog.name,
      status: r.status, condition: r.condition,
      locationLabel: r.location?.label ?? null,
      listingStatus: r.listing?.status ?? null,
      listPrice: r.listPrice,
      photoUrl: r.photos[0]?.url ?? null,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  }
}
