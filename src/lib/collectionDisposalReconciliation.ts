// 26B: reconciles private Collection ownership against the two on-platform
// ownership-transfer events — a completed, paid consignment sale (this file)
// and a buyout intake conversion (see intakeConversion.ts). Both create a
// 'platform_sale' CollectionDisposal, idempotent via a sourceKey unique
// constraint, so retried reconciliation never double-decrements ownership.
// A non-resolvable seller/CollectionItem lineage or company-owned/buyout-
// resold inventory is a legitimate no-op here, never an error — see 26A's
// own finding that this lineage chain is genuinely nullable by design.
//
// 26B Pre-Commit Invariant Check: collectionItemId is resolved via
// ItemInstance.intakeDraft.sellerSubmission.collectionItemId — the item-
// specific chain — NEVER via ItemInstance.sellerAgreement.submission. A
// SellerAgreement's own submissionId is only that agreement's PRIMARY/anchor
// submission (sellerAgreements.ts enforces at most one CURRENT agreement per
// PORTFOLIO, not per submission — see its "15B-review section 2" comment);
// one portfolio-linked agreement can legitimately cover items originating
// from several different submissions/models. IntakeDraft is the one row per
// physical unit (convertedItemId is @unique) that immutably records the
// EXACT submission that produced THIS ItemInstance — the strongest lineage
// actually available. Never falls back to profile+catalog guessing.
import { prisma } from '@/lib/prisma'
import { internalPriceToCents, externalPriceToCents } from '@/lib/marketMoney'
import { isItemEligibleForConsignmentPayout } from '@/lib/sellerPayoutCalculation'
import { createDisposal } from '@/lib/ownershipLedger'

export type ReconcileResult = { created: number; skipped: number }

// §45-47 of the 26B spec: one unit per eligible consignment OrderItem,
// keyed 'orderitem:<orderItemId>'. grossProceedsCents is the sale-time
// OrderItem.price; netProceedsCents is the SellerPayoutLine.netAmount when
// that line already exists (created by ensureConsignmentPayoutLinesForCompletedOrder,
// which must run before this) — never a seller-pricing estimate.
export async function reconcileCollectionDisposalsForCompletedOrder(orderId: string): Promise<ReconcileResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      paymentStatus: true,
      completedAt: true,
      orderItems: {
        select: {
          id: true,
          price: true,
          item: {
            select: {
              sourceType: true,
              sellerAgreement: { select: { type: true, status: true } },
              // Item-specific lineage — see the file-level comment above.
              intakeDraft: { select: { sellerSubmission: { select: { collectionItemId: true } } } },
            },
          },
          sellerPayoutLine: { select: { netAmount: true } },
        },
      },
    },
  })

  if (!order || order.status !== 'complete' || order.paymentStatus !== 'paid') {
    return { created: 0, skipped: 0 }
  }

  let created = 0
  let skipped = 0

  for (const orderItem of order.orderItems) {
    const agreement = orderItem.item.sellerAgreement
    const collectionItemId = orderItem.item.intakeDraft?.sellerSubmission?.collectionItemId ?? null

    const eligible =
      isItemEligibleForConsignmentPayout({
        sourceType: orderItem.item.sourceType,
        agreementType: agreement?.type ?? null,
        agreementStatus: agreement?.status ?? null,
      }) && collectionItemId !== null

    if (!eligible || !collectionItemId) {
      skipped++
      continue
    }

    const outcome = await prisma.$transaction((tx) =>
      createDisposal(tx, {
        collectionItemId,
        quantity: 1,
        disposalType: 'platform_sale',
        disposedAt: order.completedAt ?? new Date(),
        grossProceedsCents: internalPriceToCents(orderItem.price),
        netProceedsCents: orderItem.sellerPayoutLine ? externalPriceToCents(orderItem.sellerPayoutLine.netAmount) : null,
        sourceKey: `orderitem:${orderItem.id}`,
      }),
    )

    if (outcome.status === 'created') created++
    else skipped++
  }

  return { created, skipped }
}
