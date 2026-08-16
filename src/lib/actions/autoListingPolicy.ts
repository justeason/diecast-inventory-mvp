'use server'

// 15K: admin configuration for the auto-listing policy (src/lib/autoListingPolicy.ts).
// Every save creates a NEW versioned, effective-dated row — existing versions are
// never mutated (same discipline as 15F's actions/riskPolicies.ts), so a completed
// AutoListingRun's policyVersion snapshot always stays interpretable.
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { isValidAutoListMinConfidence, isValidPricePositionBps } from '@/lib/autoListingPolicy'

export type AutoListingPolicyActionState = { errors?: Record<string, string[]> } | null

export async function publishAutoListingPolicyVersionAction(
  _prev: AutoListingPolicyActionState,
  formData: FormData,
): Promise<AutoListingPolicyActionState> {
  if (!(await isAdminAuthenticated())) return { errors: { _form: ['Unauthorized'] } }

  const errors: Record<string, string[]> = {}

  const minimumPricingConfidence = String(formData.get('minimumPricingConfidence') ?? '')
  if (!isValidAutoListMinConfidence(minimumPricingConfidence)) {
    errors.minimumPricingConfidence = ['Must be "medium" or "high" — low/insufficient confidence can never auto-list.']
  }

  const bpsRaw = formData.get('pricePositionBps') as string | null
  const bpsN = bpsRaw ? Number(bpsRaw) : NaN
  if (!Number.isFinite(bpsN) || !isValidPricePositionBps(bpsN)) {
    errors.pricePositionBps = ['Must be an integer between 0 (recommended low) and 10000 (recommended high).']
  }

  if (Object.keys(errors).length > 0) return { errors }

  const enabled = formData.get('enabled') === 'on'
  const notes = (formData.get('notes') as string | null)?.trim() || null

  const effectiveFromRaw = String(formData.get('effectiveFrom') ?? '')
  const effectiveFrom = effectiveFromRaw ? new Date(effectiveFromRaw) : new Date()
  if (Number.isNaN(effectiveFrom.getTime())) {
    return { errors: { effectiveFrom: ['A valid effective-from date/time is required.'] } }
  }

  const result = await prisma.$transaction(async (tx) => {
    // Same advisory-lock pattern as 15F's risk-policy version sequence — two
    // concurrent publishes can never collide on the same version number or create
    // an out-of-order effectiveFrom that would make "the" active version ambiguous.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('auto_listing_policy_version_seq')::bigint)`
    const latest = await tx.autoListingPolicyConfig.findFirst({ orderBy: { version: 'desc' }, select: { version: true, effectiveFrom: true } })
    if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
      return { ok: false as const, error: 'New policy version must take effect after the currently active version — this would otherwise create an ambiguous active version.' }
    }
    const created = await tx.autoListingPolicyConfig.create({
      data: {
        version: (latest?.version ?? 0) + 1,
        effectiveFrom,
        enabled,
        minimumPricingConfidence,
        pricePositionBps: bpsN,
        notes,
        createdBy: 'admin',
      },
    })
    return { ok: true as const, version: created.version }
  })

  if (!result.ok) return { errors: { _form: [result.error] } }

  revalidatePath('/admin/auto-listing')
  return null
}
