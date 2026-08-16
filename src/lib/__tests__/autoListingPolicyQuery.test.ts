import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { autoListingPolicyConfig: { findFirst: vi.fn(), findMany: vi.fn() } },
}))

import { prisma } from '@/lib/prisma'
import { getEffectiveAutoListingPolicy, listAutoListingPolicyVersions } from '@/lib/autoListingPolicyQuery'

beforeEach(() => vi.resetAllMocks())

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1', version: 1, effectiveFrom: new Date('2026-01-01'), enabled: false,
    minimumPricingConfidence: 'high', pricePositionBps: 5000,
    notes: null, createdBy: 'admin', createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

describe('getEffectiveAutoListingPolicy', () => {
  it('returns null (never throws) when no version exists yet', async () => {
    ;(prisma.autoListingPolicyConfig.findFirst as Mock).mockResolvedValue(null)
    expect(await getEffectiveAutoListingPolicy()).toBeNull()
  })

  it('resolves the greatest effectiveFrom <= asOf, never a future version', async () => {
    ;(prisma.autoListingPolicyConfig.findFirst as Mock).mockResolvedValue(row({ version: 3, enabled: true }))
    const result = await getEffectiveAutoListingPolicy(new Date('2026-06-01'))
    expect(result?.version).toBe(3)
    expect(result?.enabled).toBe(true)
    const call = (prisma.autoListingPolicyConfig.findFirst as Mock).mock.calls[0][0]
    expect(call.where.effectiveFrom.lte).toEqual(new Date('2026-06-01'))
    expect(call.orderBy.effectiveFrom).toBe('desc')
  })
})

describe('listAutoListingPolicyVersions', () => {
  it('is bounded (default limit passed through) and ordered newest-first', async () => {
    ;(prisma.autoListingPolicyConfig.findMany as Mock).mockResolvedValue([row({ version: 2 }), row({ version: 1 })])
    const versions = await listAutoListingPolicyVersions()
    expect(versions.map((v) => v.version)).toEqual([2, 1])
    const call = (prisma.autoListingPolicyConfig.findMany as Mock).mock.calls[0][0]
    expect(call.orderBy.version).toBe('desc')
    expect(call.take).toBe(50)
  })
})
