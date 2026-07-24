'use server'

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

const VALID_SALE_TYPE_PREFS = ['consignment', 'buyout', 'unsure'] as const
const VALID_CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'] as const
const ACTIVE_STATUSES = ['submitted', 'under_review', 'needs_info'] as const
const WITHDRAWABLE_STATUSES = ['submitted', 'needs_info'] as const
const ADMIN_ALLOWED_STATUSES = ['submitted', 'under_review', 'needs_info', 'approved_for_intake', 'declined'] as const
const REVIEWED_STATUSES = new Set(['under_review', 'needs_info', 'approved_for_intake', 'declined'])

export type SellerSubmissionActionState = { errors: Record<string, string[]> } | null

function trimOrNull(v: string | undefined | null): string | null {
  const t = v?.trim()
  return t || null
}

export async function submitCollectionItemForSale(
  collectionItemId: string,
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in to submit a sell request.'] } }
  }

  const item = await prisma.collectionItem.findFirst({
    where: { id: collectionItemId, profileId: session.profileId },
    select: {
      id: true,
      brand: true,
      name: true,
      series: true,
      year: true,
      color: true,
      scale: true,
      cardedOrLoose: true,
      condition: true,
      conditionNotes: true,
      quantity: true,
      catalogId: true,
    },
  })
  if (!item) {
    return { errors: { form: ['Collection item not found.'] } }
  }

  const existingActive = await prisma.sellerSubmission.findFirst({
    where: {
      collectionItemId: item.id,
      profileId: session.profileId,
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { id: true },
  })
  if (existingActive) {
    return { errors: { form: ['You already have an active sell request for this item.'] } }
  }

  const rawSaleType = formData.get('saleTypePreference')?.toString().trim() ?? ''
  const rawExpectedPrice = formData.get('expectedPrice')?.toString().trim() ?? ''
  const rawQuantity = formData.get('quantity')?.toString().trim() ?? ''
  const rawCondition = trimOrNull(formData.get('condition')?.toString())
  const rawConditionNotes = trimOrNull(formData.get('conditionNotes')?.toString())
  const rawUserNotes = trimOrNull(formData.get('userNotes')?.toString())

  if (!rawSaleType || !(VALID_SALE_TYPE_PREFS as readonly string[]).includes(rawSaleType)) {
    return { errors: { saleTypePreference: ['Please select how you would like to sell.'] } }
  }

  let expectedPrice: number | null = null
  if (rawExpectedPrice) {
    const n = parseFloat(rawExpectedPrice)
    if (!Number.isFinite(n) || n < 0) {
      return { errors: { expectedPrice: ['Expected price must be 0 or more.'] } }
    }
    expectedPrice = n
  }

  let quantity = item.quantity
  if (rawQuantity) {
    const n = parseInt(rawQuantity, 10)
    if (isNaN(n) || n < 1) {
      return { errors: { quantity: ['Quantity must be 1 or more.'] } }
    }
    if (n > item.quantity) {
      return {
        errors: {
          quantity: [`Quantity cannot exceed your collection quantity of ${item.quantity}.`],
        },
      }
    }
    quantity = n
  }

  if (rawCondition && !(VALID_CONDITIONS as readonly string[]).includes(rawCondition)) {
    return { errors: { condition: ['Invalid condition value.'] } }
  }

  if (rawConditionNotes && rawConditionNotes.length > 500) {
    return { errors: { conditionNotes: ['Condition notes must be 500 characters or fewer.'] } }
  }

  if (rawUserNotes && rawUserNotes.length > 1000) {
    return { errors: { userNotes: ['Notes must be 1000 characters or fewer.'] } }
  }

  await prisma.sellerSubmission.create({
    data: {
      profileId: session.profileId,
      collectionItemId: item.id,
      catalogId: item.catalogId ?? null,
      brand: item.brand,
      name: item.name,
      series: item.series,
      year: item.year,
      color: item.color,
      scale: item.scale,
      cardedOrLoose: item.cardedOrLoose,
      condition: rawCondition ?? item.condition,
      conditionNotes: rawConditionNotes ?? item.conditionNotes,
      quantity,
      saleTypePreference: rawSaleType,
      expectedPrice,
      userNotes: rawUserNotes,
    },
  })

  revalidatePath('/account/sell')
  revalidatePath('/account/collection')
  revalidatePath(`/account/collection/${collectionItemId}`)
  redirect('/account/sell')
}

export async function updateSellerSubmissionStatus(
  submissionId: string,
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  // Admin suggestion actions rely on the (admin) route group middleware for auth,
  // consistent with all other admin server actions in this repo.
  const rawStatus = formData.get('status')?.toString().trim() ?? ''
  const rawAdminNotes = formData.get('adminNotes')?.toString() ?? ''
  const rawUserMessage = formData.get('userMessage')?.toString() ?? ''

  if (!(ADMIN_ALLOWED_STATUSES as readonly string[]).includes(rawStatus)) {
    return { errors: { status: ['Invalid status.'] } }
  }

  const userMessage = rawUserMessage.trim() || null
  if ((rawStatus === 'needs_info' || rawStatus === 'declined') && !userMessage) {
    return { errors: { userMessage: ['A message to the seller is required for this status.'] } }
  }
  if (userMessage && userMessage.length > 1000) {
    return { errors: { userMessage: ['Message must be 1000 characters or fewer.'] } }
  }

  const adminNotes = rawAdminNotes.trim() || null
  if (adminNotes && adminNotes.length > 2000) {
    return { errors: { adminNotes: ['Admin notes must be 2000 characters or fewer.'] } }
  }

  const submission = await prisma.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, status: true, collectionItemId: true },
  })
  if (!submission) return { errors: { form: ['Sell request not found.'] } }

  await prisma.sellerSubmission.update({
    where: { id: submission.id },
    data: {
      status: rawStatus,
      adminNotes,
      userMessage,
      ...(REVIEWED_STATUSES.has(rawStatus) ? { reviewedAt: new Date() } : {}),
    },
  })

  revalidatePath('/admin/seller-submissions')
  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  revalidatePath('/account/sell')
  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath('/account/collection')
  if (submission.collectionItemId) {
    revalidatePath(`/account/collection/${submission.collectionItemId}`)
  }
  redirect(`/admin/seller-submissions/${submissionId}`)
}

export async function withdrawSellerSubmission(
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in.'] } }
  }

  const submissionId = formData.get('submissionId')?.toString().trim() ?? ''
  if (!submissionId) {
    return { errors: { form: ['Sell request not found.'] } }
  }

  const submission = await prisma.sellerSubmission.findFirst({
    where: { id: submissionId, profileId: session.profileId },
    select: { id: true, status: true, collectionItemId: true },
  })
  if (!submission) {
    return { errors: { form: ['Sell request not found.'] } }
  }

  if (!(WITHDRAWABLE_STATUSES as readonly string[]).includes(submission.status)) {
    return { errors: { form: ['This sell request can no longer be withdrawn.'] } }
  }

  await prisma.sellerSubmission.update({
    where: { id: submission.id },
    data: { status: 'withdrawn' },
  })

  revalidatePath('/account/sell')
  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath('/account/collection')
  if (submission.collectionItemId) {
    revalidatePath(`/account/collection/${submission.collectionItemId}`)
  }
  redirect(`/account/sell/${submissionId}`)
}
