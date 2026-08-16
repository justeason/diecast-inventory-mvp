// 15K Part G: the ONE authoritative boundary that creates a new Listing row
// (tx.listing.create). Both the interactive path (actions/listings.ts createListing)
// and the automation path (autoListingExecution.ts) call createListingAtomic after
// independently confirming — in their own way — that this exact activation is
// authorized. Neither path, nor any other module, may call tx.listing.create
// directly (see readyToListSafety-style structural tests in
// autoListingSafety.test.ts).
import { Prisma } from '@prisma/client'
import { createAvailableFanoutJob } from '@/lib/buyerAlertsTrigger'
import type { ListingActivationContext } from '@/lib/riskPolicy'

type TxClient = Prisma.TransactionClient

// Shared by createListing AND updateListing's reactivation branch — an archived/sold
// listing being flipped back to active is the same commercial-activation risk as a
// brand-new listing, so both go through the same value-hierarchy context builder,
// never a second copy. Automation (autoListingExecution.ts) uses this too.
//
// 15K (execution-snapshot pass): this is now PURE — no DB access. It previously
// fetched 14C pricing itself, via the plain global prisma client, which is exactly
// the "unrelated global client inside the execution path" pattern that let auto-
// listing evaluate risk against pricing evidence from a DIFFERENT, disconnected read
// than the one that computed the proposed price. Every caller now fetches pricing
// itself (via whichever client — global or an open transaction — is authoritative
// for its own call site) and passes the resulting `estimatedValueCents` in directly,
// so risk evaluation always uses the EXACT SAME evidence as the price it is judging.
export function buildListingActivationContext(
  itemId: string,
  catalogId: string,
  proposedPriceCents: number,
  estimatedValueCents: number | null,
  sellerAgreement: { type: string; agreedBuyoutAmount: unknown; acceptedItemCount: number | null } | null,
): ListingActivationContext {
  return {
    itemId,
    catalogModelId: catalogId,
    proposedPriceCents,
    completedSaleAmountCents: null,
    currentListingPriceCents: null,
    estimatedValueCents,
    agreementBuyoutTotalCents:
      sellerAgreement?.type === 'buyout' && sellerAgreement.acceptedItemCount === 1 && sellerAgreement.agreedBuyoutAmount
        ? Math.round(parseFloat((sellerAgreement.agreedBuyoutAmount as { toString(): string }).toString()) * 100)
        : null,
  }
}

export type CreateListingAtomicResult = { ok: true; id: string; version: number } | { ok: false; reason: 'already_listed' }

// The P2002 catch is a defensive backstop for the Listing.itemId unique constraint —
// NEVER the primary concurrency mechanism (Part L section 28). Both callers hold a
// row lock on the ItemInstance and re-verify no listing exists immediately before
// calling this, inside the same transaction; P2002 only guards the residual window
// that check-then-act can't close by itself.
export async function createListingAtomic(
  tx: TxClient,
  params: { itemId: string; catalogId: string; title: string; price: number; description?: string | null },
): Promise<CreateListingAtomicResult> {
  try {
    const listing = await tx.listing.create({
      data: {
        itemId: params.itemId,
        title: params.title,
        price: params.price,
        description: params.description || undefined,
        status: 'active',
      },
    })
    await createAvailableFanoutJob(tx, params.catalogId, listing.id, listing.version)
    return { ok: true, id: listing.id, version: listing.version }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: false, reason: 'already_listed' }
    }
    throw e
  }
}
