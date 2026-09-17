// 27B: Estimated Seller Proceeds (consignment) — resolves current terms with
// actual-agreement precedence (accepted > proposed > generic policy preview)
// and reuses calculateConsignmentPayoutSnapshot (15A canonical) verbatim — no
// duplicate fee formula. Buyout is handled by findActualBuyoutOffer below: a
// pure passthrough of the real agreement's lump-sum amount, NEVER computed
// from market valuation or divided across quantity (26A/26B).
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { calculateConsignmentPayoutSnapshot } from '@/lib/sellerPayoutCalculation'
import { previewCommissionForSubmission } from '@/lib/commissionPolicyQuery'
import { decimalToCents } from '@/lib/businessAnalyticsMath'

export type ProceedsTermsSource = 'accepted_agreement' | 'proposed_agreement' | 'policy_preview'

export type SellerProceedsEstimate = {
  perItemPriceCents: number
  quantity: number
  netProceedsPerItemCents: number
  // Total = perItem * quantity — valid ONLY because the canonical calculator's
  // terms (commission %, fixed fee) are genuinely per-sold-item under the
  // consignment model (26A/26B verified this; never assumed for buyout).
  netProceedsTotalCents: number
  termsSource: ProceedsTermsSource
}

type RelevantAgreement = {
  status: string
  commissionPercent: Prisma.Decimal | null
  commissionMinimumFee: Prisma.Decimal | null
  fixedFee: Prisma.Decimal | null
  minimumSellerPayout: Prisma.Decimal | null
}

// Actual agreement terms take precedence over generic policy preview —
// accepted (locked, contractual) over proposed (still live-editable by admin,
// but a real term set nonetheless) over nothing.
async function findRelevantConsignmentAgreement(submissionId: string): Promise<RelevantAgreement | null> {
  const agreements = await prisma.sellerAgreement.findMany({
    where: { submissionId, type: 'consignment', status: { in: ['accepted', 'proposed'] } },
    select: { status: true, commissionPercent: true, commissionMinimumFee: true, fixedFee: true, minimumSellerPayout: true },
  })
  return agreements.find((a) => a.status === 'accepted') ?? agreements.find((a) => a.status === 'proposed') ?? null
}

// Null when no terms could be resolved at all (no actual agreement AND no
// active commission policy) — never a fabricated $0 estimate.
export async function estimateSellerProceeds(params: {
  submissionId: string
  perItemPriceCents: number
  quantity: number
}): Promise<SellerProceedsEstimate | null> {
  const { submissionId, perItemPriceCents, quantity } = params
  const grossSalePriceFloat = perItemPriceCents / 100

  const agreement = await findRelevantConsignmentAgreement(submissionId)
  if (agreement) {
    const snapshot = calculateConsignmentPayoutSnapshot({
      grossSalePriceFloat,
      commissionPercent: agreement.commissionPercent,
      fixedFee: agreement.fixedFee,
      minimumSellerPayout: agreement.minimumSellerPayout,
      commissionMinimumFee: agreement.commissionMinimumFee,
    })
    const netProceedsPerItemCents = decimalToCents(snapshot.netAmount)
    return {
      perItemPriceCents,
      quantity,
      netProceedsPerItemCents,
      netProceedsTotalCents: netProceedsPerItemCents * quantity,
      termsSource: agreement.status === 'accepted' ? 'accepted_agreement' : 'proposed_agreement',
    }
  }

  // No actual agreement yet — fall back to the canonical, reusable live
  // policy/profile preview (never a duplicate policy/tier resolver).
  // `quantity` stands in for acceptedItemCount here: this is a pre-agreement
  // ESTIMATE only, never authoritative (only an admin-confirmed count locked
  // at finalization is that).
  const outcome = await previewCommissionForSubmission(submissionId, quantity)
  if (!outcome.ok) return null

  const r = outcome.resolution
  const snapshot = calculateConsignmentPayoutSnapshot({
    grossSalePriceFloat,
    commissionPercent: new Prisma.Decimal(r.commissionBps).dividedBy(10_000),
    fixedFee: null,
    minimumSellerPayout: null,
    commissionMinimumFee: new Prisma.Decimal(r.minimumFeeCents).dividedBy(100),
  })
  const netProceedsPerItemCents = decimalToCents(snapshot.netAmount)
  return {
    perItemPriceCents,
    quantity,
    netProceedsPerItemCents,
    netProceedsTotalCents: netProceedsPerItemCents * quantity,
    termsSource: 'policy_preview',
  }
}

// ── Actual buyout offer — display only, never computed ─────────────────────

export type ActualBuyoutOffer = {
  status: 'accepted' | 'proposed'
  // Null when the agreement exists but the amount hasn't been entered yet
  // (should not normally happen, but never fabricated if it does).
  agreedBuyoutAmountCents: number | null
  acceptedItemCount: number | null
}

// §41/§45/§46: an "Offer" is only ever the real agreement's own lump-sum
// amount, verbatim — never computed from EMV, never divided by quantity.
// Returns null when no actual buyout agreement exists yet (the caller shows
// "Buyout offers are provided after review", never an invented number).
export async function findActualBuyoutOffer(submissionId: string): Promise<ActualBuyoutOffer | null> {
  const agreements = await prisma.sellerAgreement.findMany({
    where: { submissionId, type: 'buyout', status: { in: ['accepted', 'proposed'] } },
    select: { status: true, agreedBuyoutAmount: true, acceptedItemCount: true },
  })
  const agreement = agreements.find((a) => a.status === 'accepted') ?? agreements.find((a) => a.status === 'proposed') ?? null
  if (!agreement) return null
  return {
    status: agreement.status as 'accepted' | 'proposed',
    agreedBuyoutAmountCents: agreement.agreedBuyoutAmount ? decimalToCents(agreement.agreedBuyoutAmount) : null,
    acceptedItemCount: agreement.acceptedItemCount,
  }
}
