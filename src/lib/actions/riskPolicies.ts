'use server'

// 15F: admin configuration for the risk policy engine (src/lib/riskPolicy.ts). Every
// change creates a NEW versioned, effective-dated row — existing versions are never
// mutated, so an approval request created under version N always stays interpretable
// against that exact snapshot (see actions/riskApprovals.ts).
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'

export type RiskPolicyActionState = { errors?: Record<string, string[]> } | null

function parseNonNegativeCents(raw: string | null, field: string, errors: Record<string, string[]>): number | null {
  const n = raw ? parseFloat(raw) : NaN
  if (!Number.isFinite(n) || n < 0) {
    errors[field] = ['Must be a non-negative amount.']
    return null
  }
  return Math.round(n * 100)
}

export async function createRiskPolicyVersionAction(
  _prev: RiskPolicyActionState,
  formData: FormData,
): Promise<RiskPolicyActionState> {
  if (!(await isAdminAuthenticated())) return { errors: { _form: ['Unauthorized'] } }

  const errors: Record<string, string[]> = {}
  const highValueReviewThresholdCents = parseNonNegativeCents(formData.get('highValueReviewThreshold') as string | null, 'highValueReviewThreshold', errors)
  const veryHighValueThresholdCents = parseNonNegativeCents(formData.get('veryHighValueThreshold') as string | null, 'veryHighValueThreshold', errors)
  const payoutApprovalThresholdCents = parseNonNegativeCents(formData.get('payoutApprovalThreshold') as string | null, 'payoutApprovalThreshold', errors)

  const toleranceRaw = formData.get('priceDeviationTolerancePercent') as string | null
  const toleranceN = toleranceRaw ? parseFloat(toleranceRaw) : NaN
  let priceDeviationToleranceBps: number | null = null
  if (!Number.isFinite(toleranceN) || toleranceN < 0 || toleranceN > 100) {
    errors.priceDeviationTolerancePercent = ['Must be a percentage between 0 and 100.']
  } else {
    priceDeviationToleranceBps = Math.round(toleranceN * 100)
  }

  if (
    highValueReviewThresholdCents != null &&
    veryHighValueThresholdCents != null &&
    veryHighValueThresholdCents < highValueReviewThresholdCents
  ) {
    errors.veryHighValueThreshold = ['Very-high-value threshold must be >= the high-value review threshold.']
  }

  if (Object.keys(errors).length > 0) return { errors }

  const destructiveActionsRequireApproval = formData.get('destructiveActionsRequireApproval') === 'on'
  const commercialOverridesRequireApproval = formData.get('commercialOverridesRequireApproval') === 'on'
  const notes = (formData.get('notes') as string | null)?.trim() || null

  const effectiveFromRaw = String(formData.get('effectiveFrom') ?? '')
  const effectiveFrom = effectiveFromRaw ? new Date(effectiveFromRaw) : new Date()
  if (Number.isNaN(effectiveFrom.getTime())) {
    return { errors: { effectiveFrom: ['A valid effective-from date/time is required.'] } }
  }

  const result = await prisma.$transaction(async (tx) => {
    // Advisory-lock the single-row "next version" sequence so two concurrent policy
    // saves can never pick the same version number or create two versions with
    // out-of-order effectiveFrom (which would make "the" active version ambiguous).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('risk_policy_version_seq')::bigint)`
    const latest = await tx.riskPolicyConfig.findFirst({ orderBy: { version: 'desc' }, select: { version: true, effectiveFrom: true } })
    if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
      return { ok: false as const, error: 'New policy version must take effect after the currently active version — this would otherwise create an ambiguous active version.' }
    }
    const created = await tx.riskPolicyConfig.create({
      data: {
        version: (latest?.version ?? 0) + 1,
        effectiveFrom,
        highValueReviewThresholdCents: highValueReviewThresholdCents!,
        veryHighValueThresholdCents: veryHighValueThresholdCents!,
        payoutApprovalThresholdCents: payoutApprovalThresholdCents!,
        priceDeviationToleranceBps: priceDeviationToleranceBps!,
        destructiveActionsRequireApproval,
        commercialOverridesRequireApproval,
        notes,
        createdBy: 'admin',
      },
    })
    return { ok: true as const, version: created.version }
  })

  if (!result.ok) return { errors: { _form: [result.error] } }

  revalidatePath('/admin/risk-policies')
  return null
}
