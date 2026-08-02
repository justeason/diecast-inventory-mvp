// Server-only. No 'use server'. Pure detection logic — no side effects.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export type Severity = 'info' | 'warning' | 'critical'
export type Category =
  | 'seller'
  | 'agreement'
  | 'shipping'
  | 'intake'
  | 'inventory'
  | 'listing'
  | 'order'
  | 'payout'
  | 'lifecycle'

export type RepairType =
  | 'generate_buyout_payout_line'
  | 'generate_consignment_payout_line'
  | 'archive_active_listing'
  | 'recalculate_payout_total'
  | 'open_lifecycle_case'
  | 'hold_payout_line'

export type ReconciliationIssue = {
  key: string
  category: Category
  severity: Severity
  entityType: string
  entityId: string
  title: string
  description: string
  suggestedAction: string
  repairType: RepairType | null
  relatedIds: Record<string, string>
  sellerDisplayName?: string
}

export type DetectOptions = {
  category?: Category
  severity?: Severity
  entityId?: string
  sellerName?: string
  repairableOnly?: boolean
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

// ─── Keyset pagination helper ─────────────────────────────────────────────────

async function scanAll<T extends { id: string }>(
  fetch: (cursorId: string | undefined) => Promise<T[]>,
  batchSize = 100,
): Promise<T[]> {
  const results: T[] = []
  let cursorId: string | undefined
  for (;;) {
    const batch = await fetch(cursorId)
    results.push(...batch)
    if (batch.length < batchSize) break
    cursorId = batch[batch.length - 1].id
  }
  return results
}

// ─── Seller category ──────────────────────────────────────────────────────────

async function detectSellerIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  // seller_approved_no_intake: submission approved_for_intake with no active intake draft
  const approvedSubs = await scanAll((cursorId) =>
    prisma.sellerSubmission.findMany({
      where: { status: 'approved_for_intake' },
      select: {
        id: true,
        profile: { select: { sellerProfile: { select: { displayName: true } } } },
        intakeDrafts: {
          where: { status: { in: ['draft', 'reviewed', 'converted'] } },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const sub of approvedSubs) {
    if (sub.intakeDrafts.length === 0) {
      issues.push({
        key: `seller_approved_no_intake:${sub.id}`,
        category: 'seller',
        severity: 'warning',
        entityType: 'SellerSubmission',
        entityId: sub.id,
        title: 'Approved submission has no active intake draft',
        description: 'Submission is approved_for_intake but no intake draft exists in draft/reviewed/converted state.',
        suggestedAction: 'Create an intake draft for this submission.',
        repairType: null,
        relatedIds: { submissionId: sub.id },
        sellerDisplayName: sub.profile?.sellerProfile?.displayName ?? undefined,
      })
    }
  }

  // buyout_inventory_no_payout_line: buyout agreement with items but no payout line
  const buyoutAgreements = await scanAll((cursorId) =>
    prisma.sellerAgreement.findMany({
      where: {
        type: 'buyout',
        status: 'accepted',
        items: { some: {} },
        payoutLines: { none: {} },
      },
      select: {
        id: true,
        submissionId: true,
        sellerProfile: { select: { displayName: true } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const ag of buyoutAgreements) {
    issues.push({
      key: `buyout_inventory_no_payout_line:${ag.id}`,
      category: 'seller',
      severity: 'critical',
      entityType: 'SellerAgreement',
      entityId: ag.id,
      title: 'Buyout agreement missing payout line',
      description: 'Accepted buyout agreement has inventory items but no payout line has been created.',
      suggestedAction: 'Generate buyout payout line for this agreement.',
      repairType: 'generate_buyout_payout_line',
      relatedIds: { submissionId: ag.submissionId, agreementId: ag.id },
      sellerDisplayName: ag.sellerProfile?.displayName ?? undefined,
    })
  }

  // consignment_item_source_mismatch: item sourceType != agreement type
  const mismatchItems = await scanAll((cursorId) =>
    prisma.itemInstance.findMany({
      where: {
        sellerAgreementId: { not: null },
        sellerAgreement: { isNot: null },
      },
      select: {
        id: true,
        sourceType: true,
        sellerAgreementId: true,
        sellerAgreement: {
          select: {
            id: true,
            type: true,
            submissionId: true,
            sellerProfile: { select: { displayName: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const item of mismatchItems) {
    const ag = item.sellerAgreement
    if (!ag) continue
    if (item.sourceType !== ag.type) {
      issues.push({
        key: `consignment_item_source_mismatch:${item.id}`,
        category: 'seller',
        severity: 'warning',
        entityType: 'ItemInstance',
        entityId: item.id,
        title: 'Item source type mismatch with agreement type',
        description: `Item sourceType=${item.sourceType} but agreement type=${ag.type}.`,
        suggestedAction: 'Correct item sourceType or verify agreement assignment.',
        repairType: null,
        relatedIds: { agreementId: ag.id, submissionId: ag.submissionId },
        sellerDisplayName: ag.sellerProfile?.displayName ?? undefined,
      })
    }
  }

  return issues
}

// ─── Shipping category ────────────────────────────────────────────────────────

async function detectShippingIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  const shipments = await scanAll((cursorId) =>
    prisma.sellerInboundShipment.findMany({
      where: { status: { in: ['received', 'issue'] } },
      select: {
        id: true,
        status: true,
        intakeDraftId: true,
        receivedQuantity: true,
        sellerSubmissionId: true,
        sellerSubmission: {
          select: {
            profile: { select: { sellerProfile: { select: { displayName: true } } } },
            lifecycleCases: {
              where: { caseType: { in: ['lost_or_damaged', 'other'] }, status: { in: ['open', 'action_required'] } },
              select: { id: true },
              take: 1,
            },
          },
        },
        intakeDraft: { select: { id: true, receivedQuantity: true } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )

  for (const s of shipments) {
    // shipment_received_no_intake
    if (s.intakeDraftId === null) {
      issues.push({
        key: `shipment_received_no_intake:${s.id}`,
        category: 'shipping',
        severity: 'warning',
        entityType: 'SellerInboundShipment',
        entityId: s.id,
        title: 'Received shipment has no intake draft',
        description: `Shipment status=${s.status} but no intake draft is linked.`,
        suggestedAction: 'Create or link an intake draft for this shipment.',
        repairType: null,
        relatedIds: { submissionId: s.sellerSubmissionId },
        sellerDisplayName: s.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
      })
    }

    // issue_shipment_no_case
    if (s.status === 'issue') {
      const hasCase = (s.sellerSubmission?.lifecycleCases?.length ?? 0) > 0
      if (!hasCase) {
        issues.push({
          key: `issue_shipment_no_case:${s.id}`,
          category: 'shipping',
          severity: 'critical',
          entityType: 'SellerInboundShipment',
          entityId: s.id,
          title: 'Issue shipment has no open lifecycle case',
          description: 'Shipment is in issue status but no open lost_or_damaged or other lifecycle case exists.',
          suggestedAction: 'Open a lifecycle case for this shipment issue.',
          repairType: 'open_lifecycle_case',
          relatedIds: { submissionId: s.sellerSubmissionId },
          sellerDisplayName: s.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
        })
      }
    }

    // shipment_intake_qty_mismatch
    if (s.intakeDraftId !== null && s.intakeDraft) {
      const shipQty = s.receivedQuantity
      const intakeQty = s.intakeDraft.receivedQuantity
      if (shipQty !== null && intakeQty !== null && shipQty !== intakeQty) {
        issues.push({
          key: `shipment_intake_qty_mismatch:${s.id}`,
          category: 'shipping',
          severity: 'warning',
          entityType: 'SellerInboundShipment',
          entityId: s.id,
          title: 'Shipment and intake quantity mismatch',
          description: `Shipment receivedQuantity=${shipQty} but intake draft receivedQuantity=${intakeQty}.`,
          suggestedAction: 'Reconcile quantity between shipment and intake draft.',
          repairType: null,
          relatedIds: { submissionId: s.sellerSubmissionId, intakeDraftId: s.intakeDraftId },
          sellerDisplayName: s.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
        })
      }
    }
  }

  return issues
}

// ─── Intake category ──────────────────────────────────────────────────────────

async function detectIntakeIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  // intake_converted_no_item: converted but convertedItemId is null
  const convertedNoItem = await scanAll((cursorId) =>
    prisma.intakeDraft.findMany({
      where: { status: 'converted', convertedItemId: null },
      select: {
        id: true,
        sellerSubmissionId: true,
        sellerSubmission: { select: { profile: { select: { sellerProfile: { select: { displayName: true } } } } } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const d of convertedNoItem) {
    issues.push({
      key: `intake_converted_no_item:${d.id}`,
      category: 'intake',
      severity: 'critical',
      entityType: 'IntakeDraft',
      entityId: d.id,
      title: 'Converted intake draft missing item link (data corruption)',
      description: 'IntakeDraft status=converted but convertedItemId is null.',
      suggestedAction: 'Manually investigate and link or recreate the inventory item.',
      repairType: null,
      relatedIds: d.sellerSubmissionId ? { submissionId: d.sellerSubmissionId } : {},
      sellerDisplayName: d.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
    })
  }

  // intake_rejected_with_item: rejected but convertedItemId is NOT null
  const rejectedWithItem = await scanAll((cursorId) =>
    prisma.intakeDraft.findMany({
      where: { status: 'rejected', convertedItemId: { not: null } },
      select: {
        id: true,
        convertedItemId: true,
        sellerSubmissionId: true,
        sellerSubmission: { select: { profile: { select: { sellerProfile: { select: { displayName: true } } } } } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const d of rejectedWithItem) {
    issues.push({
      key: `intake_rejected_with_item:${d.id}`,
      category: 'intake',
      severity: 'warning',
      entityType: 'IntakeDraft',
      entityId: d.id,
      title: 'Rejected intake draft still has item link',
      description: 'IntakeDraft status=rejected but convertedItemId is set.',
      suggestedAction: 'Verify whether the linked item should be disassociated or deleted.',
      repairType: null,
      relatedIds: {
        ...(d.sellerSubmissionId ? { submissionId: d.sellerSubmissionId } : {}),
        ...(d.convertedItemId ? { itemId: d.convertedItemId } : {}),
      },
      sellerDisplayName: d.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
    })
  }

  return issues
}

// ─── Inventory category ───────────────────────────────────────────────────────

async function detectInventoryIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  // item_available_no_storage
  const noStorage = await scanAll((cursorId) =>
    prisma.itemInstance.findMany({
      where: { status: { in: ['available', 'reserved'] }, locationId: null },
      select: { id: true, status: true, sku: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const item of noStorage) {
    issues.push({
      key: `item_available_no_storage:${item.id}`,
      category: 'inventory',
      severity: 'warning',
      entityType: 'ItemInstance',
      entityId: item.id,
      title: 'Available/reserved item has no storage location',
      description: `Item status=${item.status} but locationId is null.`,
      suggestedAction: 'Assign a storage location to this item.',
      repairType: null,
      relatedIds: {},
    })
  }

  // item_sold_active_listing
  const soldActiveListings = await scanAll((cursorId) =>
    prisma.itemInstance.findMany({
      where: { status: 'sold', listing: { status: 'active' } },
      select: { id: true, listing: { select: { id: true } } },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const item of soldActiveListings) {
    if (!item.listing) continue
    issues.push({
      key: `item_sold_active_listing:${item.id}`,
      category: 'inventory',
      severity: 'critical',
      entityType: 'ItemInstance',
      entityId: item.id,
      title: 'Sold item has active listing',
      description: 'Item status=sold but its listing is still active.',
      suggestedAction: 'Archive the listing for this sold item.',
      repairType: 'archive_active_listing',
      relatedIds: { listingId: item.listing.id },
    })
  }

  // item_returned_active_listing
  const returnedActiveListings = await scanAll((cursorId) =>
    prisma.itemInstance.findMany({
      where: { status: { in: ['returned', 'not_for_sale'] }, listing: { status: 'active' } },
      select: { id: true, status: true, listing: { select: { id: true } } },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const item of returnedActiveListings) {
    if (!item.listing) continue
    issues.push({
      key: `item_returned_active_listing:${item.id}`,
      category: 'inventory',
      severity: 'critical',
      entityType: 'ItemInstance',
      entityId: item.id,
      title: 'Returned/not-for-sale item has active listing',
      description: `Item status=${item.status} but its listing is still active.`,
      suggestedAction: 'Archive the listing for this item.',
      repairType: 'archive_active_listing',
      relatedIds: { listingId: item.listing.id },
    })
  }

  // returned_item_unresolved_case: item status=returned with unresolved return lifecycle case
  const returnedItems = await scanAll((cursorId) =>
    prisma.itemInstance.findMany({
      where: {
        status: 'returned',
        sellerAgreement: {
          submission: {
            lifecycleCases: {
              some: {
                caseType: { in: ['buyer_return', 'return_to_seller'] },
                status: { notIn: ['resolved', 'closed'] },
              },
            },
          },
        },
      },
      select: {
        id: true,
        sellerAgreement: {
          select: {
            submission: {
              select: {
                id: true,
                profile: { select: { sellerProfile: { select: { displayName: true } } } },
                lifecycleCases: {
                  where: {
                    caseType: { in: ['buyer_return', 'return_to_seller'] },
                    status: { notIn: ['resolved', 'closed'] },
                  },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const item of returnedItems) {
    const sub = item.sellerAgreement?.submission
    if (!sub) continue
    issues.push({
      key: `returned_item_unresolved_case:${item.id}`,
      category: 'lifecycle',
      severity: 'warning',
      entityType: 'ItemInstance',
      entityId: item.id,
      title: 'Returned item has unresolved return case',
      description: 'Item status=returned but the seller return lifecycle case is not resolved.',
      suggestedAction: 'Resolve the return lifecycle case for this item.',
      repairType: null,
      relatedIds: {
        submissionId: sub.id,
        ...(sub.lifecycleCases[0] ? { caseId: sub.lifecycleCases[0].id } : {}),
      },
      sellerDisplayName: sub.profile?.sellerProfile?.displayName ?? undefined,
    })
  }

  return issues
}

// ─── Listing category ─────────────────────────────────────────────────────────

async function detectListingIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  // listing_active_unavailable_item
  const activeListings = await scanAll((cursorId) =>
    prisma.listing.findMany({
      where: {
        status: 'active',
        item: { status: { notIn: ['available', 'reserved'] } },
      },
      select: {
        id: true,
        item: { select: { id: true, status: true } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const listing of activeListings) {
    issues.push({
      key: `listing_active_unavailable_item:${listing.id}`,
      category: 'listing',
      severity: 'critical',
      entityType: 'Listing',
      entityId: listing.id,
      title: 'Active listing has unavailable item',
      description: `Listing is active but item status=${listing.item.status} (not available/reserved).`,
      suggestedAction: 'Archive this listing.',
      repairType: 'archive_active_listing',
      relatedIds: { itemId: listing.item.id, listingId: listing.id },
    })
  }

  // listing_sold_no_order_item
  const soldNoOrder = await scanAll((cursorId) =>
    prisma.listing.findMany({
      where: { status: 'sold', orderItems: { none: {} } },
      select: { id: true, item: { select: { id: true } } },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const listing of soldNoOrder) {
    issues.push({
      key: `listing_sold_no_order_item:${listing.id}`,
      category: 'listing',
      severity: 'warning',
      entityType: 'Listing',
      entityId: listing.id,
      title: 'Sold listing has no order items',
      description: 'Listing status=sold but no OrderItem references this listing.',
      suggestedAction: 'Investigate how this listing was marked sold without an order.',
      repairType: null,
      relatedIds: { itemId: listing.item.id },
    })
  }

  return issues
}

// ─── Order category ───────────────────────────────────────────────────────────

async function detectOrderIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  // consignment_order_no_payout
  const missingPayoutItems = await scanAll((cursorId) =>
    prisma.orderItem.findMany({
      where: {
        order: { status: 'complete' },
        sellerPayoutLine: null,
        item: {
          sourceType: 'consignment',
          sellerAgreement: { type: 'consignment', status: 'accepted' },
        },
      },
      select: {
        id: true,
        orderId: true,
        item: {
          select: {
            id: true,
            sellerAgreement: { select: { id: true, submissionId: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const oi of missingPayoutItems) {
    const ag = oi.item.sellerAgreement
    issues.push({
      key: `consignment_order_no_payout:${oi.id}`,
      category: 'order',
      severity: 'critical',
      entityType: 'OrderItem',
      entityId: oi.id,
      title: 'Completed consignment order item missing payout line',
      description: 'Order is complete, item is consignment with accepted agreement, but no payout line exists.',
      suggestedAction: 'Generate missing consignment payout line.',
      repairType: 'generate_consignment_payout_line',
      relatedIds: {
        orderId: oi.orderId,
        ...(ag ? { agreementId: ag.id, submissionId: ag.submissionId } : {}),
        itemId: oi.item.id,
      },
    })
  }

  // reserved_item_no_order
  const reservedItems = await scanAll((cursorId) =>
    prisma.itemInstance.findMany({
      where: { status: 'reserved' },
      select: {
        id: true,
        listing: {
          select: {
            orderItems: {
              where: { order: { status: { notIn: ['cancelled'] } } },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const item of reservedItems) {
    const hasActiveOrderItem = (item.listing?.orderItems?.length ?? 0) > 0
    if (!hasActiveOrderItem) {
      issues.push({
        key: `reserved_item_no_order:${item.id}`,
        category: 'order',
        severity: 'warning',
        entityType: 'ItemInstance',
        entityId: item.id,
        title: 'Reserved item has no active order',
        description: 'Item status=reserved but no active order item exists.',
        suggestedAction: 'Investigate item reservation — may need status correction.',
        repairType: null,
        relatedIds: {},
      })
    }
  }

  return issues
}

// ─── Payout category ──────────────────────────────────────────────────────────

async function detectPayoutIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []
  const ZERO = new Prisma.Decimal(0)

  // payout_total_mismatch
  const payouts = await scanAll((cursorId) =>
    prisma.sellerPayout.findMany({
      where: { status: { in: ['draft', 'approved', 'paid'] } },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        lines: { select: { netAmount: true } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const p of payouts) {
    const computed = p.lines
      .reduce((acc, l) => acc.plus(l.netAmount), ZERO)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    if (!computed.equals(p.totalAmount)) {
      issues.push({
        key: `payout_total_mismatch:${p.id}`,
        category: 'payout',
        severity: 'critical',
        entityType: 'SellerPayout',
        entityId: p.id,
        title: 'Payout total does not match sum of lines',
        description: `Stored totalAmount=${p.totalAmount}, computed sum=${computed}.`,
        suggestedAction: p.status === 'draft' ? 'Recalculate payout total.' : 'Manually review — payout is already approved/paid.',
        repairType: p.status === 'draft' ? 'recalculate_payout_total' : null,
        relatedIds: { payoutId: p.id },
      })
    }
  }

  // payout_paid_missing_fields
  const paidMissingFields = await scanAll((cursorId) =>
    prisma.sellerPayout.findMany({
      where: {
        status: 'paid',
        OR: [{ paidAt: null }, { paymentMethod: null }, { paymentReference: null }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const p of paidMissingFields) {
    issues.push({
      key: `payout_paid_missing_fields:${p.id}`,
      category: 'payout',
      severity: 'warning',
      entityType: 'SellerPayout',
      entityId: p.id,
      title: 'Paid payout missing required fields',
      description: 'Payout status=paid but paidAt, paymentMethod, or paymentReference is null.',
      suggestedAction: 'Update payout with complete payment information.',
      repairType: null,
      relatedIds: { payoutId: p.id },
    })
  }

  // payout_approved_missing_approvedAt
  const approvedMissingAt = await scanAll((cursorId) =>
    prisma.sellerPayout.findMany({
      where: { status: { in: ['approved', 'paid'] }, approvedAt: null },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const p of approvedMissingAt) {
    issues.push({
      key: `payout_approved_missing_approvedAt:${p.id}`,
      category: 'payout',
      severity: 'warning',
      entityType: 'SellerPayout',
      entityId: p.id,
      title: 'Approved/paid payout missing approvedAt timestamp',
      description: `Payout status=${p.status} but approvedAt is null.`,
      suggestedAction: 'Manually set approvedAt timestamp for this payout.',
      repairType: null,
      relatedIds: { payoutId: p.id },
    })
  }

  // payout_line_held_case_resolved
  const heldLines = await scanAll((cursorId) =>
    prisma.sellerPayoutLine.findMany({
      where: { status: 'held' },
      select: {
        id: true,
        agreementId: true,
        agreement: {
          select: {
            submission: {
              select: {
                id: true,
                lifecycleCases: {
                  where: { status: { in: ['open', 'action_required'] } },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const line of heldLines) {
    const openCases = line.agreement?.submission?.lifecycleCases ?? []
    if (openCases.length === 0) {
      issues.push({
        key: `payout_line_held_case_resolved:${line.id}`,
        category: 'payout',
        severity: 'info',
        entityType: 'SellerPayoutLine',
        entityId: line.id,
        title: 'Held payout line — all lifecycle cases resolved',
        description: 'Payout line is on hold but no open lifecycle cases remain for the seller submission.',
        suggestedAction: 'Consider releasing the hold if the underlying issue is resolved.',
        repairType: null,
        relatedIds: line.agreementId ? { agreementId: line.agreementId } : {},
      })
    }
  }

  // open_dispute_eligible_line: eligible unbatched payout line at risk due to open dispute/return case
  const disputeCases = await scanAll((cursorId) =>
    prisma.sellerLifecycleCase.findMany({
      where: {
        status: { in: ['open', 'action_required'] },
        caseType: { in: ['buyer_return', 'return_to_seller', 'lost_or_damaged', 'other'] },
      },
      select: {
        id: true,
        caseType: true,
        sellerSubmissionId: true,
        sellerSubmission: {
          select: {
            profileId: true,
            profile: { select: { sellerProfile: { select: { displayName: true } } } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )

  for (const c of disputeCases) {
    const profileId = c.sellerSubmission?.profileId
    if (!profileId) continue

    const eligibleLines = await scanAll((cursorId) =>
      prisma.sellerPayoutLine.findMany({
        where: { customerProfileId: profileId, status: 'eligible', payoutId: null },
        select: { id: true, lineType: true, netAmount: true },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      }),
    )

    for (const line of eligibleLines) {
      issues.push({
        key: `open_dispute_eligible_line:${line.id}`,
        category: 'payout',
        severity: 'critical',
        entityType: 'SellerPayoutLine',
        entityId: line.id,
        title: 'Eligible payout line at risk — open dispute/return case exists',
        description: `Open lifecycle case (${c.caseType}) exists for this seller. Payout line is eligible and unbatched.`,
        suggestedAction: 'Place this payout line on hold until the case is resolved.',
        repairType: 'hold_payout_line',
        relatedIds: { submissionId: c.sellerSubmissionId, caseId: c.id },
        sellerDisplayName: c.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
      })
    }
  }

  // payout_line_noncomplete_order: consignment payout line linked to a non-complete order
  const ncOrderLines = await scanAll((cursorId) =>
    prisma.sellerPayoutLine.findMany({
      where: {
        lineType: 'consignment',
        orderItemId: { not: null },
        orderItem: { order: { status: { not: 'complete' } } },
      },
      select: {
        id: true,
        orderItemId: true,
        orderItem: { select: { orderId: true, order: { select: { status: true } } } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const line of ncOrderLines) {
    issues.push({
      key: `payout_line_noncomplete_order:${line.id}`,
      category: 'payout',
      severity: 'warning',
      entityType: 'SellerPayoutLine',
      entityId: line.id,
      title: 'Consignment payout line linked to non-complete order',
      description: `Payout line exists but order status=${line.orderItem?.order?.status}.`,
      suggestedAction: 'Verify order status. Payout line may have been created prematurely.',
      repairType: null,
      relatedIds: {
        ...(line.orderItem?.orderId ? { orderId: line.orderItem.orderId } : {}),
      },
    })
  }

  // held_line_in_payout: held payout line that is attached to a payout batch
  const heldInPayout = await scanAll((cursorId) =>
    prisma.sellerPayoutLine.findMany({
      where: { status: 'held', payoutId: { not: null } },
      select: { id: true, payoutId: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const line of heldInPayout) {
    issues.push({
      key: `held_line_in_payout:${line.id}`,
      category: 'payout',
      severity: 'warning',
      entityType: 'SellerPayoutLine',
      entityId: line.id,
      title: 'Held payout line is attached to a payout batch',
      description: 'Payout line status=held but payoutId is set — held lines should not be in a batch.',
      suggestedAction: 'Remove the line from the payout batch or investigate inconsistency.',
      repairType: null,
      relatedIds: { payoutId: line.payoutId! },
    })
  }

  // approved_payout_critical_case / paid_payout_critical_case
  // SellerPayout → customerProfile → sellerSubmissions → lifecycleCases
  const riskPayouts = await scanAll((cursorId) =>
    prisma.sellerPayout.findMany({
      where: {
        status: { in: ['approved', 'paid'] },
        customerProfile: {
          sellerSubmissions: {
            some: {
              lifecycleCases: {
                some: { status: { in: ['open', 'action_required'] } },
              },
            },
          },
        },
      },
      select: {
        id: true,
        status: true,
        sellerProfile: { select: { displayName: true } },
        customerProfile: {
          select: {
            sellerSubmissions: {
              select: {
                id: true,
                lifecycleCases: {
                  where: { status: { in: ['open', 'action_required'] } },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )

  for (const p of riskPayouts) {
    const hasOpenCase = p.customerProfile?.sellerSubmissions.some(s => s.lifecycleCases.length > 0) ?? false
    if (!hasOpenCase) continue
    const key = p.status === 'paid' ? 'paid_payout_critical_case' : 'approved_payout_critical_case'
    issues.push({
      key: `${key}:${p.id}`,
      category: 'payout',
      severity: 'critical',
      entityType: 'SellerPayout',
      entityId: p.id,
      title: `${p.status === 'paid' ? 'Paid' : 'Approved'} payout — seller has open lifecycle case`,
      description: `Payout status=${p.status} but seller has unresolved lifecycle cases.`,
      suggestedAction: 'Resolve all open lifecycle cases before releasing payout.',
      repairType: null,
      relatedIds: { payoutId: p.id },
      sellerDisplayName: p.sellerProfile?.displayName ?? undefined,
    })
  }

  return issues
}

// ─── Lifecycle category ───────────────────────────────────────────────────────

async function detectLifecycleIssues(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  // case_return_resolved_no_returnedAt
  const returnCases = await scanAll((cursorId) =>
    prisma.sellerLifecycleCase.findMany({
      where: {
        caseType: { in: ['buyer_return', 'return_to_seller'] },
        status: 'resolved',
        returnedAt: null,
      },
      select: {
        id: true,
        caseType: true,
        sellerSubmissionId: true,
        sellerSubmission: { select: { profile: { select: { sellerProfile: { select: { displayName: true } } } } } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  for (const c of returnCases) {
    issues.push({
      key: `case_return_resolved_no_returnedAt:${c.id}`,
      category: 'lifecycle',
      severity: 'warning',
      entityType: 'SellerLifecycleCase',
      entityId: c.id,
      title: 'Return case resolved without returnedAt timestamp',
      description: `Case type=${c.caseType}, status=resolved, but returnedAt is null.`,
      suggestedAction: 'Set returnedAt on this lifecycle case.',
      repairType: null,
      relatedIds: { submissionId: c.sellerSubmissionId },
      sellerDisplayName: c.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
    })
  }

  // missing_shipment_received_event: received/issue shipment with no shipment-received:{id} event
  const receivedShipments = await scanAll((cursorId) =>
    prisma.sellerInboundShipment.findMany({
      where: { status: { in: ['received', 'issue'] } },
      select: {
        id: true,
        sellerSubmissionId: true,
        sellerSubmission: { select: { profile: { select: { sellerProfile: { select: { displayName: true } } } } } },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  if (receivedShipments.length > 0) {
    const shipmentEventKeys = receivedShipments.map((s) => `shipment-received:${s.id}`)
    const existingShipmentEvents = await prisma.sellerLifecycleEvent.findMany({
      where: { eventKey: { in: shipmentEventKeys } },
      select: { eventKey: true },
    })
    const existingShipmentEventSet = new Set(existingShipmentEvents.map((e) => e.eventKey))
    for (const s of receivedShipments) {
      if (!existingShipmentEventSet.has(`shipment-received:${s.id}`)) {
        issues.push({
          key: `missing_shipment_received_event:${s.id}`,
          category: 'lifecycle',
          severity: 'warning',
          entityType: 'SellerInboundShipment',
          entityId: s.id,
          title: 'Received shipment missing lifecycle event',
          description: `Shipment is received/issue but no 'shipment-received:${s.id}' lifecycle event exists.`,
          suggestedAction: 'Manually create or backfill the shipment-received lifecycle event.',
          repairType: null,
          relatedIds: { submissionId: s.sellerSubmissionId },
          sellerDisplayName: s.sellerSubmission?.profile?.sellerProfile?.displayName ?? undefined,
        })
      }
    }
  }

  // missing_payout_paid_event: paid payout with no payout-paid:{payoutId}:{submissionId} event
  const paidPayouts = await scanAll((cursorId) =>
    prisma.sellerPayout.findMany({
      where: { status: 'paid' },
      select: {
        id: true,
        lines: {
          select: { agreement: { select: { submissionId: true } } },
          distinct: ['agreementId'],
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  if (paidPayouts.length > 0) {
    const payoutEventPairs: Array<{ payoutId: string; submissionId: string }> = []
    for (const p of paidPayouts) {
      const sids = [...new Set(p.lines.map((l) => l.agreement?.submissionId).filter((s): s is string => !!s))]
      for (const sid of sids) payoutEventPairs.push({ payoutId: p.id, submissionId: sid })
    }
    if (payoutEventPairs.length > 0) {
      const payoutEventKeys = payoutEventPairs.map((p) => `payout-paid:${p.payoutId}:${p.submissionId}`)
      const existingPayoutEvents = await prisma.sellerLifecycleEvent.findMany({
        where: { eventKey: { in: payoutEventKeys } },
        select: { eventKey: true },
      })
      const existingPayoutEventSet = new Set(existingPayoutEvents.map((e) => e.eventKey))
      for (const { payoutId, submissionId } of payoutEventPairs) {
        if (!existingPayoutEventSet.has(`payout-paid:${payoutId}:${submissionId}`)) {
          issues.push({
            key: `missing_payout_paid_event:${payoutId}:${submissionId}`,
            category: 'lifecycle',
            severity: 'warning',
            entityType: 'SellerPayout',
            entityId: payoutId,
            title: 'Paid payout missing lifecycle event',
            description: `No 'payout-paid:${payoutId}:${submissionId}' event exists for this paid payout.`,
            suggestedAction: 'Manually backfill the payout-paid lifecycle event for this seller.',
            repairType: null,
            relatedIds: { payoutId, submissionId },
          })
        }
      }
    }
  }

  // missing_order_completed_event: complete order with consignment items missing order-completed:{orderId}:{submissionId} event
  const completedConsignmentOrders = await scanAll((cursorId) =>
    prisma.order.findMany({
      where: { status: 'complete', orderItems: { some: { item: { sourceType: 'consignment', sellerAgreementId: { not: null } } } } },
      select: {
        id: true,
        orderItems: {
          where: { item: { sourceType: 'consignment', sellerAgreementId: { not: null } } },
          select: { item: { select: { sellerAgreement: { select: { submissionId: true } } } } },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    }),
  )
  if (completedConsignmentOrders.length > 0) {
    const orderEventPairs: Array<{ orderId: string; submissionId: string }> = []
    for (const o of completedConsignmentOrders) {
      const sids = [
        ...new Set(
          o.orderItems.map((oi) => oi.item.sellerAgreement?.submissionId).filter((s): s is string => !!s),
        ),
      ]
      for (const sid of sids) orderEventPairs.push({ orderId: o.id, submissionId: sid })
    }
    if (orderEventPairs.length > 0) {
      const orderEventKeys = orderEventPairs.map((p) => `order-completed:${p.orderId}:${p.submissionId}`)
      const existingOrderEvents = await prisma.sellerLifecycleEvent.findMany({
        where: { eventKey: { in: orderEventKeys } },
        select: { eventKey: true },
      })
      const existingOrderEventSet = new Set(existingOrderEvents.map((e) => e.eventKey))
      for (const { orderId, submissionId } of orderEventPairs) {
        if (!existingOrderEventSet.has(`order-completed:${orderId}:${submissionId}`)) {
          issues.push({
            key: `missing_order_completed_event:${orderId}:${submissionId}`,
            category: 'lifecycle',
            severity: 'warning',
            entityType: 'Order',
            entityId: orderId,
            title: 'Completed order missing lifecycle event',
            description: `No 'order-completed:${orderId}:${submissionId}' event exists for this completed consignment order.`,
            suggestedAction: 'Manually backfill the order-completed lifecycle event for this seller.',
            repairType: null,
            relatedIds: { orderId, submissionId },
          })
        }
      }
    }
  }

  return issues
}

// ─── Main detection function ──────────────────────────────────────────────────

export async function detectReconciliationIssues(
  opts?: DetectOptions,
): Promise<ReconciliationIssue[]> {
  // Run all category detections in parallel
  const [
    sellerIssues,
    shippingIssues,
    intakeIssues,
    inventoryIssues,
    listingIssues,
    orderIssues,
    payoutIssues,
    lifecycleIssues,
  ] = await Promise.all([
    detectSellerIssues(),
    detectShippingIssues(),
    detectIntakeIssues(),
    detectInventoryIssues(),
    detectListingIssues(),
    detectOrderIssues(),
    detectPayoutIssues(),
    detectLifecycleIssues(),
  ])

  // Merge and deduplicate by key
  const all = [
    ...sellerIssues,
    ...shippingIssues,
    ...intakeIssues,
    ...inventoryIssues,
    ...listingIssues,
    ...orderIssues,
    ...payoutIssues,
    ...lifecycleIssues,
  ]
  const seen = new Set<string>()
  const deduped = all.filter((issue) => {
    if (seen.has(issue.key)) return false
    seen.add(issue.key)
    return true
  })

  // Apply filters
  let filtered = deduped
  if (opts?.category) {
    filtered = filtered.filter((i) => i.category === opts.category)
  }
  if (opts?.severity) {
    filtered = filtered.filter((i) => i.severity === opts.severity)
  }
  if (opts?.entityId) {
    filtered = filtered.filter(
      (i) =>
        i.entityId === opts.entityId ||
        Object.values(i.relatedIds).includes(opts.entityId!),
    )
  }
  if (opts?.sellerName) {
    const q = opts.sellerName.toLowerCase()
    filtered = filtered.filter((i) =>
      i.sellerDisplayName?.toLowerCase().includes(q),
    )
  }
  if (opts?.repairableOnly) {
    filtered = filtered.filter((i) => i.repairType !== null)
  }

  // Sort: critical → warning → info
  filtered.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  return filtered
}
