'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { createAvailableFanoutJob, createPriceChangeFanoutJob } from '@/lib/buyerAlertsTrigger'
import { processFanoutJobs } from '@/lib/buyerAlertsFanoutProcessor'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import { checkRiskGate, consumeApprovedRiskGate, markApprovalConsumed } from '@/lib/actions/riskApprovals'
import type { ListingActivationContext, ListingPriceChangeContext } from '@/lib/riskPolicy'

// Best-effort immediate processing after a fan-out job is durably committed. Never
// lets a processing failure affect the admin action — the cron and admin "process
// next batch" button are the durability backstop, not this call.
async function processFanoutBestEffort(): Promise<void> {
  try {
    await processFanoutJobs()
  } catch {
    // swallowed intentionally — the durable BuyerAlertFanout row already exists
  }
}

const isValidPositivePrice = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0
}

// 15F-review section 2/3: the ONE place that builds a listing_activation risk
// context — shared by createListing AND updateListing's reactivation branch (an
// archived/sold listing being flipped back to active is the same commercial-
// activation risk as a brand-new listing; both must go through the same check,
// never a second copy of the value-hierarchy logic).
async function buildListingActivationContext(
  itemId: string,
  catalogId: string,
  proposedPriceCents: number,
  sellerAgreement: { type: string; agreedBuyoutAmount: unknown; acceptedItemCount: number | null } | null,
): Promise<ListingActivationContext> {
  const intel = await getPricingIntelligence(catalogId)
  return {
    itemId,
    catalogModelId: catalogId,
    proposedPriceCents,
    completedSaleAmountCents: null,
    currentListingPriceCents: null,
    estimatedValueCents: intel?.estimatedValueCents ?? null,
    agreementBuyoutTotalCents:
      sellerAgreement?.type === 'buyout' && sellerAgreement.acceptedItemCount === 1 && sellerAgreement.agreedBuyoutAmount
        ? Math.round(parseFloat((sellerAgreement.agreedBuyoutAmount as { toString(): string }).toString()) * 100)
        : null,
  }
}

const CreateListingSchema = z.object({
  itemId: z.string().min(1, 'Item is required'),
  title: z.string().min(1, 'Title is required'),
  price: z.string().min(1, 'Price is required')
    .refine(isValidPositivePrice, 'Price must be a valid number greater than 0'),
  description: z.string().optional(),
})

const UpdateListingSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  price: z.string().min(1, 'Price is required')
    .refine(isValidPositivePrice, 'Price must be a valid number greater than 0'),
  description: z.string().optional(),
  status: z.enum(['active', 'sold', 'archived'], { error: 'Status is required' }),
})

// 15F: approvalRequestId is set only when a risk gate routed this action to the
// approval queue instead of performing the mutation.
export type ListingActionState = { errors: Record<string, string[]>; approvalRequestId?: string } | null

export async function createListing(
  _prev: ListingActionState,
  formData: FormData
): Promise<ListingActionState> {
  const result = CreateListingSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { itemId, title, price, description } = result.data

  const item = await prisma.itemInstance.findUnique({
    where: { id: itemId },
    include: {
      listing: { select: { id: true } },
      sellerAgreement: { select: { type: true, agreedBuyoutAmount: true, acceptedItemCount: true } },
    },
  })

  if (!item) return { errors: { itemId: ['Item not found.'] } }
  if (item.status !== 'available') return { errors: { itemId: ['Item is not available for listing.'] } }
  if (item.listing) return { errors: { itemId: ['Item already has a listing.'] } }

  // 15F: activation is gated by item value, not by price-vs-guidance (that check is
  // listing_price_change's job) — a normal-value listing activates automatically.
  const riskContext = await buildListingActivationContext(itemId, item.catalogId, Math.round(Number(price) * 100), item.sellerAgreement)
  const gate = await checkRiskGate({ action: 'listing_activation', context: riskContext, targetType: 'item_instance', targetId: itemId, requestedBy: 'admin' })
  if (gate.decision === 'deny') return { errors: { _form: [gate.reasons.join(' ')] } }
  if (gate.decision === 'pending') {
    return { errors: { _form: ['Listing activation requires approval for this item value.'] }, approvalRequestId: gate.approvalRequestId }
  }

  // The listing mutation and the durable fan-out job commit atomically — a crash
  // right after this transaction can never lose the intent to notify wanted buyers.
  let txError: ListingActionState = null
  await prisma.$transaction(async (tx) => {
    if (gate.decision === 'consume_approved') {
      const consumed = await consumeApprovedRiskGate(tx, { approvalRequestId: gate.approvalRequestId, action: 'listing_activation', targetId: itemId, context: riskContext })
      if (!consumed.ok) { txError = { errors: { _form: [consumed.error] } }; throw new Error('TX_VALIDATION') }
    }
    const listing = await tx.listing.create({
      data: {
        itemId,
        title,
        price: Number(price),
        description: description || undefined,
        status: 'active',
      },
    })
    await createAvailableFanoutJob(tx, item.catalogId, listing.id, listing.version)
    if (gate.decision === 'consume_approved') await markApprovalConsumed(tx, gate.approvalRequestId)
  }).catch((e) => { if ((e as Error).message !== 'TX_VALIDATION') throw e })
  if (txError) return txError

  await processFanoutBestEffort()

  redirect('/admin/listings')
}

export async function updateListing(
  id: string,
  _prev: ListingActionState,
  formData: FormData
): Promise<ListingActionState> {
  const result = UpdateListingSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { title, price, description, status } = result.data

  // Authoritative pre-update snapshot — never infer old price from alert history.
  const before = await prisma.listing.findUnique({
    where: { id },
    select: {
      itemId: true, price: true, status: true,
      item: { select: { catalogId: true, status: true, sellerAgreement: { select: { type: true, agreedBuyoutAmount: true, acceptedItemCount: true } } } },
    },
  })
  if (!before) return { errors: { _form: ['Listing not found.'] } }

  const proposedPriceCents = Math.round(Number(price) * 100)
  const oldPriceCents = Math.round(before.price * 100)

  // 15F-review section 1/2: reactivation (archived/sold -> active) is the SAME
  // commercial-activation risk as a brand-new listing — must go through the same
  // listing_activation gate, not just the price-deviation check below. Evaluated
  // first: if activation itself needs approval, that is reported before price.
  // Both this gate's consumption (if applicable) and the price gate's below happen
  // inside the SAME final mutation transaction, atomically with the actual write —
  // never in a separate, earlier transaction (an approval must never be marked
  // consumed except alongside the exact mutation it authorizes).
  const willBecomeActive = before.status !== 'active' && status === 'active'
  let activationGate: Awaited<ReturnType<typeof checkRiskGate>> | null = null
  let activationContext: ListingActivationContext | null = null
  if (willBecomeActive) {
    activationContext = await buildListingActivationContext(before.itemId, before.item.catalogId, proposedPriceCents, before.item.sellerAgreement)
    activationGate = await checkRiskGate({ action: 'listing_activation', context: activationContext, targetType: 'item_instance', targetId: before.itemId, requestedBy: 'admin' })
    if (activationGate.decision === 'deny') return { errors: { status: [activationGate.reasons.join(' ')] } }
    if (activationGate.decision === 'pending') {
      return { errors: { _form: ['Reactivating this listing requires approval for this item value.'] }, approvalRequestId: activationGate.approvalRequestId }
    }
  }

  // 15F: only a genuine price change is evaluated — editing title/description/status
  // alone stays frictionless.
  let gate: Awaited<ReturnType<typeof checkRiskGate>> | null = null
  let riskContext: ListingPriceChangeContext | null = null
  if (proposedPriceCents !== oldPriceCents) {
    const intel = await getPricingIntelligence(before.item.catalogId)
    riskContext = {
      listingId: id,
      oldPriceCents,
      proposedPriceCents,
      pricing: intel
        ? {
            isAskOnly: intel.isAskOnly,
            confidenceLevel: intel.confidence.level,
            estimatedValueCents: intel.estimatedValueCents,
            recommendedLowCents: intel.recommendedListing.lowCents,
            recommendedHighCents: intel.recommendedListing.highCents,
          }
        : null,
    }
    gate = await checkRiskGate({ action: 'listing_price_change', context: riskContext, targetType: 'listing', targetId: id, requestedBy: 'admin' })
    if (gate.decision === 'deny') return { errors: { price: [gate.reasons.join(' ')] } }
    if (gate.decision === 'pending') {
      return { errors: { _form: ['This price change requires approval before it can be saved.'] }, approvalRequestId: gate.approvalRequestId }
    }
  }

  let txError: ListingActionState = null

  if (status === 'sold') {
    await prisma.$transaction(async (tx) => {
      if (gate?.decision === 'consume_approved' && riskContext) {
        const consumed = await consumeApprovedRiskGate(tx, { approvalRequestId: gate.approvalRequestId, action: 'listing_price_change', targetId: id, context: riskContext })
        if (!consumed.ok) { txError = { errors: { _form: [consumed.error] } }; throw new Error('TX_VALIDATION') }
      }
      await tx.listing.update({
        where: { id },
        data: { title, price: Number(price), description: description || undefined, status, version: { increment: 1 } },
      })
      await tx.itemInstance.update({
        where: { id: before.itemId },
        data: { status: 'sold' },
      })
      if (gate?.decision === 'consume_approved') await markApprovalConsumed(tx, gate.approvalRequestId)
    }).catch((e) => { if ((e as Error).message !== 'TX_VALIDATION') throw e })
    if (txError) return txError
  } else {
    // The listing mutation and the durable fan-out job (if any transition qualifies)
    // commit atomically. Alerts fire only when the item itself is available (a listing
    // can be 'active' while its item is 'reserved' during checkout).
    await prisma.$transaction(async (tx) => {
      // Both gates (activation-becoming-active and price-change) are independent and
      // may both apply on the same request — each is consumed exactly once, here,
      // atomically with the single mutation below that both of them authorize.
      if (activationGate?.decision === 'consume_approved' && activationContext) {
        const consumed = await consumeApprovedRiskGate(tx, { approvalRequestId: activationGate.approvalRequestId, action: 'listing_activation', targetId: before.itemId, context: activationContext })
        if (!consumed.ok) { txError = { errors: { _form: [consumed.error] } }; throw new Error('TX_VALIDATION') }
      }
      if (gate?.decision === 'consume_approved' && riskContext) {
        const consumed = await consumeApprovedRiskGate(tx, { approvalRequestId: gate.approvalRequestId, action: 'listing_price_change', targetId: id, context: riskContext })
        if (!consumed.ok) { txError = { errors: { _form: [consumed.error] } }; throw new Error('TX_VALIDATION') }
      }
      const updated = await tx.listing.update({
        where: { id },
        data: { title, price: Number(price), description: description || undefined, status, version: { increment: 1 } },
      })
      if (activationGate?.decision === 'consume_approved') await markApprovalConsumed(tx, activationGate.approvalRequestId)
      if (gate?.decision === 'consume_approved') await markApprovalConsumed(tx, gate.approvalRequestId)

      if (before && before.item.status === 'available') {
        const becameActive = before.status !== 'active' && updated.status === 'active'
        const staysActive   = before.status === 'active' && updated.status === 'active'

        if (becameActive) {
          await createAvailableFanoutJob(tx, before.item.catalogId, updated.id, updated.version)
        } else if (staysActive && before.price !== updated.price) {
          await createPriceChangeFanoutJob(tx, before.item.catalogId, updated.id, before.price, updated.price, updated.version)
        }
      }
    }).catch((e) => { if ((e as Error).message !== 'TX_VALIDATION') throw e })
    if (txError) return txError

    await processFanoutBestEffort()
  }

  redirect('/admin/listings')
}
