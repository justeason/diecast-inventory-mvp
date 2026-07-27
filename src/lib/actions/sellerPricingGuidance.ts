'use server'

import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { fetchComparableSales } from '@/lib/resaleEstimatorQuery'
import { computeEstimate, type TargetModel } from '@/lib/resaleEstimator'
import {
  computeGuidance,
  isSubmissionPricingLocked,
  VALID_STRATEGIES,
  type PricingStrategy,
} from '@/lib/sellerPricingGuidance'

export type PricingGuidanceActionState = { errors: Record<string, string[]> } | null

export async function saveSellerPricingPreference(
  submissionId: string,
  _prev: PricingGuidanceActionState,
  formData: FormData,
): Promise<PricingGuidanceActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in.'] } }
  }

  const submission = await prisma.sellerSubmission.findFirst({
    where: { id: submissionId, profileId: session.profileId },
    select: {
      id: true,
      catalogId: true,
      brand: true,
      name: true,
      series: true,
      year: true,
      agreements: { select: { id: true, type: true, status: true, commissionPercent: true, fixedFee: true, minimumSellerPayout: true } },
      intakeDrafts: { select: { convertedItemId: true } },
    },
  })
  if (!submission) {
    return { errors: { form: ['Submission not found.'] } }
  }

  // Eager pre-check (fast path for obvious locked state before estimator work)
  if (isSubmissionPricingLocked({ agreements: submission.agreements, intakeDrafts: submission.intakeDrafts })) {
    return { errors: { form: ['Pricing preference cannot be updated after the agreement is accepted or inventory has been converted.'] } }
  }

  const rawStrategy = formData.get('strategy')?.toString() ?? ''
  if (!VALID_STRATEGIES.includes(rawStrategy as PricingStrategy)) {
    return { errors: { strategy: ['Select a valid pricing strategy.'] } }
  }
  const strategy = rawStrategy as PricingStrategy

  let customTargetCents: number | null = null
  if (strategy === 'custom') {
    const raw = formData.get('customTarget')?.toString() ?? ''
    const parsed = parseFloat(raw)
    if (!isFinite(parsed) || parsed <= 0) {
      return { errors: { customTarget: ['Enter a positive price greater than zero.'] } }
    }
    customTargetCents = Math.round(parsed * 100)
  }

  // Re-run estimator server-side — browser values are ignored entirely
  const targetModel: TargetModel = {
    id: submission.catalogId ?? '__unlinked__',
    brand: submission.brand ?? '',
    name: submission.name ?? '',
    series: submission.series ?? null,
    year: submission.year ?? null,
  }
  const comparables = await fetchComparableSales(targetModel)
  const estimateResult = computeEstimate(targetModel, comparables)

  const activeAgreement =
    submission.agreements.find((a) => a.status === 'proposed' || a.status === 'accepted') ?? null
  const consignmentTerms =
    activeAgreement?.type === 'consignment'
      ? {
          commissionPercent: activeAgreement.commissionPercent,
          fixedFee: activeAgreement.fixedFee,
          minimumSellerPayout: activeAgreement.minimumSellerPayout,
        }
      : null

  const guidance = computeGuidance({ strategy, customTargetCents, estimateResult, consignmentTerms })

  if (guidance.targetPriceCents === null) {
    return {
      errors: { strategy: ['Not enough sales data for this strategy. Please enter a custom target price.'] },
    }
  }

  const toDecimal = (cents: number | null) =>
    cents !== null ? new Prisma.Decimal(cents / 100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) : null

  const selectedTargetPrice = toDecimal(guidance.targetPriceCents)!
  const customDesiredPrice = strategy === 'custom' ? toDecimal(customTargetCents) : null
  const suggestedFastPrice = toDecimal(estimateResult.lowPrice)
  const suggestedMaxPrice = toDecimal(estimateResult.highPrice)
  const estimatedSellerProceeds = toDecimal(guidance.estimatedSellerProceedsCents)
  const capturedAt = new Date()

  // Row-locked transaction: acquires FOR UPDATE on SellerSubmission so any concurrent
  // agreement acceptance or inventory conversion that also locks the same row must
  // complete before this re-read. Under serializable-equivalent ordering, if acceptance
  // or conversion commits first we see the new state; if we commit first, they wait and
  // then proceed with the pricing preference already saved.
  const txResult = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionId} FOR UPDATE`
    const fresh = await tx.sellerSubmission.findFirst({
      where: { id: submissionId, profileId: session.profileId },
      select: {
        agreements: { select: { status: true } },
        intakeDrafts: { select: { convertedItemId: true } },
      },
    })
    if (!fresh || isSubmissionPricingLocked({ agreements: fresh.agreements, intakeDrafts: fresh.intakeDrafts })) {
      return 'locked' as const
    }
    await tx.sellerPricingPreference.upsert({
      where: { sellerSubmissionId: submissionId },
      create: {
        sellerSubmissionId: submissionId,
        strategy,
        selectedTargetPrice,
        customDesiredPrice,
        suggestedFastPrice,
        suggestedMaxPrice,
        estimatedDaysToSell: guidance.estimatedDaysToSell,
        estimatedSellerProceeds,
        confidence: guidance.confidence,
        matchLevel: guidance.matchLevel,
        comparableCount: guidance.comparableCount,
        capturedAt,
      },
      update: {
        strategy,
        selectedTargetPrice,
        customDesiredPrice,
        suggestedFastPrice,
        suggestedMaxPrice,
        estimatedDaysToSell: guidance.estimatedDaysToSell,
        estimatedSellerProceeds,
        confidence: guidance.confidence,
        matchLevel: guidance.matchLevel,
        comparableCount: guidance.comparableCount,
        capturedAt,
      },
    })
    return 'ok' as const
  })

  if (txResult === 'locked') {
    return { errors: { form: ['Pricing preference cannot be updated after the agreement is accepted or inventory has been converted.'] } }
  }

  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath('/account/sell')
  return null
}
