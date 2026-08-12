'use server'

// 15B: admin server actions for SellerPortfolio — the operational grouping layer.
// Concurrency (section 23): every write that could race with another writer over the
// same row acquires a `SELECT ... FOR UPDATE` lock inside a transaction before
// re-reading authoritative state — never trusts a pre-transaction read or browser
// state. Portfolio creation itself is treated as low-risk per spec and does not need
// a lock (it only ever creates a brand-new row).

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { canMarkPortfolioCompleted } from '@/lib/sellerPortfolio'
import type { PortfolioStageInput } from '@/lib/sellerPortfolio'

export type PortfolioActionState = { errors: Record<string, string[]> } | null

function trimOrNull(v: FormDataEntryValue | null, max = 2000): string | null {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : ''
  return s || null
}

function revalidatePortfolioPaths(portfolioId: string) {
  revalidatePath('/admin/seller-portfolios')
  revalidatePath(`/admin/seller-portfolios/${portfolioId}`)
}

// ─── Create a portfolio from an existing submission ─────────────────────────────
// Low admin effort per section 7: one click on the submission's admin page (a plain
// form, no useActionState — matches startIntakeDraftFromSubmission's convention).
// Locks the submission row so a concurrent second click (or another admin) can't
// double-assign it. Silently redirects back to the submission on failure, same as
// startIntakeDraftFromSubmission — this is a low-risk, easily-retried action.

export async function createPortfolioFromSubmission(
  submissionId: string,
  formData: FormData,
): Promise<void> {
  if (!(await isAdminAuthenticated())) redirect(`/admin/seller-submissions/${submissionId}`)

  const name = trimOrNull(formData.get('name'), 200)

  let portfolioId: string | null = null

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionId} FOR UPDATE`

    const submission = await tx.sellerSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, profileId: true, sellerPortfolioId: true },
    })
    if (!submission || submission.sellerPortfolioId) return

    const sellerProfile = await tx.sellerProfile.findUnique({
      where: { profileId: submission.profileId },
      select: { id: true },
    })
    if (!sellerProfile) return

    const portfolio = await tx.sellerPortfolio.create({
      data: { sellerProfileId: sellerProfile.id, name, status: 'draft' },
    })
    await tx.sellerSubmission.update({
      where: { id: submissionId },
      data: { sellerPortfolioId: portfolio.id },
    })
    portfolioId = portfolio.id
  })

  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  if (!portfolioId) redirect(`/admin/seller-submissions/${submissionId}`)
  revalidatePortfolioPaths(portfolioId)
  redirect(`/admin/seller-portfolios/${portfolioId}`)
}

// ─── Add an existing (unlinked) submission to an existing portfolio ─────────────
// Section 8: a portfolio may contain multiple submissions. The submission must belong
// to the SAME seller as the portfolio and not already belong to a different portfolio.

export async function addSubmissionToPortfolio(
  portfolioId: string,
  _prev: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  if (!(await isAdminAuthenticated())) return { errors: { form: ['Admin authentication required.'] } }

  const submissionId = trimOrNull(formData.get('submissionId'))
  if (!submissionId) return { errors: { submissionId: ['Select a submission to add.'] } }

  let txError: PortfolioActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionId} FOR UPDATE`

      const [portfolio, submission] = await Promise.all([
        tx.sellerPortfolio.findUnique({ where: { id: portfolioId }, select: { id: true, sellerProfileId: true, status: true } }),
        tx.sellerSubmission.findUnique({ where: { id: submissionId }, select: { id: true, profileId: true, sellerPortfolioId: true } }),
      ])
      if (!portfolio) {
        txError = { errors: { form: ['Portfolio not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (portfolio.status === 'cancelled' || portfolio.status === 'completed') {
        txError = { errors: { form: [`Cannot add a submission to a ${portfolio.status} portfolio.`] } }
        throw new Error('TX_VALIDATION')
      }
      if (!submission) {
        txError = { errors: { submissionId: ['Submission not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (submission.sellerPortfolioId) {
        txError = { errors: { submissionId: ['This submission already belongs to a portfolio.'] } }
        throw new Error('TX_VALIDATION')
      }

      const sellerProfile = await tx.sellerProfile.findUnique({
        where: { profileId: submission.profileId },
        select: { id: true },
      })
      if (!sellerProfile || sellerProfile.id !== portfolio.sellerProfileId) {
        txError = { errors: { submissionId: ['Submission belongs to a different seller than this portfolio.'] } }
        throw new Error('TX_VALIDATION')
      }

      await tx.sellerSubmission.update({ where: { id: submissionId }, data: { sellerPortfolioId: portfolioId } })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  revalidatePortfolioPaths(portfolioId)
  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  return null
}

// ─── Update the portfolio's accepted item count ──────────────────────────────────
// Section 5: this is the pre-acceptance accepted-count SOURCE for a portfolio-linked
// agreement's commission preview. Once the portfolio's current agreement is accepted,
// its own frozen SellerAgreement.acceptedItemCount snapshot is authoritative and this
// field can no longer influence commission — editing it afterward is allowed for
// record-keeping (e.g. tracking actual received count) but never re-tiers the signed
// agreement (enforced by resolveDraftCommissionFields never running post-acceptance).

export async function updatePortfolioAcceptedCount(
  portfolioId: string,
  _prev: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  if (!(await isAdminAuthenticated())) return { errors: { form: ['Admin authentication required.'] } }

  const raw = trimOrNull(formData.get('acceptedItemCount'))
  let acceptedItemCount: number | null = null
  if (raw !== null) {
    if (!/^\d+$/.test(raw)) return { errors: { acceptedItemCount: ['Must be a whole number.'] } }
    acceptedItemCount = parseInt(raw, 10)
    if (acceptedItemCount < 1) return { errors: { acceptedItemCount: ['Must be 1 or greater.'] } }
  }

  let txError: PortfolioActionState = null

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SellerPortfolio" WHERE id = ${portfolioId} FOR UPDATE`

      const portfolio = await tx.sellerPortfolio.findUnique({ where: { id: portfolioId }, select: { id: true } })
      if (!portfolio) {
        txError = { errors: { form: ['Portfolio not found.'] } }
        throw new Error('TX_VALIDATION')
      }

      // 15B-review section 3: once the portfolio's current agreement is accepted, its
      // acceptedItemCount snapshot is frozen (15A) and is what actually determines
      // commission — this field would become a second, contradictory "accepted count"
      // if left editable. Block it outright rather than silently letting an edit here
      // imply different commercial terms; physical/operational variance is tracked
      // separately via SellerInboundShipment.receivedQuantity (see the portfolio
      // detail page's "Agreed quantity / Received / Variance" display).
      const acceptedAgreement = await tx.sellerAgreement.findFirst({
        where: { sellerPortfolioId: portfolioId, status: 'accepted' },
        select: { id: true },
      })
      if (acceptedAgreement) {
        txError = {
          errors: {
            form: [
              'This portfolio’s agreement has already been accepted at a fixed accepted quantity, which can no longer be changed here. Physical/received counts are tracked separately via shipments.',
            ],
          },
        }
        throw new Error('TX_VALIDATION')
      }

      if (acceptedItemCount !== null) {
        const submittedTotal = await tx.sellerSubmission.aggregate({
          where: { sellerPortfolioId: portfolioId },
          _sum: { quantity: true },
        })
        const total = submittedTotal._sum.quantity ?? 0
        if (acceptedItemCount > total) {
          txError = {
            errors: { acceptedItemCount: [`Accepted quantity (${acceptedItemCount}) cannot exceed the submitted total (${total}).`] },
          }
          throw new Error('TX_VALIDATION')
        }
      }

      await tx.sellerPortfolio.update({ where: { id: portfolioId }, data: { acceptedItemCount } })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txError
    throw err
  }

  revalidatePortfolioPaths(portfolioId)
  return null
}

// ─── Cancel / complete ────────────────────────────────────────────────────────────

export async function cancelSellerPortfolio(
  portfolioId: string,
  _prev: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  if (!(await isAdminAuthenticated())) return { errors: { form: ['Admin authentication required.'] } }

  const reason = trimOrNull(formData.get('reason'))
  if (!reason) return { errors: { reason: ['A cancellation reason is required.'] } }

  const portfolio = await prisma.sellerPortfolio.findUnique({ where: { id: portfolioId }, select: { status: true } })
  if (!portfolio) return { errors: { form: ['Portfolio not found.'] } }
  if (portfolio.status === 'cancelled') return { errors: { form: ['Already cancelled.'] } }

  await prisma.sellerPortfolio.update({
    where: { id: portfolioId },
    data: { status: 'cancelled', closedAt: new Date(), notes: reason },
  })

  revalidatePortfolioPaths(portfolioId)
  return null
}

// completeSellerPortfolio needs live derived-stage data (payout liability, inventory
// resolution) — that requires the query layer, so it's re-checked here directly
// against authoritative aggregates rather than trusting any client-supplied flag.
export async function completeSellerPortfolio(
  portfolioId: string,
  _prev: PortfolioActionState,
  formData: FormData,
): Promise<PortfolioActionState> {
  void _prev
  void formData.get('_action')
  if (!(await isAdminAuthenticated())) return { errors: { form: ['Admin authentication required.'] } }

  const portfolio = await prisma.sellerPortfolio.findUnique({
    where: { id: portfolioId },
    select: { id: true, status: true },
  })
  if (!portfolio) return { errors: { form: ['Portfolio not found.'] } }
  if (portfolio.status === 'cancelled') return { errors: { form: ['Cannot complete a cancelled portfolio.'] } }
  if (portfolio.status === 'completed') return { errors: { form: ['Already completed.'] } }

  const [agreement, shipments, intakeCompleteCount, itemStatusGroups, outstandingLiability, rejectedIntakeCount, openCaseCount] = await Promise.all([
    prisma.sellerAgreement.findFirst({
      where: { sellerPortfolioId: portfolioId, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    }),
    prisma.sellerInboundShipment.findMany({
      where: { sellerPortfolioId: portfolioId, status: { not: 'cancelled' } },
      select: { status: true },
    }),
    prisma.intakeDraft.count({ where: { status: 'converted', sellerSubmission: { sellerPortfolioId: portfolioId } } }),
    prisma.itemInstance.groupBy({ by: ['status'], where: { sellerPortfolioId: portfolioId }, _count: { _all: true } }),
    prisma.sellerPayoutLine.aggregate({
      where: {
        agreement: { sellerPortfolioId: portfolioId },
        status: { in: ['eligible', 'held'] },
        OR: [{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }],
      },
      _sum: { netAmount: true },
    }),
    prisma.intakeDraft.count({ where: { status: 'rejected', sellerSubmission: { sellerPortfolioId: portfolioId } } }),
    prisma.sellerLifecycleCase.count({ where: { status: { in: ['open', 'action_required'] }, sellerSubmission: { sellerPortfolioId: portfolioId } } }),
  ])

  const soldCount = itemStatusGroups.find(g => g.status === 'sold')?._count._all ?? 0
  const hasOutstandingPayoutLiability = (outstandingLiability._sum.netAmount ?? 0).toString() !== '0'
  const hasOpenIntakeException = rejectedIntakeCount + openCaseCount > 0
  const hasUnresolvedInboundDiscrepancy = shipments.some((s) => s.status === 'issue')

  const stageInput: PortfolioStageInput = {
    status: 'open',
    hasAcceptedAgreement: agreement?.status === 'accepted',
    hasNonCancelledShipment: shipments.length > 0,
    anyShipmentInTransit: shipments.some(s => s.status === 'shipped'),
    receivedItemCount: intakeCompleteCount, // resolved by construction once intake >= received is enforced elsewhere
    intakeCompleteCount,
    allInventoryResolved: intakeCompleteCount > 0 && soldCount >= intakeCompleteCount && !hasOutstandingPayoutLiability,
    hasOutstandingPayoutLiability,
    hasOpenIntakeException,
    hasUnresolvedInboundDiscrepancy,
  }

  const check = canMarkPortfolioCompleted(stageInput)
  if (!check.ok) return { errors: { form: [check.reason] } }

  await prisma.sellerPortfolio.update({
    where: { id: portfolioId },
    data: { status: 'completed', closedAt: new Date() },
  })

  revalidatePortfolioPaths(portfolioId)
  return null
}
