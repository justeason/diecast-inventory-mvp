'use server'

import { redirect } from 'next/navigation'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { validateAgreementDraft, canTransitionStatus } from '@/lib/sellerAgreementValidation'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'
import {
  previewCommissionForSubmission,
  resolveCommissionForFinalization,
} from '@/lib/commissionPolicyQuery'
import type { AgreementOverrideDef } from '@/lib/commissionPolicy'

export type SellerAgreementActionState = {
  errors?: Record<string, string[]>
  message?: string
}

function extractInput(formData: FormData) {
  return {
    type: String(formData.get('type') ?? ''),
    agreedBuyoutAmount: formData.get('agreedBuyoutAmount') as string | null,
    commissionPercent: formData.get('commissionPercent') as string | null,
    fixedFee: formData.get('fixedFee') as string | null,
    minimumSellerPayout: formData.get('minimumSellerPayout') as string | null,
    agreedListPrice: formData.get('agreedListPrice') as string | null,
    sellerTermsSummary: formData.get('sellerTermsSummary') as string | null,
    adminNotes: formData.get('adminNotes') as string | null,
    commissionOverrideReason: formData.get('commissionOverrideReason') as string | null,
    commissionMinimumFee: formData.get('commissionMinimumFee') as string | null,
    acceptedItemCount: formData.get('acceptedItemCount') as string | null,
  }
}

function toDecimal(value: string | null): Prisma.Decimal | null {
  return value ? new Prisma.Decimal(value) : null
}

// 15A: bridges the validated decimal-string form values into the bps/cents shape the
// Commission Policy Engine's pure resolver operates on. Single-shot parse of an
// already-validated fixed-point string — not accumulated float arithmetic.
function toAgreementOverride(data: { commissionPercent: string | null; commissionMinimumFee: string | null; commissionOverrideReason: string | null }): AgreementOverrideDef | null {
  if (data.commissionPercent === null) return null
  return {
    commissionBps: Math.round(parseFloat(data.commissionPercent) * 10_000),
    minimumFeeCents: data.commissionMinimumFee ? Math.round(parseFloat(data.commissionMinimumFee) * 100) : 0,
    reason: data.commissionOverrideReason ?? '',
  }
}

function bpsToDecimalPercent(bps: number): Prisma.Decimal {
  return new Prisma.Decimal(bps).dividedBy(10_000).toDecimalPlaces(4)
}

function centsToDecimalAmount(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100).toDecimalPlaces(2)
}

// Shared by create/update: resolves commission terms for a draft consignment
// agreement (live preview — recomputed on every save while still a draft) and
// returns the fields to persist. Buyout agreements never call this.
//
// 15A-review section 1: acceptedItemCount is validated by the caller (format +
// <= submission.quantity cap) and passed in here explicitly — this function never
// derives it from SellerSubmission itself, so the tier denominator is always the
// admin-confirmed accepted count, never the raw submitted quantity.
async function resolveDraftCommissionFields(
  submissionId: string,
  data: { commissionPercent: string | null; commissionMinimumFee: string | null; commissionOverrideReason: string | null },
  acceptedItemCount: number,
): Promise<
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const agreementOverride = toAgreementOverride(data)
  const outcome = await previewCommissionForSubmission(submissionId, acceptedItemCount, new Date(), agreementOverride)
  if (!outcome.ok) {
    return { ok: false, error: 'No active commission policy is configured. Set terms manually with an override reason, or contact an administrator to configure a policy.' }
  }
  const r = outcome.resolution
  return {
    ok: true,
    fields: {
      commissionPercent: bpsToDecimalPercent(r.commissionBps),
      commissionMinimumFee: centsToDecimalAmount(r.minimumFeeCents),
      commissionPolicyId: r.policyId,
      commissionTierId: r.tierId,
      commissionSource: r.source,
      acceptedItemCount: r.acceptedItemCount,
      commissionResolvedAt: new Date(),
      commissionExplanation: r.explanation,
      commissionOverrideReason: r.source === 'agreement_override' ? data.commissionOverrideReason : null,
      // Auto-resolution never uses the legacy fixed-fee / minimum-seller-payout
      // mechanism — those stay null so calculateConsignmentPayoutSnapshot's floor
      // logic for them is a no-op for policy-driven agreements.
      fixedFee: null,
      minimumSellerPayout: null,
    },
  }
}

// 15A-review section 1: shared cap-check — an admin cannot accept more items than
// were actually submitted. Format (integer >= 1) is already enforced by
// validateAgreementDraft; this only checks the upper bound, which requires a DB read.
//
// 15B section 5: when the submission belongs to a portfolio, "submitted" means the
// portfolio's total across ALL its submissions (a portfolio may span multiple), not
// just this one submission's quantity — avoids a redundant, narrower cap that would
// contradict the portfolio-level total shown on the portfolio page.
async function validateAcceptedItemCountCap(
  submissionId: string,
  acceptedItemCount: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const submittedQuantity = await resolveSubmittedQuantityCap(prisma, submissionId)
  if (acceptedItemCount > submittedQuantity) {
    return {
      ok: false,
      error: `Accepted quantity (${acceptedItemCount}) cannot exceed the submitted total (${submittedQuantity}).`,
    }
  }
  return { ok: true }
}

type PrismaClientOrTx = typeof prisma | Prisma.TransactionClient

async function resolveSubmittedQuantityCap(client: PrismaClientOrTx, submissionId: string): Promise<number> {
  const submission = await client.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { quantity: true, sellerPortfolioId: true },
  })
  if (!submission) return 0
  if (!submission.sellerPortfolioId) return submission.quantity
  const agg = await client.sellerSubmission.aggregate({
    where: { sellerPortfolioId: submission.sellerPortfolioId },
    _sum: { quantity: true },
  })
  return agg._sum.quantity ?? submission.quantity
}

// 15B section 5: for a portfolio-linked submission, the accepted-count SOURCE OF
// TRUTH before agreement acceptance is Portfolio.acceptedItemCount — never a
// second, independently-editable value on the draft agreement (would be a redundant
// source of truth, see section 4). Falls back to the portfolio's submitted total if
// the portfolio hasn't had an accepted count confirmed yet. Returns null when the
// submission is not portfolio-linked, meaning "use the browser-submitted form value
// as before" (unchanged 15A behavior).
async function resolvePortfolioAcceptedItemCount(client: PrismaClientOrTx, submissionId: string): Promise<number | null> {
  const submission = await client.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { sellerPortfolioId: true },
  })
  if (!submission?.sellerPortfolioId) return null
  const portfolio = await client.sellerPortfolio.findUnique({
    where: { id: submission.sellerPortfolioId },
    select: { acceptedItemCount: true },
  })
  if (portfolio?.acceptedItemCount != null) return portfolio.acceptedItemCount
  return resolveSubmittedQuantityCap(client, submissionId)
}

export async function createSellerAgreement(
  submissionId: string,
  _prev: SellerAgreementActionState,
  formData: FormData,
): Promise<SellerAgreementActionState> {
  const result = validateAgreementDraft(extractInput(formData))
  if (!result.valid) return { errors: result.errors }

  const { data } = result

  // 15B-review section 2: a portfolio can have multiple submissions, each with its
  // own row — locking only the submission row does NOT serialize two concurrent
  // "create agreement" attempts started from DIFFERENT submissions of the SAME
  // portfolio, and both could create a "current" agreement for that portfolio. The
  // portfolio row (when one exists) is the correct, wider serialization boundary and
  // must be locked FIRST — this pre-transaction read is non-authoritative and used
  // only to decide lock order (matches the existing "pre-read for canonical lock
  // ordering" convention used elsewhere, e.g. receiveSellerInboundShipment);
  // sellerPortfolioId is never changed by any action once set, so this is safe.
  const lockOrderHint = await prisma.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { sellerPortfolioId: true },
  })

  let txError: SellerAgreementActionState | null = null
  let created = false

  await prisma.$transaction(async (tx) => {
    // Canonical lock order: portfolio (wider scope) → submission. Must match
    // recordSellerAgreementAcceptance's order exactly, or two concurrent
    // transactions taking the same two locks in opposite order can deadlock.
    if (lockOrderHint?.sellerPortfolioId) {
      await tx.$queryRaw`SELECT id FROM "SellerPortfolio" WHERE id = ${lockOrderHint.sellerPortfolioId} FOR UPDATE`
    }
    await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionId} FOR UPDATE`

    const submission = await tx.sellerSubmission.findUnique({
      where: { id: submissionId },
      select: { profileId: true, sellerPortfolioId: true },
    })
    if (!submission) {
      txError = { errors: { _form: ['Submission not found'] } }
      throw new Error('TX_VALIDATION')
    }

    // 15B-review section 2: "current agreement" is scoped to the whole PORTFOLIO
    // when portfolio-linked (never just this one submission) — this is what actually
    // prevents two submissions of the same portfolio from each getting their own
    // "current" agreement. Falls back to the old submission-scoped check for
    // non-portfolio agreements (unchanged behavior).
    const existing = await tx.sellerAgreement.findFirst({
      where: submission.sellerPortfolioId
        ? { sellerPortfolioId: submission.sellerPortfolioId, status: { not: 'cancelled' } }
        : { submissionId, status: { not: 'cancelled' } },
      select: { id: true },
    })
    if (existing) {
      txError = {
        errors: {
          _form: [
            submission.sellerPortfolioId
              ? 'This portfolio already has a current agreement. Cancel it before creating a new one.'
              : 'An active agreement already exists for this submission. Cancel it before creating a new one.',
          ],
        },
      }
      throw new Error('TX_VALIDATION')
    }

    const sellerProfile = await tx.sellerProfile.findUnique({
      where: { profileId: submission.profileId },
      select: { id: true },
    })

    let commissionFields: Record<string, unknown> = {
      commissionPercent: toDecimal(data.commissionPercent),
      fixedFee: toDecimal(data.fixedFee),
      minimumSellerPayout: toDecimal(data.minimumSellerPayout),
      // 15D-review (final approval pass): buyout-only use of this field — optional,
      // no cap-check/commission-tiering attaches to it. The consignment branch below
      // always overwrites this object wholesale, so it never reaches this value.
      acceptedItemCount: data.acceptedItemCount,
    }
    if (data.type === 'consignment') {
      // Portfolio-linked: accepted count comes from the portfolio, never the
      // browser-submitted form value (avoids a redundant, divergent source of truth).
      const portfolioAcceptedCount = await resolvePortfolioAcceptedItemCount(tx, submissionId)
      // acceptedItemCount is required for consignment by validateAgreementDraft, so
      // the non-portfolio fallback is non-null here.
      const acceptedItemCount = portfolioAcceptedCount ?? (data.acceptedItemCount as number)
      const cap = await validateAcceptedItemCountCap(submissionId, acceptedItemCount)
      if (!cap.ok) {
        txError = { errors: { acceptedItemCount: [cap.error] } }
        throw new Error('TX_VALIDATION')
      }
      const resolved = await resolveDraftCommissionFields(submissionId, data, acceptedItemCount)
      if (!resolved.ok) {
        txError = { errors: { _form: [resolved.error] } }
        throw new Error('TX_VALIDATION')
      }
      commissionFields = resolved.fields
    }

    await tx.sellerAgreement.create({
      data: {
        submissionId,
        sellerProfileId: sellerProfile?.id ?? null,
        sellerPortfolioId: submission.sellerPortfolioId,
        type: data.type,
        currency: data.currency,
        agreedBuyoutAmount: toDecimal(data.agreedBuyoutAmount),
        agreedListPrice: toDecimal(data.agreedListPrice),
        sellerTermsSummary: data.sellerTermsSummary,
        adminNotes: data.adminNotes,
        ...commissionFields,
      },
    })
    created = true
  }).catch((err) => {
    if ((err as Error).message !== 'TX_VALIDATION') throw err
  })

  if (!created) return txError ?? { errors: { _form: ['Failed to create agreement.'] } }

  redirect(`/admin/seller-submissions/${submissionId}/agreement`)
}

export async function updateSellerAgreement(
  agreementId: string,
  _prev: SellerAgreementActionState,
  formData: FormData,
): Promise<SellerAgreementActionState> {
  const result = validateAgreementDraft(extractInput(formData))
  if (!result.valid) return { errors: result.errors }

  const agreement = await prisma.sellerAgreement.findUnique({
    where: { id: agreementId },
    select: { id: true, status: true, submissionId: true },
  })
  if (!agreement) return { errors: { _form: ['Agreement not found'] } }
  if (agreement.status !== 'draft') {
    return { errors: { _form: ['Only draft agreements can be edited'] } }
  }

  const { data } = result

  let commissionFields: Record<string, unknown> = {
    commissionPercent: toDecimal(data.commissionPercent),
    fixedFee: toDecimal(data.fixedFee),
    minimumSellerPayout: toDecimal(data.minimumSellerPayout),
    // 15D-review (final approval pass): buyout-only use — see createSellerAgreement.
    acceptedItemCount: data.acceptedItemCount,
  }
  if (data.type === 'consignment') {
    const portfolioAcceptedCount = await resolvePortfolioAcceptedItemCount(prisma, agreement.submissionId)
    const acceptedItemCount = portfolioAcceptedCount ?? (data.acceptedItemCount as number)
    const cap = await validateAcceptedItemCountCap(agreement.submissionId, acceptedItemCount)
    if (!cap.ok) return { errors: { acceptedItemCount: [cap.error] } }
    const resolved = await resolveDraftCommissionFields(agreement.submissionId, data, acceptedItemCount)
    if (!resolved.ok) return { errors: { _form: [resolved.error] } }
    commissionFields = resolved.fields
  }

  await prisma.sellerAgreement.update({
    where: { id: agreementId },
    data: {
      type: data.type,
      currency: data.currency,
      agreedBuyoutAmount: toDecimal(data.agreedBuyoutAmount),
      agreedListPrice: toDecimal(data.agreedListPrice),
      sellerTermsSummary: data.sellerTermsSummary,
      adminNotes: data.adminNotes,
      ...commissionFields,
    },
  })

  redirect(`/admin/seller-submissions/${agreement.submissionId}/agreement`)
}

export async function proposeSellerAgreement(
  agreementId: string,
  _prev: SellerAgreementActionState,
  formData: FormData,
): Promise<SellerAgreementActionState> {
  void formData.get('_action')

  const agreement = await prisma.sellerAgreement.findUnique({
    where: { id: agreementId },
    select: { id: true, status: true, submissionId: true, sellerTermsSummary: true },
  })
  if (!agreement) return { errors: { _form: ['Agreement not found'] } }

  const transition = canTransitionStatus(agreement.status, 'proposed')
  if (!transition.allowed) return { errors: { _form: [transition.reason] } }

  if (!agreement.sellerTermsSummary?.trim()) {
    return {
      errors: {
        sellerTermsSummary: [
          'Seller terms summary is required before proposing. Add a plain-language summary of the agreement terms.',
        ],
      },
    }
  }

  await prisma.sellerAgreement.update({
    where: { id: agreementId },
    data: { status: 'proposed', proposedAt: new Date() },
  })

  try {
    await ensureSellerLifecycleEvent({
      eventKey: `agreement-proposed:${agreementId}`,
      sellerSubmissionId: agreement.submissionId,
      eventType: 'agreement_proposed',
      sourceEntityType: 'agreement',
      sourceEntityId: agreementId,
      sellerVisible: true,
      sellerTitle: 'Agreement proposed',
      sellerDescription:
        'CollectNTrades has proposed agreement terms. Review and contact us with any questions.',
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[proposeSellerAgreement] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
  }

  redirect(`/admin/seller-submissions/${agreement.submissionId}/agreement`)
}

export async function recordSellerAgreementAcceptance(
  agreementId: string,
  _prev: SellerAgreementActionState,
  formData: FormData,
): Promise<SellerAgreementActionState> {
  const acceptanceMethod = String(formData.get('acceptanceMethod') ?? '').trim()

  if (!['email', 'in_person', 'platform'].includes(acceptanceMethod)) {
    return { errors: { acceptanceMethod: ['Acceptance method is required'] } }
  }

  const agreement = await prisma.sellerAgreement.findUnique({
    where: { id: agreementId },
    // sellerPortfolioId is read here purely to decide lock order below — it is
    // immutable once an agreement is created (no action ever changes it), so this
    // pre-transaction read is safe to rely on for ordering, same as createSellerAgreement.
    select: { id: true, status: true, submissionId: true, type: true, sellerProfileId: true, sellerPortfolioId: true },
  })
  if (!agreement) return { errors: { _form: ['Agreement not found'] } }

  // Eager status check (fast path before acquiring lock)
  const earlyTransition = canTransitionStatus(agreement.status, 'accepted')
  if (!earlyTransition.allowed) return { errors: { _form: [earlyTransition.reason] } }

  // Lock SellerPortfolio (if any) then SellerSubmission, then re-validate inside the
  // transaction. Canonical order portfolio → submission — MUST match
  // createSellerAgreement's order exactly, or two concurrent transactions taking the
  // same two locks in opposite order can deadlock. Serializes against concurrent
  // pricing-preference saves and intake conversions that lock the submission row, and
  // against concurrent portfolio accepted-count edits / new agreement creation on the
  // same portfolio — this is also what makes commission-term finalization safe under
  // concurrency: terms are snapshotted exactly once, inside this single lock, never
  // observed partially-written by a concurrent payout/read.
  const txResult = await prisma.$transaction(async (tx) => {
    if (agreement.sellerPortfolioId) {
      await tx.$queryRaw`SELECT id FROM "SellerPortfolio" WHERE id = ${agreement.sellerPortfolioId} FOR UPDATE`
    }
    await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${agreement.submissionId} FOR UPDATE`
    const fresh = await tx.sellerAgreement.findUnique({
      where: { id: agreementId },
      select: {
        status: true,
        type: true,
        sellerProfileId: true,
        sellerPortfolioId: true,
        commissionSource: true,
        commissionPercent: true,
        commissionMinimumFee: true,
        commissionOverrideReason: true,
        acceptedItemCount: true,
      },
    })
    if (!fresh) return { errors: { _form: ['Agreement not found'] } }
    const transition = canTransitionStatus(fresh.status, 'accepted')
    if (!transition.allowed) return { errors: { _form: [transition.reason] } }

    // 15A: final commission snapshot — re-resolved ONE LAST TIME here (never again
    // after this write) so it reflects the latest policy/seller-override state at the
    // actual moment of acceptance, not whatever was last previewed on the draft page.
    // An existing agreement-level override is carried through unchanged rather than
    // silently replaced by an auto-resolution.
    let commissionFields: Record<string, unknown> = {}
    if (fresh.type === 'consignment') {
      // 15B section 5/23: for a portfolio-linked agreement, re-fetch its CURRENT
      // accepted count — it may have changed since the last draft save (the
      // portfolio's count is the pre-acceptance source of truth, see
      // resolvePortfolioAcceptedItemCount). The portfolio row is already locked above
      // (before the submission lock, canonical order), so this read is authoritative.
      // Non-portfolio agreements keep the exact 15A behavior: trust only the
      // DB-persisted agreement snapshot, never the browser.
      let acceptedItemCount = fresh.acceptedItemCount
      if (fresh.sellerPortfolioId) {
        acceptedItemCount = await resolvePortfolioAcceptedItemCount(tx, agreement.submissionId)
      }

      // 15A-review section 1/5: never trust a browser-provided accepted count — the
      // persisted/portfolio-sourced value (re-fetched above, inside the same
      // transaction) is re-validated here, one last time, before it is frozen into
      // the acceptance snapshot.
      if (acceptedItemCount === null || acceptedItemCount < 1) {
        return { errors: { _form: ['Accepted quantity must be set to 1 or more before this agreement can be accepted.'] } }
      }
      const submittedQuantity = await resolveSubmittedQuantityCap(tx, agreement.submissionId)
      if (acceptedItemCount > submittedQuantity) {
        return {
          errors: {
            _form: [`Accepted quantity (${acceptedItemCount}) exceeds the submitted total (${submittedQuantity}). Correct the accepted quantity before accepting.`],
          },
        }
      }

      const existingOverride = fresh.commissionSource === 'agreement_override' && fresh.commissionPercent
        ? {
            commissionBps: Math.round(parseFloat(fresh.commissionPercent.toString()) * 10_000),
            minimumFeeCents: fresh.commissionMinimumFee ? Math.round(parseFloat(fresh.commissionMinimumFee.toString()) * 100) : 0,
            reason: fresh.commissionOverrideReason ?? '',
          }
        : null
      const outcome = await resolveCommissionForFinalization(tx, {
        sellerProfileId: fresh.sellerProfileId,
        agreementOverride: existingOverride,
        acceptedItemCount,
        asOf: new Date(),
      })
      if (!outcome.ok) {
        return { errors: { _form: ['No active commission policy is configured and this agreement has no override. Set an override with a reason before accepting.'] } }
      }
      const r = outcome.resolution
      commissionFields = {
        commissionPercent: new Prisma.Decimal(r.commissionBps).dividedBy(10_000).toDecimalPlaces(4),
        commissionMinimumFee: new Prisma.Decimal(r.minimumFeeCents).dividedBy(100).toDecimalPlaces(2),
        commissionPolicyId: r.policyId,
        commissionTierId: r.tierId,
        commissionSource: r.source,
        acceptedItemCount: r.acceptedItemCount,
        commissionResolvedAt: new Date(),
        commissionExplanation: r.explanation,
        commissionOverrideReason: r.source === 'agreement_override' ? (existingOverride?.reason ?? null) : null,
      }
    }

    await tx.sellerAgreement.update({
      where: { id: agreementId },
      data: { status: 'accepted', acceptedAt: new Date(), acceptanceMethod, ...commissionFields },
    })
    return null
  })
  if (txResult !== null) return txResult

  try {
    await ensureSellerLifecycleEvent({
      eventKey: `agreement-accepted:${agreementId}`,
      sellerSubmissionId: agreement.submissionId,
      eventType: 'agreement_accepted',
      sourceEntityType: 'agreement',
      sourceEntityId: agreementId,
      sellerVisible: true,
      sellerTitle: 'Agreement accepted',
      sellerDescription: 'You have accepted the agreement terms.',
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[recordSellerAgreementAcceptance] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
  }

  redirect(`/admin/seller-submissions/${agreement.submissionId}/agreement`)
}

export async function cancelSellerAgreement(
  agreementId: string,
  _prev: SellerAgreementActionState,
  formData: FormData,
): Promise<SellerAgreementActionState> {
  void formData.get('_action')

  const agreement = await prisma.sellerAgreement.findUnique({
    where: { id: agreementId },
    select: {
      id: true,
      status: true,
      submissionId: true,
      _count: { select: { items: true } },
    },
  })
  if (!agreement) return { errors: { _form: ['Agreement not found'] } }

  const transition = canTransitionStatus(agreement.status, 'cancelled')
  if (!transition.allowed) return { errors: { _form: [transition.reason] } }

  if (agreement._count.items > 0) {
    return {
      errors: {
        _form: [
          'This agreement is linked to inventory and cannot be cancelled. Resolve the inventory relationship first.',
        ],
      },
    }
  }

  if (agreement.status === 'accepted') {
    const convertedIntake = await prisma.intakeDraft.findFirst({
      where: { sellerSubmissionId: agreement.submissionId, status: 'converted' },
      select: { id: true },
    })
    if (convertedIntake) {
      return {
        errors: {
          _form: [
            'Cannot cancel an accepted agreement that has a converted intake. Contact the seller and resolve inventory first.',
          ],
        },
      }
    }
  }

  await prisma.sellerAgreement.update({
    where: { id: agreementId },
    data: { status: 'cancelled', cancelledAt: new Date() },
  })

  try {
    await ensureSellerLifecycleEvent({
      eventKey: `agreement-cancelled:${agreementId}`,
      sellerSubmissionId: agreement.submissionId,
      eventType: 'agreement_cancelled',
      sourceEntityType: 'agreement',
      sourceEntityId: agreementId,
      sellerVisible: false,
      adminDescription: 'Agreement cancelled.',
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[cancelSellerAgreement] lifecycle event failed:', err instanceof Error ? err.message : 'UnknownError')
  }

  redirect(`/admin/seller-submissions/${agreement.submissionId}/agreement`)
}
