import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: vi.fn() } }))
vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { createRiskPolicyVersionAction } from '@/lib/actions/riskPolicies'

function makeTx(latest: { version: number; effectiveFrom: Date } | null) {
  const create = vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ ...args.data, id: 'new-policy' }))
  return {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    riskPolicyConfig: { findFirst: vi.fn().mockResolvedValue(latest), create },
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function baseFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  const defaults: Record<string, string> = {
    highValueReviewThreshold: '200',
    veryHighValueThreshold: '1000',
    payoutApprovalThreshold: '1000',
    priceDeviationTolerancePercent: '15',
    destructiveActionsRequireApproval: 'on',
    commercialOverridesRequireApproval: 'on',
  }
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) fd.set(k, v)
  return fd
}

describe('createRiskPolicyVersionAction (section 12/13/40)', () => {
  beforeEach(() => { vi.resetAllMocks(); (isAdminAuthenticated as Mock).mockResolvedValue(true) })

  it('creates version 1 when no prior policy exists', async () => {
    const tx = makeTx(null)
    mockTransaction(tx)
    const result = await createRiskPolicyVersionAction(null, baseFormData())
    expect(result).toBeNull()
    expect(tx.riskPolicyConfig.create).toHaveBeenCalledTimes(1)
    expect((tx.riskPolicyConfig.create as Mock).mock.calls[0][0].data.version).toBe(1)
  })

  it('auto-increments the version number from the latest', async () => {
    const tx = makeTx({ version: 7, effectiveFrom: new Date('2020-01-01') })
    mockTransaction(tx)
    await createRiskPolicyVersionAction(null, baseFormData())
    expect((tx.riskPolicyConfig.create as Mock).mock.calls[0][0].data.version).toBe(8)
  })

  it('converts dollar inputs to integer cents, never floats', async () => {
    const tx = makeTx(null)
    mockTransaction(tx)
    await createRiskPolicyVersionAction(null, baseFormData({ highValueReviewThreshold: '199.99' }))
    const data = (tx.riskPolicyConfig.create as Mock).mock.calls[0][0].data
    expect(data.highValueReviewThresholdCents).toBe(19_999)
    expect(Number.isInteger(data.highValueReviewThresholdCents)).toBe(true)
  })

  it('converts the tolerance percent to integer bps', async () => {
    const tx = makeTx(null)
    mockTransaction(tx)
    await createRiskPolicyVersionAction(null, baseFormData({ priceDeviationTolerancePercent: '12.5' }))
    const data = (tx.riskPolicyConfig.create as Mock).mock.calls[0][0].data
    expect(data.priceDeviationToleranceBps).toBe(1250)
  })

  it('rejects a negative threshold', async () => {
    const result = await createRiskPolicyVersionAction(null, baseFormData({ highValueReviewThreshold: '-5' }))
    expect(result?.errors?.highValueReviewThreshold).toBeTruthy()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a tolerance percent outside 0-100', async () => {
    const result = await createRiskPolicyVersionAction(null, baseFormData({ priceDeviationTolerancePercent: '150' }))
    expect(result?.errors?.priceDeviationTolerancePercent).toBeTruthy()
  })

  it('rejects veryHighValueThreshold below highValueReviewThreshold — no ambiguous ordering', async () => {
    const result = await createRiskPolicyVersionAction(null, baseFormData({ highValueReviewThreshold: '1000', veryHighValueThreshold: '500' }))
    expect(result?.errors?.veryHighValueThreshold).toBeTruthy()
  })

  it('rejects a new version dated at or before the currently active version (no ambiguous active version)', async () => {
    const latestEffective = new Date('2026-06-01T00:00:00Z')
    const tx = makeTx({ version: 2, effectiveFrom: latestEffective })
    mockTransaction(tx)
    const result = await createRiskPolicyVersionAction(null, baseFormData({ effectiveFrom: '2026-05-01T00:00:00' }))
    expect(result?.errors?._form?.[0]).toMatch(/ambiguous/)
    expect(tx.riskPolicyConfig.create).not.toHaveBeenCalled()
  })

  it('admin authentication is required', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    const result = await createRiskPolicyVersionAction(null, baseFormData())
    expect(result?.errors?._form).toBeTruthy()
  })

  it('createdBy is honestly "admin" — no fabricated per-admin identity', async () => {
    const tx = makeTx(null)
    mockTransaction(tx)
    await createRiskPolicyVersionAction(null, baseFormData())
    expect((tx.riskPolicyConfig.create as Mock).mock.calls[0][0].data.createdBy).toBe('admin')
  })
})
