'use server'

import { redirect } from 'next/navigation'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { validateAgreementDraft, canTransitionStatus } from '@/lib/sellerAgreementValidation'

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

  const transition = canTransitionStatus(agreement.status, 'accepted')
  if (!transition.allowed) return { errors: { _form: [transition.reason] } }

  await prisma.sellerAgreement.update({
    where: { id: agreementId },
    data: { status: 'accepted', acceptedAt: new Date(), acceptanceMethod },
  })

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
    select: { id: true, status: true, submissionId: true },
  })
  if (!agreement) return { errors: { _form: ['Agreement not found'] } }

  const transition = canTransitionStatus(agreement.status, 'cancelled')
  if (!transition.allowed) return { errors: { _form: [transition.reason] } }

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

  redirect(`/admin/seller-submissions/${agreement.submissionId}/agreement`)
}
