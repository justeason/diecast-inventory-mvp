'use server'

import { redirect } from 'next/navigation'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { validateAgreementDraft, canTransitionStatus } from '@/lib/sellerAgreementValidation'
import { ensureSellerLifecycleEvent } from '@/lib/actions/sellerLifecycle'

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
  }
}

function toDecimal(value: string | null): Prisma.Decimal | null {
  return value ? new Prisma.Decimal(value) : null
}

export async function createSellerAgreement(
  submissionId: string,
  _prev: SellerAgreementActionState,
  formData: FormData,
): Promise<SellerAgreementActionState> {
  const result = validateAgreementDraft(extractInput(formData))
  if (!result.valid) return { errors: result.errors }

  const existing = await prisma.sellerAgreement.findFirst({
    where: { submissionId, status: { not: 'cancelled' } },
    select: { id: true },
  })
  if (existing) {
    return {
      errors: {
        _form: [
          'An active agreement already exists for this submission. Cancel it before creating a new one.',
        ],
      },
    }
  }

  const submission = await prisma.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { profileId: true },
  })
  if (!submission) return { errors: { _form: ['Submission not found'] } }

  const sellerProfile = await prisma.sellerProfile.findUnique({
    where: { profileId: submission.profileId },
    select: { id: true },
  })

  const { data } = result
  await prisma.sellerAgreement.create({
    data: {
      submissionId,
      sellerProfileId: sellerProfile?.id ?? null,
      type: data.type,
      currency: data.currency,
      agreedBuyoutAmount: toDecimal(data.agreedBuyoutAmount),
      commissionPercent: toDecimal(data.commissionPercent),
      fixedFee: toDecimal(data.fixedFee),
      minimumSellerPayout: toDecimal(data.minimumSellerPayout),
      agreedListPrice: toDecimal(data.agreedListPrice),
      sellerTermsSummary: data.sellerTermsSummary,
      adminNotes: data.adminNotes,
    },
  })

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
  await prisma.sellerAgreement.update({
    where: { id: agreementId },
    data: {
      type: data.type,
      currency: data.currency,
      agreedBuyoutAmount: toDecimal(data.agreedBuyoutAmount),
      commissionPercent: toDecimal(data.commissionPercent),
      fixedFee: toDecimal(data.fixedFee),
      minimumSellerPayout: toDecimal(data.minimumSellerPayout),
      agreedListPrice: toDecimal(data.agreedListPrice),
      sellerTermsSummary: data.sellerTermsSummary,
      adminNotes: data.adminNotes,
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
    select: { id: true, status: true, submissionId: true },
  })
  if (!agreement) return { errors: { _form: ['Agreement not found'] } }

  // Eager status check (fast path before acquiring lock)
  const earlyTransition = canTransitionStatus(agreement.status, 'accepted')
  if (!earlyTransition.allowed) return { errors: { _form: [earlyTransition.reason] } }

  // Lock SellerSubmission row then re-validate inside transaction. Serializes against
  // concurrent pricing-preference saves and intake conversions that lock the same row.
  const txResult = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${agreement.submissionId} FOR UPDATE`
    const fresh = await tx.sellerAgreement.findUnique({
      where: { id: agreementId },
      select: { status: true },
    })
    if (!fresh) return { errors: { _form: ['Agreement not found'] } }
    const transition = canTransitionStatus(fresh.status, 'accepted')
    if (!transition.allowed) return { errors: { _form: [transition.reason] } }
    await tx.sellerAgreement.update({
      where: { id: agreementId },
      data: { status: 'accepted', acceptedAt: new Date(), acceptanceMethod },
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
