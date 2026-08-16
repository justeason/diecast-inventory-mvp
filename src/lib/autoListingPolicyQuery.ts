// 15K: DB boundary for the auto-listing policy config. Read-only — publishing a new
// version lives in actions/autoListingPolicy.ts. Same effective-version resolution
// shape as 15F's riskPolicyQuery.ts: the effective row at `asOf` is the one with the
// greatest effectiveFrom <= asOf; versions are never mutated, only superseded.
import { prisma } from '@/lib/prisma'
import type { AutoListingPolicySnapshot, AutoListMinConfidence } from '@/lib/autoListingPolicy'

export type AutoListingPolicyRow = AutoListingPolicySnapshot & {
  id: string
  notes: string | null
  createdBy: string
  createdAt: Date
}

const POLICY_SELECT = {
  id: true, version: true, effectiveFrom: true, enabled: true,
  minimumPricingConfidence: true, pricePositionBps: true,
  notes: true, createdBy: true, createdAt: true,
} as const

function toSnapshot(row: {
  version: number; effectiveFrom: Date; enabled: boolean
  minimumPricingConfidence: string; pricePositionBps: number
}): AutoListingPolicySnapshot {
  return {
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    enabled: row.enabled,
    minimumPricingConfidence: row.minimumPricingConfidence as AutoListMinConfidence,
    pricePositionBps: row.pricePositionBps,
  }
}

// The 15K migration seeds version 1 with enabled=false (Part C section 5 — safe
// default), so this should never return null in practice; still handled explicitly
// rather than assumed, same posture as 15F's getEffectiveRiskPolicy.
export async function getEffectiveAutoListingPolicy(asOf: Date = new Date()): Promise<AutoListingPolicyRow | null> {
  const row = await prisma.autoListingPolicyConfig.findFirst({
    where: { effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: 'desc' },
    select: POLICY_SELECT,
  })
  if (!row) return null
  return { ...toSnapshot(row), id: row.id, notes: row.notes, createdBy: row.createdBy, createdAt: row.createdAt }
}

// Bounded — an admin-curated handful of versions, never an unbounded log.
export async function listAutoListingPolicyVersions(limit: number = 50): Promise<AutoListingPolicyRow[]> {
  const rows = await prisma.autoListingPolicyConfig.findMany({ orderBy: { version: 'desc' }, take: limit, select: POLICY_SELECT })
  return rows.map((row) => ({ ...toSnapshot(row), id: row.id, notes: row.notes, createdBy: row.createdBy, createdAt: row.createdAt }))
}
