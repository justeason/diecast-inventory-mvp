'use server'

// 27B §35/§43/§59: server-computed Estimated Seller Proceeds preview. Canonical
// commission/payout math originates here (never client-side) — the client
// island only collects a per-item price and displays the result.
import { getBuyerSession } from '@/lib/buyerSession'
import { prisma } from '@/lib/prisma'
import { estimateSellerProceeds, type SellerProceedsEstimate } from '@/lib/sellerProceedsEstimator'

export type ProceedsPreviewResult =
  | { ok: true; estimate: SellerProceedsEstimate | null }
  | { ok: false; error: string }

export async function previewSellerProceedsAction(
  submissionId: string,
  perItemPriceCents: number,
): Promise<ProceedsPreviewResult> {
  const session = await getBuyerSession()
  if (!session) return { ok: false, error: 'Sign in required.' }

  if (!Number.isFinite(perItemPriceCents) || perItemPriceCents < 0) {
    return { ok: false, error: 'Enter a valid price.' }
  }

  const submission = await prisma.sellerSubmission.findFirst({
    where: { id: submissionId, profileId: session.profileId },
    select: { id: true, quantity: true },
  })
  if (!submission) return { ok: false, error: 'Submission not found.' }

  const estimate = await estimateSellerProceeds({ submissionId, perItemPriceCents, quantity: submission.quantity })
  return { ok: true, estimate }
}
